/**
 * No-model smoke test for the riskiest mechanical path: does a bbox measured by
 * the capture step land on the right pixels in the annotated screenshot?
 *
 * Picks real captured elements, synthesises findings pointing at them, and runs
 * the real confidence gate and the real annotator. If the pins are right here they
 * are right in the pipeline — the only difference upstream is who picks the element.
 *
 * Also asserts the two negative controls the confidence gate must reject.
 * Needs no API key, so it is the fast check to run after touching capture,
 * confidence, or annotate.
 *
 *   npm run smoke -- https://example.com
 */
import { createHash } from "node:crypto";
import { capture } from "./capture.js";
import { deriveConfidence } from "./confidence.js";
import { annotate } from "./annotate.js";
import { renderResults } from "./render.js";
import { deriveSignals } from "./signals.js";
import { Finding, type RawFinding } from "./types.js";

const url = process.argv[2] ?? "https://example.com";
// Hash the whole URL — hexing the first bytes gives "68747470" ("http") for
// every site, which silently overwrote one run's output with the next.
const auditId = "smoke-" + createHash("sha256").update(url).digest("hex").slice(0, 10);
const outDir = `out/${auditId}`;

const started = Date.now();
const cap = await capture(url, auditId, outDir);
const captureMs = Date.now() - started;

console.log(`captured ${cap.elements.length} elements from ${cap.final_url}`);
console.log(`full page: ${cap.viewport.width}x${Math.round(cap.full_height)}px`);

// A spread of real elements: above the fold, mid-page, and below the fold.
// Below-fold pins are the ones that catch a missing scroll-offset conversion.
const above = cap.elements.filter((e) => e.above_fold && e.bbox.width > 40);
const below = cap.elements.filter((e) => !e.above_fold && e.bbox.width > 40);
const picks = [
  above[0],
  above[Math.floor(above.length / 2)],
  below[0],
  below[below.length - 1],
].filter((e): e is NonNullable<typeof e> => Boolean(e));

const raws: RawFinding[] = picks.map((el, i) => ({
  heuristic: `Smoke pin ${i + 1} (${el.above_fold ? "above" : "below"} fold)`,
  severity: ((i % 4) + 1) as 1 | 2 | 3 | 4,
  element_ref: el.ref,
  observation:
    `Synthetic finding pointing at ${el.ref} (<${el.tag}>) at ` +
    `${Math.round(el.bbox.x)},${Math.round(el.bbox.y)} sized ` +
    `${Math.round(el.bbox.width)}x${Math.round(el.bbox.height)}.`,
  impact_note: "Pin-placement check only — not a real usability claim.",
  positive: i === 0,
}));

// Negative controls. Both MUST be dropped, or the confidence gate is not gating.
raws.push({
  heuristic: "Control: fabricated element ref",
  severity: 3,
  element_ref: "el_99999",
  observation: "Points at an element that does not exist in the capture.",
  impact_note: "Must be dropped.",
  positive: false,
});
raws.push({
  heuristic: "Control: unquotable page-level claim",
  severity: 2,
  element_ref: null,
  observation: "A vague claim with no element reference and no quote from the page.",
  impact_note: "Must be dropped.",
  positive: false,
});

const findings: Finding[] = [];
const dropped: { reason: string; heuristic: string }[] = [];

for (const raw of raws) {
  const verdict = deriveConfidence(raw, cap);
  if (verdict.kind === "drop") {
    dropped.push({ reason: verdict.reason, heuristic: raw.heuristic });
    console.log(`  DROP  ${raw.heuristic}: ${verdict.reason}`);
    continue;
  }
  console.log(`  KEEP  ${raw.heuristic}: ${verdict.confidence} (${verdict.reason})`);
  findings.push(
    Finding.parse({
      ...raw,
      id: `${auditId}-f${findings.length + 1}`,
      agent: "smoke",
      screen_ref: cap.screenshot_id,
      confidence: verdict.confidence,
      citation: { source_type: "none", url: null },
      evidence: { screenshot_id: cap.screenshot_id, bbox: verdict.bbox },
    }),
  );
}

const annotated = await annotate(cap.screenshot_path, findings, outDir, auditId);
const html = await renderResults(
  {
    capture: cap,
    findings,
    dropped,
    annotatedImage: annotated.path,
    timings: [{ step: "capture", ms: captureMs }],
    costUsd: 0,
    // The smoke test exercises capture, the confidence gate and pin alignment.
    // It makes no model call, so there is no profile, plan or synthesis to
    // show — and saying so on the page is more honest than inventing one.
    profile: {
      site_kind: "other",
      concerns: [],
      goal: "unknown",
      drop_point: "unknown",
      summary: "Smoke test: synthetic findings against a real capture. No model was called.",
    },
    signals: deriveSignals(cap),
    plan: {
      spawn: [],
      fired: [],
      dropped: [],
      rationale: "No reviewers were spawned; findings here are synthetic.",
      override_rejected: null,
      latencyMs: 0,
      costUsd: 0,
    },
    synthesis: {
      merged: [],
      excluded: [],
      rejected: [],
      degraded: null,
      latencyMs: 0,
      costUsd: 0,
    },
    degraded: [],
  },
  outDir,
);

console.log(`\nannotated ${annotated.pinned} pins on ${annotated.width}x${annotated.height} image`);
console.log(`${html}`);

const controlsDropped = dropped.length === 2;
const allPinned = annotated.pinned === picks.length;
console.log(
  `\ncontrols dropped: ${controlsDropped ? "PASS" : `FAIL (expected 2, got ${dropped.length})`}`,
);
console.log(
  `real elements pinned: ${allPinned ? "PASS" : `FAIL (expected ${picks.length}, got ${annotated.pinned})`}`,
);
if (!controlsDropped || !allPinned) process.exitCode = 1;
