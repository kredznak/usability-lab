import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Capture, type CapturedElement } from "./types.js";
import { diffCaptures, isDated, isQuiet, shape } from "./capture-diff.js";

/**
 * Capture diffs — the deterministic half of change monitoring.
 *
 * B15 measured the other half: the same page audited three times produces
 * 14/12/15 findings, and a finding diff on an unchanged page reports 2-5 fixed
 * and 2-5 new. Three captures each of basecamp, cotopaxi and linear/pricing,
 * minutes apart, produced identical text, titles, heights and element
 * multisets. This suite exists to keep that difference true.
 */

const base = Capture.parse(JSON.parse(readFileSync("fixtures/captures/signup.json", "utf8")));

function el(over: Partial<CapturedElement>): CapturedElement {
  return {
    ref: "el_x", tag: "a", role: null, text: "", bbox: { x: 0, y: 0, width: 10, height: 10 },
    above_fold: true, input_type: null, accessible_name: null, name_source: null, font_size: 16,
    ...over,
  };
}

const withElements = (elements: CapturedElement[], over: Partial<Capture> = {}): Capture =>
  Capture.parse({ ...base, elements, elements_total: elements.length, ...over });

describe("an unchanged page is quiet", () => {
  test("a capture against itself reports nothing", () => {
    const d = diffCaptures(base, base);
    assert.ok(isQuiet(d));
    assert.deepEqual(d.partial, []);
  });
});

describe("what a visitor can act on is the headline", () => {
  test("a call to action that disappeared is reported", () => {
    // basecamp really did lose "Try Basecamp free" between 11 and 17 August,
    // and it arrived in the same undifferentiated list as seven rolling class
    // dates. Surfacing this is the entire point of the feature.
    const before = withElements([el({ text: "Try Basecamp free" }), el({ text: "Pricing" })]);
    const after = withElements([el({ text: "Pricing" })]);
    const d = diffCaptures(before, after);
    assert.deepEqual(
      d.interactive.removed.map((i) => i.label),
      ["try basecamp free"],
    );
    assert.equal(d.interactive.added.length, 0);
    assert.equal(isQuiet(d), false);
  });

  test("a form that gained a field says so", () => {
    const before = withElements([el({ tag: "input", input_type: "email", accessible_name: "Email" })]);
    const after = withElements([
      el({ tag: "input", input_type: "email", accessible_name: "Email" }),
      el({ tag: "input", input_type: "tel", accessible_name: "Phone" }),
    ]);
    const d = diffCaptures(before, after);
    assert.deepEqual(
      d.fields.added.map((i) => `${i.tag} ${i.label}`),
      ["input[tel] phone"],
    );
  });
});

describe("a list that rolls forward is not a page that changed", () => {
  test("dated entries collapse into one grouped line", () => {
    const before = withElements([
      el({ text: "Aug 12 Intro to Basecamp Wed, Aug 12, 8:00am" }),
      el({ text: "Aug 13 Intro to Basecamp Thu, Aug 13, 1:00pm" }),
    ]);
    const after = withElements([
      el({ text: "Aug 19 Intro to Basecamp Wed, Aug 19, 8:00am" }),
      el({ text: "Aug 26 Intro to Basecamp Wed, Aug 26, 8:00am" }),
    ]);
    const d = diffCaptures(before, after);
    assert.equal(d.interactive.added.length, 0, "a rotation is not an addition");
    assert.equal(d.interactive.removed.length, 0, "a rotation is not a removal");
    assert.equal(d.rotated.length, 1);
    assert.equal(d.rotated[0]!.removed, 2);
    assert.equal(d.rotated[0]!.added, 2);
    assert.ok(isQuiet(d), "a rotating list on its own is not news");
  });

  /**
   * The rule that makes rotation detection safe. The tempting version blurs
   * every number, and a pricing page is exactly where that would cost the most:
   * "$99" becoming "$129" is the single change this feature most needs to
   * catch.
   */
  test("a price change is never mistaken for a rotation", () => {
    const before = withElements([el({ text: "Spend $99.00 more for free shipping" })]);
    const after = withElements([el({ text: "Spend $129.00 more for free shipping" })]);
    const d = diffCaptures(before, after);
    assert.equal(d.rotated.length, 0, "no month or weekday here, so no digits may be blurred");
    assert.equal(d.interactive.added.length, 1);
    assert.equal(d.interactive.removed.length, 1);
    assert.equal(isQuiet(d), false);
  });

  test("shape leaves undated text completely alone", () => {
    assert.equal(shape("Spend $99.00 more"), "Spend $99.00 more");
    assert.equal(shape("3 seats left"), "3 seats left");
  });

  test("shape does not rewrite its own placeholders", () => {
    // "month" starts with "mon", so a naive weekday pass turns "<month>" into
    // "<<day>>" and two identical dates stop matching each other.
    const s = shape("aug 12 intro wed, aug 12, 8:00am");
    assert.doesNotMatch(s, /<<|>>/);
    assert.equal(s, shape("dec 30 intro mon, dec 30, 9:00pm"));
  });

  test("a list that shrank is still reported, not hidden by the grouping", () => {
    const before = withElements([
      el({ text: "Aug 12 Intro Wed, Aug 12, 8:00am" }),
      el({ text: "Aug 13 Intro Thu, Aug 13, 8:00am" }),
      el({ text: "Aug 14 Intro Fri, Aug 14, 8:00am" }),
    ]);
    const after = withElements([el({ text: "Aug 19 Intro Wed, Aug 19, 8:00am" })]);
    const d = diffCaptures(before, after);
    assert.equal(d.rotated[0]!.removed, 3);
    assert.equal(d.rotated[0]!.added, 1);
  });
});

describe("a truncated capture cannot claim a removal", () => {
  /**
   * B8's lesson, in a new place. basecamp's page text was cut at 4000 of 6753
   * characters and a reviewer read the silence as absence — rank 1, high
   * confidence, false. An element list that hit its budget can drop an item
   * that is still on the page, and cotopaxi's capture samples 82 of 97 every
   * time.
   */
  test("hitting the element budget is disclosed on either side", () => {
    const before = withElements([el({ text: "Checkout" })], { elements_total: 97 });
    const after = withElements([el({ text: "Checkout" })]);
    assert.equal(diffCaptures(before, after).partial.length, 1);
    assert.equal(diffCaptures(after, before).partial.length, 1);
    assert.equal(diffCaptures(after, after).partial.length, 0);
  });

  test("the disclosure names which side and by how much", () => {
    const before = withElements([el({ text: "Checkout" })], { elements_total: 97 });
    const [reason] = diffCaptures(before, before).partial;
    assert.match(reason!, /1 of 97/);
    assert.match(reason!, /without being absent from the page/);
  });
});

describe("elements are compared as a multiset, because refs are positional", () => {
  test("duplicate labels are counted, not deduplicated", () => {
    // Three "Learn more" links becoming two is a real change; a set-based diff
    // reports nothing at all.
    const before = withElements([
      el({ text: "Learn more" }), el({ text: "Learn more" }), el({ text: "Learn more" }),
    ]);
    const after = withElements([el({ text: "Learn more" }), el({ text: "Learn more" })]);
    const d = diffCaptures(before, after);
    assert.equal(d.interactive.removed.length, 1);
    assert.equal(d.interactive.added.length, 0);
  });

  test("reordering a page is not a change to it", () => {
    const before = withElements([el({ text: "Pricing" }), el({ text: "Docs" })]);
    const after = withElements([el({ text: "Docs" }), el({ text: "Pricing" })]);
    assert.ok(isQuiet(diffCaptures(before, after)));
  });
});

/**
 * A date going past is not a page changing.
 *
 * basecamp twice triggered a ~$0.55 audit because one live-class link expired
 * with nothing replacing it. Grouped rotation needs a matching shape on both
 * sides, so a one-way expiry fell through as an ordinary removal — and a daily
 * scheduler would have billed an audit a day on any site with a calendar.
 */
describe("a dated item expiring on its own is not news", () => {
  test("the exact case that billed twice", () => {
    const before = withElements([
      el({ text: "Aug 17 Intro to Basecamp Mon, Aug 17, 1:00pm" }),
      el({ text: "Try Basecamp free" }),
    ]);
    const after = withElements([el({ text: "Try Basecamp free" })]);
    const d = diffCaptures(before, after);
    assert.equal(d.interactive.removed.length, 1, "it is still reported");
    assert.ok(isQuiet(d), "but it must not spend money on its own");
  });

  test("a real removal alongside an expiry is still loud", () => {
    // The whole risk of this rule is that it quiets a page that did change.
    // An expiry must never provide cover for the CTA disappearing with it.
    const before = withElements([
      el({ text: "Aug 17 Intro to Basecamp Mon, Aug 17, 1:00pm" }),
      el({ text: "Try Basecamp free" }),
    ]);
    const after = withElements([]);
    assert.equal(isQuiet(diffCaptures(before, after)), false);
  });

  test("a price is never treated as a date", () => {
    const before = withElements([el({ text: "Spend $99.00 more for free shipping" })]);
    const after = withElements([]);
    assert.equal(isQuiet(diffCaptures(before, after)), false);
  });

  test("a form field is never quieted, whatever its label says", () => {
    // A signup form losing a field is the most consequential thing this can
    // detect, and a field labelled "Date of birth" must not buy silence.
    const before = withElements([
      el({ tag: "input", input_type: "date", accessible_name: "Date of birth Aug" }),
    ]);
    const after = withElements([]);
    assert.equal(isQuiet(diffCaptures(before, after)), false);
  });

  test("isDated only fires on text carrying a date", () => {
    assert.equal(isDated({ tag: "a", label: "aug 17 intro to basecamp" }), true);
    assert.equal(isDated({ tag: "a", label: "try basecamp free" }), false);
    assert.equal(isDated({ tag: "a", label: "spend $99.00 more" }), false);
    assert.equal(isDated({ tag: "a", label: "3 seats left" }), false);
  });
});
