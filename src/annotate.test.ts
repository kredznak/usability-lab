import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { annotate } from "./annotate.js";
import { Finding } from "./types.js";

/**
 * The picture is the evidence, and a pin is a promise about it.
 *
 * `results.html` tells every reader that a finding "carries the element it
 * refers to so you can verify it yourself", and the figcaption on the annotated
 * image says findings with no box to point at carry no pin. A pin drawn on the
 * wrong part of the image breaks both sentences at once, and it breaks them
 * silently — the page looks exactly like one where the evidence lines up.
 */

const W = 400;
const H = 300;
let dir: string;
let shot: string;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "ulab-annotate-"));
  shot = path.join(dir, "page.png");
  await sharp({
    create: { width: W, height: H, channels: 3, background: { r: 240, g: 240, b: 240 } },
  })
    .png()
    .toFile(shot);
});

after(() => rmSync(dir, { recursive: true, force: true }));

function finding(n: number, bbox: { x: number; y: number; width: number; height: number } | null) {
  return Finding.parse({
    heuristic: `Heuristic ${n}`,
    severity: 2,
    element_ref: bbox ? `el_${n}` : null,
    observation: `Observation ${n}`,
    impact_note: `Impact ${n}`,
    positive: false,
    id: `f${n}`,
    agent: "heuristics",
    screen_ref: "s",
    confidence: "high",
    citation: { source_type: "none", url: null },
    evidence: { screenshot_id: "s", bbox },
  });
}

const run = (findings: ReturnType<typeof finding>[]) => annotate(shot, findings, dir, `a${Date.now()}`);

describe("a pin is only drawn where the reader can check it", () => {
  test("an element inside the image is pinned", async () => {
    const r = await run([finding(1, { x: 20, y: 30, width: 80, height: 24 })]);
    assert.equal(r.pinned, 1);
    assert.equal(r.offImage, 0);
  });

  test("an element below the image is not pinned, and is counted", async () => {
    /**
     * posthog.com/pricing, 2026-08-25, and the reason this file exists.
     *
     * `capture.ts` reads the page height from `document.body.scrollHeight`, and
     * Playwright's `fullPage` screenshot uses the same number. That page
     * scrolls an inner panel rather than the body, so the number was 900 — the
     * viewport — while the DOM walk found elements down to y=4775.
     *
     * 87 of 121 elements were below the picture. Every one of their pins was
     * clamped to the bottom row by `Math.min(box.y, height - 1)`, producing a
     * line of numbered badges along the crop edge, each pointing at whatever
     * happened to be cropped there. Nothing in the pipeline noticed, and the
     * page went to the gate looking exactly like a page whose evidence lined
     * up.
     */
    const r = await run([finding(1, { x: 10, y: H + 3700, width: 120, height: 40 })]);
    assert.equal(r.pinned, 0, "there is nothing in the picture to point at");
    assert.equal(r.offImage, 1, "and the run has to be able to say so");
  });

  test("a box measured just past the edge still renders", async () => {
    /**
     * The clamp is older than the check above and its reason is good: a box
     * measured a pixel or two beyond the edge is a rounding artefact, not a
     * different part of the page, and dropping it would lose a real pin.
     *
     * This is the assertion that stops the fix for PostHog turning into a
     * regression for everyone else.
     */
    const r = await run([finding(1, { x: 10, y: H - 1 + 4, width: 50, height: 20 })]);
    assert.equal(r.pinned, 1);
    assert.equal(r.offImage, 0);
  });

  test("findings with no box were never pinned and are not counted as off-image", () => {
    // The pre-existing case, and the distinction worth keeping: "we could not
    // locate this on the page" and "this is on a part of the page the picture
    // does not cover" are different failures with different fixes.
    return run([finding(1, null)]).then((r) => {
      assert.equal(r.pinned, 0);
      assert.equal(r.offImage, 0);
    });
  });

  test("a mixed set pins what it can and reports the rest", async () => {
    const r = await run([
      finding(1, { x: 10, y: 10, width: 40, height: 20 }),
      finding(2, { x: 10, y: 5000, width: 40, height: 20 }),
      finding(3, { x: 60, y: 60, width: 40, height: 20 }),
      finding(4, null),
    ]);
    assert.equal(r.pinned, 2);
    assert.equal(r.offImage, 1);
  });

  test("the annotated image keeps the screenshot's dimensions", async () => {
    // Composited, not extended — a taller output would mean the pins had been
    // drawn onto a canvas the reader never sees.
    const r = await run([finding(1, { x: 10, y: 10, width: 40, height: 20 })]);
    assert.equal(r.width, W);
    assert.equal(r.height, H);
    const meta = await sharp(r.path).metadata();
    assert.equal(meta.width, W);
    assert.equal(meta.height, H);
  });
});
