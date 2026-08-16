import sharp from "sharp";
import type { Capture } from "../types.js";

/**
 * The rendered page, cut into pieces a model can actually read.
 *
 * ## Why this exists
 *
 * Reviewers were given an element list and a text excerpt and never the page.
 * On basecamp.com the six product tiles carry their labels — "Message Board",
 * "Docs & Files" — as `.webp` images with `alt=""`. `document.body.textContent`
 * does not contain those words anywhere, so the capture was right, the finding's
 * facts were right, and its conclusion ("no visible caption text on the page")
 * was false. It came back at severity 2 and high confidence on a completely
 * clean capture, which is what made it a decision rather than a curiosity.
 *
 * No amount of DOM inspection fixes that. The caption is pixels.
 *
 * ## Why tiles rather than the whole page
 *
 * The API downscales an image to roughly 1568px on its long edge. basecamp's
 * full-page screenshot is 1440x4604, so sending it whole renders 16px type at
 * about 5px — illegible, and worse than sending nothing, because unreadable
 * text invites confident misreading rather than caution. A 1440x900 slice is
 * already under the limit and arrives untouched.
 *
 * ## The cap
 *
 * A tall page is expensive: stripe/pricing is 22128px, or 25 slices per
 * reviewer. We send at most MAX_TILES and say so — the same discipline B8
 * taught us, where a page text that truncated in silence produced a false
 * finding about what the page did not contain. An input that is cut short says
 * it is cut short.
 */

/** Tiles are cut at the viewport height, so each arrives unscaled. */
export const MAX_TILES = 8;

export interface PageTile {
  /** Base64 PNG, ready for an image content block. */
  base64: string;
  /** Where this slice sits in the full-page screenshot, in CSS pixels. */
  fromY: number;
  toY: number;
}

export interface PageTiles {
  tiles: PageTile[];
  /** Page height we could not send, in CSS pixels. Zero when the page fits. */
  unshownPx: number;
  /** Full page height, so the caller can say what fraction was shown. */
  fullHeightPx: number;
}

/**
 * Cuts the saved full-page screenshot into viewport-height slices.
 *
 * Reads the PNG's real dimensions rather than trusting `capture.full_height`:
 * the screenshot is taken after the elements are measured, and a page that
 * settles in between would otherwise produce a crop past the image edge, which
 * sharp rejects outright. Believing the file is cheap and cannot be wrong.
 */
export async function pageTiles(capture: Capture): Promise<PageTiles> {
  const image = sharp(capture.screenshot_path);
  const meta = await image.metadata();
  const width = meta.width ?? capture.viewport.width;
  const height = meta.height ?? Math.round(capture.full_height);

  const sliceHeight = capture.viewport.height;
  const total = Math.max(1, Math.ceil(height / sliceHeight));
  const shown = Math.min(total, MAX_TILES);

  const tiles: PageTile[] = [];
  for (let i = 0; i < shown; i++) {
    const fromY = i * sliceHeight;
    // The last slice of a page that does not divide evenly is short. Extracting
    // the full sliceHeight there would run past the bottom of the image.
    const cropHeight = Math.min(sliceHeight, height - fromY);
    if (cropHeight <= 0) break;

    const buf = await sharp(capture.screenshot_path)
      .extract({ left: 0, top: fromY, width, height: cropHeight })
      .png()
      .toBuffer();

    tiles.push({ base64: buf.toString("base64"), fromY, toY: fromY + cropHeight });
  }

  const shownPx = tiles.length > 0 ? tiles[tiles.length - 1]!.toY : 0;
  return { tiles, unshownPx: Math.max(0, height - shownPx), fullHeightPx: height };
}
