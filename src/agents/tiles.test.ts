import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { pageTiles, MAX_TILES } from "./tiles.js";
import { Capture } from "../types.js";

/**
 * Slicing the screenshot for reviewers.
 *
 * The geometry matters more than it looks. A reviewer places a tile on the page
 * by the pixel range we label it with, and then reconciles it against element
 * boxes measured in the same coordinate space. Off-by-one-slice labelling would
 * have every finding below the fold pointing at the wrong part of the page —
 * silently, and in a way no schema could catch.
 */

let dir: string;

before(() => {
  dir = mkdtempSync(path.join(tmpdir(), "ulab-tiles-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A page screenshot of a given height, written where a Capture would point. */
async function pageOf(height: number, name: string): Promise<Capture> {
  const file = path.join(dir, `${name}.png`);
  await sharp({
    create: { width: 1440, height, channels: 3, background: { r: 240, g: 240, b: 240 } },
  })
    .png()
    .toFile(file);

  return Capture.parse({
    audit_id: "t",
    url: "https://example.com",
    final_url: "https://example.com",
    title: "T",
    screenshot_id: name,
    screenshot_path: file,
    viewport: { width: 1440, height: 900 },
    full_height: height,
    elements: [
      {
        ref: "el_1",
        tag: "button",
        role: null,
        text: "Go",
        bbox: { x: 0, y: 0, width: 80, height: 40 },
        above_fold: true,
        input_type: null,
        accessible_name: "Go",
        name_source: "label",
        font_size: 16,
      },
    ],
    elements_total: 1,
    text_excerpt: "Go",
    text_total_chars: 2,
    captured_at: "frozen",
  });
}

describe("tile geometry", () => {
  test("a page exactly one viewport tall is one whole tile", async () => {
    const t = await pageTiles(await pageOf(900, "one"));
    assert.equal(t.tiles.length, 1);
    assert.deepEqual({ from: t.tiles[0]!.fromY, to: t.tiles[0]!.toY }, { from: 0, to: 900 });
    assert.equal(t.unshownPx, 0);
  });

  test("slices are contiguous and cover the page with no gap or overlap", async () => {
    const t = await pageTiles(await pageOf(2700, "three"));
    assert.equal(t.tiles.length, 3);
    let expected = 0;
    for (const tile of t.tiles) {
      assert.equal(tile.fromY, expected, "a gap or overlap between slices");
      expected = tile.toY;
    }
    assert.equal(expected, 2700, "slices must reach the bottom of the page");
    assert.equal(t.unshownPx, 0);
  });

  test("the last slice of an uneven page is short, not padded or dropped", async () => {
    // 2000px is two full slices and a 200px remainder. Extracting a full 900
    // there would run past the image and sharp would throw.
    const t = await pageTiles(await pageOf(2000, "uneven"));
    assert.equal(t.tiles.length, 3);
    assert.deepEqual({ from: t.tiles[2]!.fromY, to: t.tiles[2]!.toY }, { from: 1800, to: 2000 });
  });

  test("every slice decodes as a real PNG of the width we captured", async () => {
    const t = await pageTiles(await pageOf(2000, "decode"));
    for (const tile of t.tiles) {
      const meta = await sharp(Buffer.from(tile.base64, "base64")).metadata();
      assert.equal(meta.format, "png");
      assert.equal(meta.width, 1440);
      assert.equal(meta.height, tile.toY - tile.fromY);
    }
  });
});

describe("the cap, and admitting to it", () => {
  test("a tall page stops at MAX_TILES and reports what was left off", async () => {
    // stripe/pricing is 22128px. Sending it whole is 25 slices per reviewer.
    const height = (MAX_TILES + 4) * 900;
    const t = await pageTiles(await pageOf(height, "tall"));
    assert.equal(t.tiles.length, MAX_TILES);
    assert.equal(t.fullHeightPx, height);
    assert.equal(t.unshownPx, height - MAX_TILES * 900, "the unshown remainder must be exact");
  });

  test("a page that fits reports nothing unshown", async () => {
    const t = await pageTiles(await pageOf(MAX_TILES * 900, "exact"));
    assert.equal(t.tiles.length, MAX_TILES);
    assert.equal(t.unshownPx, 0);
  });
});

describe("what the screenshot on disk says, not what the capture remembers", () => {
  test("a capture claiming more height than the PNG has does not crash", async () => {
    // The screenshot is taken after the elements are measured. A page that
    // settles in between leaves full_height and the file disagreeing, and
    // cropping past the edge is a hard error in sharp — an audit lost at the
    // last step for a cosmetic reason.
    const capture = await pageOf(1000, "shrunk");
    const lying = Capture.parse({ ...capture, full_height: 9000 });
    const t = await pageTiles(lying);
    assert.equal(t.fullHeightPx, 1000, "the file is the authority");
    assert.equal(t.tiles.length, 2);
    assert.equal(t.unshownPx, 0);
  });
});
