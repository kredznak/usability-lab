import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Capture, Finding, type CapturedElement } from "./types.js";
import { renderPublic, locationLine, FREE_FINDINGS } from "./render.js";

/**
 * The visitor's page is the only artifact a customer ever sees, and its riskiest
 * sentence is the one counting what we held back. If that number drifts from the
 * truth we are misrepresenting the thing we charge for, and no other test in the
 * suite is looking at it.
 */

function element(over: Partial<CapturedElement> = {}): CapturedElement {
  return {
    ref: "el_1",
    tag: "button",
    role: null,
    text: "",
    bbox: { x: 0, y: 0, width: 61, height: 61 },
    above_fold: true,
    input_type: null,
    accessible_name: null,
    name_source: null,
    font_size: 16,
    ...over,
  };
}

function capture(elements: CapturedElement[] = []): Capture {
  return Capture.parse({
    audit_id: "test",
    url: "https://example.com",
    final_url: "https://example.com/",
    title: "Example",
    screenshot_id: "s",
    screenshot_path: "out/s.png",
    viewport: { width: 1440, height: 900 },
    full_height: 2000,
    elements,
    elements_total: elements.length,
    text_excerpt: "",
    text_total_chars: 0,
    captured_at: "frozen",
  });
}

function finding(n: number, severity: number, over: Partial<Finding> = {}): Finding {
  return Finding.parse({
    heuristic: `Heuristic ${n}`,
    severity,
    element_ref: null,
    observation: `Observation ${n}`,
    impact_note: `Impact ${n}`,
    positive: false,
    id: `f${n}`,
    agent: "heuristics",
    screen_ref: "s",
    confidence: "high",
    citation: { source_type: "none", url: null },
    evidence: { screenshot_id: "s", bbox: null },
    ...over,
  });
}

const PROFILE = {
  site_kind: "other" as const,
  concerns: [],
  goal: "unknown",
  drop_point: "unknown",
  summary: "A review of this page.",
};

async function publish(kept: Finding[], cap = capture()): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "ulab-render-"));
  try {
    const out = await renderPublic(
      { capture: cap, kept, annotatedImage: path.join(dir, "a.png"), profile: PROFILE },
      dir,
    );
    return readFileSync(out, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the visitor's page: what it shows and what it admits to hiding", () => {
  test("shows three issues and no more, however many were kept", async () => {
    const html = await publish([1, 2, 3, 4, 5, 6, 7].map((n) => finding(n, 2)));
    for (const n of [1, 2, 3]) {
      assert.match(html, new RegExp(`Observation ${n}<`), `finding ${n} should be shown`);
    }
    for (const n of [4, 5, 6, 7]) {
      assert.doesNotMatch(html, new RegExp(`Observation ${n}<`), `finding ${n} must be withheld`);
    }
  });

  test("the withheld count is the real number, not the page's finding count", async () => {
    const html = await publish([1, 2, 3, 4, 5, 6, 7].map((n) => finding(n, 2)));
    assert.match(html, /4 more findings/);
    assert.match(html, /found 7 issues on this page/);
  });

  test("severity order decides what is free — a severity 4 is never withheld behind 2s", async () => {
    // Ranked last by the Synthesizer but the most severe thing on the page.
    const kept = [finding(1, 2), finding(2, 2), finding(3, 2), finding(4, 4)];
    const html = await publish(kept);
    assert.match(html, /Observation 4</, "the severity 4 must be one of the three shown");
    assert.match(html, /1 more finding\b/);
    assert.doesNotMatch(html, /1 more findings/, "singular when one is held back");
  });

  test("the withheld line states how severe the held-back findings are", async () => {
    const severe = await publish([
      finding(1, 4),
      finding(2, 4),
      finding(3, 4),
      finding(4, 3),
      finding(5, 3),
    ]);
    assert.match(severe, /2 of the 2 held back are severity 3 or higher/);

    const mild = await publish([finding(1, 4), finding(2, 4), finding(3, 4), finding(4, 1)]);
    assert.match(mild, /None of the 1 held back is above severity 2/);
  });

  test("with three or fewer findings there is no withhold notice at all", async () => {
    const html = await publish([finding(1, 3), finding(2, 2)]);
    assert.doesNotMatch(html, /more finding/);
    assert.doesNotMatch(html, /held back/);
  });

  test("positives never occupy one of the three free slots", async () => {
    const kept = [
      finding(1, 1, { positive: true }),
      finding(2, 2),
      finding(3, 2),
      finding(4, 2),
      finding(5, 2),
    ];
    const html = await publish(kept);
    for (const n of [2, 3, 4]) {
      assert.match(html, new RegExp(`Observation ${n}<`), `issue ${n} should be shown`);
    }
    assert.match(html, /found 4 issues on this page/, "positives are not counted as issues");
    assert.match(html, /Observation 1</, "the positive still appears, in its own section");
  });

  test("FREE_FINDINGS is what the page actually honours", async () => {
    const html = await publish(Array.from({ length: 9 }, (_, i) => finding(i + 1, 2)));
    const shown = [...html.matchAll(/class="observation"/g)].length;
    assert.equal(shown, FREE_FINDINGS);
  });
});

describe("locationLine: a founder should not need devtools", () => {
  const cap = capture([
    element({ ref: "el_19", tag: "a", text: "SHOP MEN", above_fold: true }),
    element({ ref: "el_81", tag: "input", text: "", accessible_name: "Email Address" }),
    element({ ref: "el_0", tag: "button", text: "", above_fold: false }),
  ]);

  test("names the element by its visible text and keeps the ref", () => {
    const line = locationLine(finding(1, 2, { element_ref: "el_19" }), cap);
    assert.match(line, /“SHOP MEN”/);
    assert.match(line, /<a>/);
    assert.match(line, /above the fold/);
    assert.match(line, /\(el_19\)/, "the ref stays — it is what makes the finding checkable");
  });

  test("falls back to the accessible name when there is no visible text", () => {
    const line = locationLine(finding(1, 2, { element_ref: "el_81" }), cap);
    assert.match(line, /“Email Address”/);
  });

  test("says so plainly when an element has no name of any kind", () => {
    const line = locationLine(finding(1, 2, { element_ref: "el_0" }), cap);
    assert.match(line, /unlabelled <button>/);
    assert.match(line, /below the fold/);
  });

  test("a page-level finding says it is page-level rather than inventing a location", () => {
    assert.match(locationLine(finding(1, 2), cap), /Page-level/);
  });

  test("a ref that is not in the capture is reported, not rendered as if fine", () => {
    const line = locationLine(finding(1, 2, { element_ref: "el_999" }), cap);
    assert.match(line, /not present in the capture/);
  });
});
