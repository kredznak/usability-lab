import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { capture } from "./capture.js";
import type { Capture } from "./types.js";

/**
 * Capture's visibility contract, tested against a real browser.
 *
 * ## Why this file exists
 *
 * Cotopaxi's cart audit (2026-08-16) produced four findings about a slide-out
 * mini-cart positioned at x=1455–1778 — past the right edge of a 1440px
 * viewport, and so absent from the screenshot every finding is pinned onto.
 * Fifteen of ninety-seven elements were off-canvas, and all fifteen were
 * reported `above_fold: true`, because visibility was computed as
 * `pageY < foldY` — the y-axis alone.
 *
 * The findings that came out of it were the dangerous kind: every one stated a
 * true fact about the DOM and drew a false conclusion about a visitor. "The
 * same donation toggle appears twice" is exactly right about the document and
 * exactly wrong about the page. `claims.ts` confirms the element exists and the
 * quoted text is present; `deriveConfidence` confirms the element is real. Both
 * pass. Nothing downstream can catch it, which is why it has to be caught here.
 *
 * ## Why a browser and not a unit test
 *
 * The check lives inside `page.evaluate`, where an imported helper cannot be
 * called — tsx compiles named functions with an esbuild `__name(...)` wrapper
 * that does not exist in the browser context (see the comment in capture.ts).
 * So the predicate cannot be extracted and unit-tested without duplicating it,
 * and a duplicated rule is what produced the pin-numbering bug in Slice 4. One
 * real browser against one real page is the honest version.
 */

const FIXTURE = pathToFileURL(path.resolve("fixtures/pages/offcanvas.html")).href;
const VIEWPORT_WIDTH = 1440;

let cap: Capture;
let dir: string;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "ulab-capture-"));
  cap = await capture(FIXTURE, "test-offcanvas", dir);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const byText = (needle: string) =>
  cap.elements.filter((e) =>
    `${e.text ?? ""} ${e.accessible_name ?? ""}`.toLowerCase().includes(needle.toLowerCase()),
  );

describe("elements outside the viewport are not page elements", () => {
  test("nothing is captured entirely past the right edge", () => {
    const past = cap.elements.filter((e) => e.bbox.x >= VIEWPORT_WIDTH);
    assert.deepEqual(
      past.map((e) => `${e.ref} ${e.tag} "${e.text ?? e.accessible_name ?? ""}" at x=${e.bbox.x}`),
      [],
      "a right-hand drawer is off-canvas; a visitor cannot see it and the screenshot does not contain it",
    );
  });

  test("nothing is captured entirely past the left edge", () => {
    // The mirror case. A right-only check passes Cotopaxi and still misses
    // RTL layouts and left-hand nav drawers.
    const past = cap.elements.filter((e) => e.bbox.x + e.bbox.width <= 0);
    assert.deepEqual(past.map((e) => e.ref), []);
  });

  test("the right-hand cart drawer's contents are all gone", () => {
    assert.equal(byText("Check Out").length, 0, "drawer checkout button");
    assert.equal(byText("Donate today").length, 0, "drawer donate button");
    assert.equal(byText("Cart drawer heading").length, 0, "drawer heading");
  });

  test("the left-hand nav drawer's contents are gone too", () => {
    assert.equal(byText("Shop all").length, 0);
  });
});

describe("what must still be captured", () => {
  test("on-screen content survives — this is a skip, not a purge", () => {
    assert.equal(byText("Continue to Checkout").length, 1);
    assert.equal(byText("Your cart is empty").length, 1);
  });

  test("an element straddling the edge is kept", () => {
    // Partly visible is visible. Dropping these would hide real overflow
    // problems, which are worth finding rather than filtering away.
    const peeking = byText("Partly on screen");
    assert.equal(peeking.length, 1, "a button half past the edge is still something a visitor sees");
    assert.ok(peeking[0]!.bbox.x < VIEWPORT_WIDTH);
    assert.ok(peeking[0]!.bbox.x + peeking[0]!.bbox.width > VIEWPORT_WIDTH);
  });

  test("above_fold stays a claim about the fold, not about everything", () => {
    // Guards the lazy fix: forcing off-canvas elements to above_fold=false
    // instead of dropping them would make them read as "further down the
    // page", which is a different wrong answer.
    const main = byText("Continue to Checkout")[0]!;
    assert.equal(main.above_fold, true);
  });
});

describe("drawer text stays out of the page text too", () => {
  /**
   * Filtering the element list alone was a half-fix. Cotopaxi's second run
   * still produced "the visible page text includes a Check Out label near the
   * item/subtotal line" — the drawer's elements were gone, its words were not,
   * and a reviewer read them out of text_excerpt. Reviewers are given that
   * string wholesale, so it is as much a visibility surface as the bboxes.
   */
  test("text_excerpt does not carry the right-hand drawer's words", () => {
    assert.ok(
      !cap.text_excerpt.includes("Cart drawer heading"),
      `drawer text leaked into text_excerpt: ${cap.text_excerpt}`,
    );
    assert.ok(!cap.text_excerpt.includes("Check Out"), "drawer's checkout label leaked");
  });

  test("text_excerpt does not carry the left-hand drawer's words either", () => {
    assert.ok(!cap.text_excerpt.includes("Shop all"));
  });

  test("on-screen words are still there — this is a filter, not a purge", () => {
    assert.ok(cap.text_excerpt.includes("Your cart is empty"));
    assert.ok(cap.text_excerpt.includes("Continue to Checkout"));
    assert.ok(cap.text_excerpt.includes("Partly on screen"), "straddling text is visible text");
  });
});

describe("hidden by an ancestor is hidden", () => {
  /**
   * Cotopaxi's region dropdown: `<a>Australia</a>` computing opacity 1,
   * visibility visible, and a real 151x19 box, inside a wrapper with
   * `opacity: 0` and 1px of overflow-hidden height. `opacity` does not inherit
   * as a computed value, so the link's own style says "visible" and means
   * nothing. The audit duly reported that the country list fails to mark the
   * active region — about a menu nobody had opened.
   */
  test("a closed dropdown's links are not captured", () => {
    assert.equal(byText("Australia").length, 0, "closed dropdown link was captured");
    assert.equal(byText("Canada").length, 0);
  });

  test("and its words are not in the page text", () => {
    assert.ok(!cap.text_excerpt.includes("Australia"));
  });

  test("the element list and the page text agree about what is visible", () => {
    // The invariant behind all of this. The text walk prunes from the top and
    // was always the stricter of the two; the element list inspecting each
    // node alone is what let three separate findings through. Any element
    // carrying text the page text does not have means they have diverged
    // again.
    for (const e of cap.elements) {
      const own = (e.text ?? "").trim();
      if (own.length < 8) continue;
      assert.ok(
        cap.text_excerpt.includes(own),
        `${e.ref} <${e.tag}> carries "${own}", which is not in the visible page text`,
      );
    }
  });
});

describe("markup is not page text", () => {
  /**
   * B9. 47% of asana's "visible page text" was `<iframe src="//b.yjtag.jp/...">`
   * — tracking markup inside `<noscript>`, which with scripting enabled is a
   * single unparsed text node, and which Chromium computes as display:inline,
   * opacity 1, 0x0. Every style check we had waved it through. Reviewers are
   * asked to reason about the words a visitor reads; half of asana's were this.
   */
  test("noscript contents never reach the page text", () => {
    assert.ok(!cap.text_excerpt.includes("<iframe"), `raw markup in page text: ${cap.text_excerpt}`);
    assert.ok(!cap.text_excerpt.includes("GTM-TRACKME"));
  });

  test("script and template contents do not either", () => {
    // These are usually display:none and usually caught. Usually is not a
    // contract, which is why the skip is by tag.
    assert.ok(!cap.text_excerpt.includes("scriptTextIsNotPageText"));
    assert.ok(!cap.text_excerpt.includes("templateTextIsNotPageText"));
  });

  test("the words a visitor actually reads are untouched", () => {
    assert.ok(cap.text_excerpt.includes("Your cart is empty"));
    assert.ok(cap.text_excerpt.includes("Continue to Checkout"));
  });
});

describe("the exclusion is data, not silence", () => {
  test("elements_total counts what the page had, so the drop is visible", () => {
    // If total silently equalled the kept count, a page whose entire content
    // sat in a drawer would look like a page with nothing on it.
    assert.ok(
      cap.elements_total > cap.elements.length,
      `expected more elements on the page (${cap.elements_total}) than captured (${cap.elements.length})`,
    );
  });
});

/**
 * B13. A fixed header paints once, at the top, in a full-page screenshot.
 *
 * duolingo's header is `position: fixed`, 1440x72 at top:0, and a reviewer
 * looking at the eight slices reported "no fixed or sticky version of it
 * reappears" — severity 2, high confidence, and false. The screenshot cannot
 * carry this fact and the element list was not carrying it either, so there was
 * nothing on the reviewer's side of the wall to be right with.
 */
describe("elements that stay put while the page scrolls say so", () => {
  let sticky: Capture;
  let stickyDir: string;

  before(async () => {
    stickyDir = mkdtempSync(path.join(tmpdir(), "ulab-sticky-"));
    sticky = await capture(
      pathToFileURL(path.resolve("fixtures/pages/sticky.html")).href,
      "test-sticky",
      stickyDir,
    );
  });

  after(() => {
    rmSync(stickyDir, { recursive: true, force: true });
  });

  const find = (needle: string) =>
    sticky.elements.find((e) => (e.text ?? "").includes(needle));

  test("a fixed header is recorded as fixed", () => {
    assert.equal(find("Home")?.position, "fixed");
  });

  test("a sticky sub-nav is recorded as sticky", () => {
    assert.equal(find("Section one")?.position, "sticky");
  });

  test("an ordinary element claims nothing", () => {
    // Null, not "static". The renderer says nothing when this is null, and a
    // capture taken before 2026-08-17 has null everywhere — so null has to
    // mean "unknown", never "definitely not sticky".
    assert.equal(find("Announcement")?.position ?? null, null);
    assert.equal(find("A link near the bottom")?.position ?? null, null);
  });
});
