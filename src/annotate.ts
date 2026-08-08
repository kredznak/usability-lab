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
  let pinned = 0;

  findings.forEach((finding, index) => {
    const box = finding.evidence.bbox;
    if (!box) return;

    // Clamp to the image so a box measured just past the edge still renders.
    const x = Math.max(0, Math.min(box.x, width - 1));
    const y = Math.max(0, Math.min(box.y, height - 1));
    const w = Math.max(1, Math.min(box.width, width - x));
    const h = Math.max(1, Math.min(box.height, height - y));

    const label = String(index + 1);
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

  return { path: outPath, pinned, width, height };
}
