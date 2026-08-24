import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Capture, type CapturedElement, type RawFinding } from "./types.js";
import { deriveConfidence, pageSources, pageContains } from "./confidence.js";

/**
 * deriveConfidence is the whole of §9.1 — the single place confidence is set,
 * and the reason no model can claim it. It had no unit test until now; its only
 * coverage was two negative controls inside a network-dependent smoke run,
 * which meant the most load-bearing function in the repo was verified only when
 * someone remembered to point the smoke test at a live site.
 *
 * Read these as the specification of what "high" and "medium" are allowed to
 * mean, and note what they deliberately do NOT claim: this function proves an
 * element exists, never that a sentence about it is true. See claims.ts for
 * that, and the header there for why the distinction cost us two live false
 * positives.
 */

function element(over: Partial<CapturedElement> = {}): CapturedElement {
  return {
    ref: "el_1",
    tag: "button",
    role: null,
    text: "Start your free trial",
    bbox: { x: 100, y: 200, width: 180, height: 44 },
    above_fold: true,
    input_type: null,
    accessible_name: null,
    name_source: null,
    font_size: 16,
    ...over,
  };
}

function capture(over: Partial<Capture> = {}): Capture {
  return Capture.parse({
    audit_id: "test",
    url: "https://example.com",
    final_url: "https://example.com/",
    title: "Example",
    screenshot_id: "test-page",
    screenshot_path: "out/test-page.png",
    viewport: { width: 1440, height: 900 },
    full_height: 2000,
    elements: [element()],
    elements_total: 1,
    text_excerpt: "Start your free trial. No credit card required for fourteen days.",
    text_total_chars: 65,
    captured_at: "2026-01-01T00:00:00.000Z",
    ...over,
  });
}

function finding(over: Partial<RawFinding> = {}): RawFinding {
  return {
    heuristic: "Visibility of system status",
    severity: 2,
    element_ref: "el_1",
    observation: "The button reads 'Start your free trial'.",
    impact_note: "costs something",
    positive: false,
    ...over,
  };
}

describe("confidence: high means screenshot-verified", () => {
  test("a real element with a real box is high, and carries its bbox", () => {
    const v = deriveConfidence(finding(), capture());
    assert.equal(v.kind, "keep");
    if (v.kind !== "keep") return;
    assert.equal(v.confidence, "high");
    assert.deepEqual(v.bbox, { x: 100, y: 200, width: 180, height: 44 });
  });

  test("a box too small to see is dropped, not downgraded", () => {
    // A 1x1 element is the screen-reader-only pattern. There is nothing to pin.
    for (const bbox of [
      { x: 0, y: 0, width: 1, height: 1 },
      { x: 0, y: 0, width: 200, height: 3 },
      { x: 0, y: 0, width: 3, height: 200 },
    ]) {
      const v = deriveConfidence(finding(), capture({ elements: [element({ bbox })] }));
      assert.equal(v.kind, "drop", `${bbox.width}x${bbox.height} should drop`);
    }
  });

  test("a box exactly at the minimum is kept", () => {
    const v = deriveConfidence(
      finding(),
      capture({ elements: [element({ bbox: { x: 0, y: 0, width: 4, height: 4 } })] }),
    );
    assert.equal(v.kind, "keep");
  });
});

describe("confidence: a fabricated element is a fabrication, not a weaker claim", () => {
  test("an element_ref not in the capture is dropped", () => {
    const v = deriveConfidence(finding({ element_ref: "el_99999" }), capture());
    assert.equal(v.kind, "drop");
    if (v.kind !== "drop") return;
    assert.match(v.reason, /not present in capture/);
  });

  /**
   * The most important test in this file. An agent that invents an element and
   * also happens to quote the page correctly must NOT be rescued into medium —
   * it has demonstrably made something up, and the quote does not redeem that.
   * If this ever falls through, fabrication becomes a publishable finding.
   */
  test("a fabricated ref does not fall through to a text-inferred medium", () => {
    const v = deriveConfidence(
      finding({
        element_ref: "el_99999",
        observation: 'It says "No credit card required" near the button.',
      }),
      capture(),
    );
    assert.equal(v.kind, "drop", "a fabricated ref must never be rescued by a valid quote");
  });
});

describe("confidence: medium means the page actually says it", () => {
  test("a null ref with a verifiable quote is medium and carries no bbox", () => {
    const v = deriveConfidence(
      finding({ element_ref: null, observation: 'The page says "No credit card required".' }),
      capture(),
    );
    assert.equal(v.kind, "keep");
    if (v.kind !== "keep") return;
    assert.equal(v.confidence, "medium");
    assert.equal(v.bbox, null, "a medium finding has nothing to pin");
  });

  test("a null ref with no quote is dropped", () => {
    const v = deriveConfidence(
      finding({ element_ref: null, observation: "The page feels cluttered and hard to scan." }),
      capture(),
    );
    assert.equal(v.kind, "drop");
  });

  test("a quote that is not on the page is dropped", () => {
    const v = deriveConfidence(
      finding({ element_ref: null, observation: 'The page says "Cancel anytime, no questions".' }),
      capture(),
    );
    assert.equal(v.kind, "drop", "quoting text the page does not contain is the failure mode");
  });

  test("quotes match across curly quotes, case and whitespace", () => {
    const v = deriveConfidence(
      finding({
        element_ref: null,
        observation: "It reads “NO   CREDIT   card Required” in the hero.",
      }),
      capture(),
    );
    assert.equal(v.kind, "keep", "normalisation must survive smart quotes and messy spacing");
  });

  test("a quote shorter than the minimum is not evidence", () => {
    // "free trial" is on the page but too short to distinguish a real quote
    // from a coincidence.
    const v = deriveConfidence(
      finding({ element_ref: null, observation: 'It mentions "free trial" somewhere.' }),
      capture(),
    );
    assert.equal(v.kind, "drop");
  });

  test("element text counts as page text, not just the excerpt", () => {
    const v = deriveConfidence(
      finding({
        element_ref: null,
        observation: 'A control labelled "Start your free trial" appears twice.',
        // Deliberately empty excerpt: the only source of this string is the
        // element list, which must still count as something the page says.
      }),
      capture({ text_excerpt: "", text_total_chars: 0 }),
    );
    assert.equal(v.kind, "keep");
  });
});

describe("confidence: behaviour against a real frozen capture", () => {
  const real = Capture.parse(
    JSON.parse(readFileSync("fixtures/captures/signup.json", "utf8")),
  );

  test("every element in a real capture can support a high-confidence finding", () => {
    const usable = real.elements.filter((e) => e.bbox.width >= 4 && e.bbox.height >= 4);
    assert.ok(usable.length > 0, "fixture has no usable elements");
    for (const e of usable) {
      const v = deriveConfidence(finding({ element_ref: e.ref }), real);
      assert.equal(v.kind, "keep", `${e.ref} should be verifiable`);
    }
  });

  test("the gate is a pure function of its inputs", () => {
    const f = finding({ element_ref: real.elements[0]!.ref });
    assert.deepEqual(deriveConfidence(f, real), deriveConfidence(f, real));
  });
});

/**
 * B30 step 4, pinned rather than left to memory.
 *
 * `rendered_name` records text the browser paints and the DOM cannot carry —
 * basecamp's live counter, whose digits sit in a closed shadow root. It is
 * deliberately **not** a quote source, and this suite is the reason a future
 * edit has to argue with something before changing that.
 *
 * The argument, in one case: the accessibility tree also carries
 * screen-reader-only text. linear.app's h1 is duplicated by a clipped sr-only
 * copy, a reviewer reported the headline as duplicated, and `claims.ts`
 * correctly contradicted it — that test is in `claims.test.ts` and it is the
 * whole reason `visibleText` assembles text by hand instead of using
 * `innerText`. Feeding AX names to the quote check reopens exactly that.
 *
 * This is B6's trade-off (the page title, added as a quote-only source and kept
 * out of `pageSources`) and it takes B6's answer: the narrow one.
 */
describe("what the rendering carries is not a quote source", () => {
  test("pageSources ignores rendered_name", () => {
    const cap = capture({
      elements: [
        element({
          ref: "el_10",
          tag: "a",
          text: "people are working right now!",
          rendered_name: "112,942 people are working right now!",
        }),
      ],
    });

    const sources = pageSources(cap);
    assert.ok(
      sources.some((s) => s.includes("people are working right now!")),
      "the visible text is still a source",
    );
    assert.ok(
      !sources.some((s) => s.includes("112,942")),
      "the rendered-only figure must not be quotable — see the header above",
    );
  });

  test("a quote that exists only in the rendering does not verify", () => {
    // The consequence, stated as behaviour rather than as a list of sources: a
    // reviewer quoting the counter's figure gets no credit from the quote
    // check. That is the accepted cost. The gate is told instead — review.ts
    // prints the rendered name on any finding citing such an element.
    const cap = capture({
      elements: [
        element({
          ref: "el_10",
          tag: "a",
          text: "people are working right now!",
          rendered_name: "112,942 people are working right now!",
        }),
      ],
    });
    assert.equal(pageContains(pageSources(cap), "112,942"), false);
  });
});
