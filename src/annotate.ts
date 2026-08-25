import sharp from "sharp";
import path from "node:path";
import type { Finding } from "./types.js";

/**
 * annotation-renderer — docs/design.md §5. Deterministic pins from
 * Finding.evidence.bbox. No model call, no judgement: if the box is right, the
 * pin is right, and if the pin is wrong the capture is wrong.
 */

const STROKE = "#E4572E";
const STROKE_DIM = "rgba(228,87,46,0.35)";
const PIN_R = 20;

function escapeXml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c] as string,
  );
}

export interface AnnotationResult {
  path: string;
  pinned: number;
  width: number;
  height: number;
  /**
   * Findings whose element lies outside the screenshot entirely, and which
   * therefore got no pin. Non-zero means the capture and the picture disagree
   * about how tall the page is — see the note on OFF_IMAGE_TOLERANCE.
   */
  offImage: number;
}

/**
 * How far past the image edge a box may sit and still be drawn, clamped.
 *
 * The clamp is older than this constant and its reason is good: a box measured
 * a pixel or two past the edge should still render rather than vanish. What it
 * was not written for is a box 3,700 pixels below the image, which is what
 * arrives from a page whose content scrolls inside a container.
 *
 * posthog.com/pricing, 2026-08-25. `document.body.scrollHeight` returned 900 —
 * the viewport — because the page scrolls an inner panel, so the full-page
 * screenshot was one screen tall while the DOM walk found elements down to
 * y=4775. **87 of 121 elements were below the picture**, and every one of their
 * pins was clamped onto the bottom row: a line of numbered badges along the
 * crop edge, each pointing at something not in the frame.
 *
 * Measured against the seven other audits on disk, where the deepest element
 * always sits inside the screenshot — so this threshold has never fired on a
 * page that captured properly.
 */
const OFF_IMAGE_TOLERANCE = 8;

/**
 * Which number, if any, got drawn on the screenshot for each finding.
 *
 * The one definition of the pin rule. Both pages render pins and neither draws
 * them, so without this they each re-derive the numbering and drift from the
 * image — which is exactly what happened: the visitor's page showed severity
 * badges under a caption promising the pins matched.
 *
 * Numbers are positions in the full findings array, so they have gaps. A
 * finding with no bbox takes its number out of circulation rather than
 * renumbering everything after it, because the alternative is a page whose pin
 * 4 is the image's pin 5.
 */
export function pinNumbers(
  findings: Finding[],
  /**
   * The screenshot's dimensions, when the caller knows them. Omitted, every
   * finding with a box gets a number — which is right for a caller that only
   * needs the numbering and wrong for one deciding what to show a reader.
   */
  image?: { width: number; height: number },
): Map<string, number> {
  const pins = new Map<string, number>();
  findings.forEach((finding, index) => {
    const box = finding.evidence.bbox;
    if (!box) return;
    // The same rule `annotate` draws by, in one place because the two must
    // agree: a card offering pin 12 beside a picture with no pin 12 on it sends
    // the reader looking for something that is not there.
    if (image && isOffImage(box, image)) return;
    pins.set(finding.id, index + 1);
  });
  return pins;
}

/** Outside the picture, beyond the rounding the clamp exists to absorb. */
export function isOffImage(
  box: { x: number; y: number },
  image: { width: number; height: number },
): boolean {
  return (
    box.y > image.height - 1 + OFF_IMAGE_TOLERANCE || box.x > image.width - 1 + OFF_IMAGE_TOLERANCE
  );
}

/**
 * Draws numbered pins over the full-page screenshot. Findings without a bbox
 * (medium confidence, text-inferred) are intentionally not drawn — a pin with
 * nowhere to point would be a claim we cannot back.
 */
export async function annotate(
  screenshotPath: string,
  findings: Finding[],
  outDir: string,
  auditId: string,
): Promise<AnnotationResult> {
  const image = sharp(screenshotPath);
  const meta = await image.metadata();
  const width = meta.width ?? 0;
  const height = meta.height ?? 0;
  if (!width || !height) throw new Error(`cannot read dimensions of ${screenshotPath}`);

  const shapes: string[] = [];
  const pins = pinNumbers(findings);
  let pinned = 0;
  let offImage = 0;

  findings.forEach((finding) => {
    const box = finding.evidence.bbox;
    if (!box) return;

    /*
     * No box in the picture is the same as no box at all, and the results page
     * already says so out loud: "Findings inferred from page text carry no pin,
     * because there is no box to point at." An element the screenshot does not
     * contain is in that position however precisely it was measured.
     *
     * Drawing it anyway is worse than drawing nothing. A pin is a promise that
     * the reader can check the claim against the image, and one clamped to the
     * bottom edge points at whatever happens to be cropped there.
     */
    if (isOffImage(box, { width, height })) {
      offImage++;
      return;
    }

    // Clamp to the image so a box measured just past the edge still renders.
    const x = Math.max(0, Math.min(box.x, width - 1));
    const y = Math.max(0, Math.min(box.y, height - 1));
    const w = Math.max(1, Math.min(box.width, width - x));
    const h = Math.max(1, Math.min(box.height, height - y));

    // From the same map the pages read, so the drawn number and the rendered
    // number cannot disagree.
    const label = String(pins.get(finding.id));
    // Pin sits at the top-left of the box, nudged inside when the box is flush
    // against the left or top edge so the badge never clips off-canvas.
    const cx = Math.max(PIN_R + 2, x);
    const cy = Math.max(PIN_R + 2, y);

    shapes.push(
      `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" ` +
        `stroke="${finding.severity >= 3 ? STROKE : STROKE_DIM}" stroke-width="3" rx="4"/>`,
      `<circle cx="${cx}" cy="${cy}" r="${PIN_R}" fill="${STROKE}" stroke="#fff" stroke-width="3"/>`,
      `<text x="${cx}" y="${cy}" fill="#fff" font-family="Helvetica,Arial,sans-serif" ` +
        `font-size="22" font-weight="700" text-anchor="middle" dominant-baseline="central">` +
        `${escapeXml(label)}</text>`,
    );
    pinned++;
  });

  const svg = Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${shapes.join("")}</svg>`,
  );

  const outPath = path.join(outDir, `${auditId}-annotated.png`);
  await image.composite([{ input: svg, top: 0, left: 0 }]).png().toFile(outPath);

  return { path: outPath, pinned, width, height, offImage };
}
