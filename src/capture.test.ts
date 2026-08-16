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
