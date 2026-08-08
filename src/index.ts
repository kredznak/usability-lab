import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { capture, CaptureFailed } from "./capture.js";
import { runHeuristics } from "./agents/heuristics.js";
import { deriveConfidence } from "./confidence.js";
import { annotate } from "./annotate.js";
import { renderResults } from "./render.js";
import { CallLog } from "./db.js";
import { Finding, normalizeSeverity } from "./types.js";

/**
 * v0 slice 1 — one URL end to end.
 *
 *   capture -> heuristics (R0) -> derived confidence -> annotation -> results page
 *
 * Deliberately NOT here: the question flow, Context Profiler, Orchestrator and
 * spawn rules R1-R5, Synthesizer, Research, lint, founder review. See §0 of
 * docs/design.md for the full v0 cut line.
 */

interface Timing {
  step: string;
  ms: number;
}

async function timed<T>(step: string, timings: Timing[], fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  process.stderr.write(`  ${step.padEnd(12)} `);
  try {
    const result = await fn();
    const ms = Date.now() - started;
    timings.push({ step, ms });
    process.stderr.write(`${(ms / 1000).toFixed(1)}s\n`);
    return result;
  } catch (err) {
    process.stderr.write(`failed after ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
    throw err;
  }
}

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url) {
    console.error("usage: npm run audit -- <url>");
    process.exit(2);
  }
  try {
    new URL(url);
  } catch {
    console.error(`not a valid URL: ${url}`);
    process.exit(2);
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    console.error(
      "\nNo ANTHROPIC_API_KEY found.\n\n" +
        "  cp .env.example .env      then paste your key into .env\n" +
        "  (get one at https://platform.claude.com/settings/keys)\n\n" +
        ".env is gitignored and loaded automatically by `npm run audit`.\n",
    );
    process.exit(2);
  }

  // UUIDv7 is the correlation key in §8; v4 is a stand-in until we add a v7
  // generator. Either way it is the single ID threaded through every artifact.
  const auditId = randomUUID();
  const outDir = path.join("out", auditId);
  const timings: Timing[] = [];
  const log = new CallLog();

  console.error(`\naudit ${auditId}\n${url}\n`);

  try {
    const client = new Anthropic();

    const captured = await timed("capture", timings, () => capture(url, auditId, outDir));

    const heuristics = await timed("heuristics", timings, () =>
      runHeuristics(client, captured, log),
    );

    // Confidence gate. Pure, synchronous, and the only place confidence is set.
    const findings: Finding[] = [];
    const dropped: { reason: string; heuristic: string }[] = [];
    let severityAdjusted = 0;

    for (const raw of heuristics.findings) {
      const verdict = deriveConfidence(raw, captured);
      if (verdict.kind === "drop") {
        dropped.push({ reason: verdict.reason, heuristic: raw.heuristic });
        continue;
      }
      const severity = normalizeSeverity(raw.severity);
      if (severity.adjusted) severityAdjusted++;

      findings.push(
        Finding.parse({
          ...raw,
          severity: severity.value,
          id: `${auditId}-f${findings.length + 1}`,
          agent: "heuristics",
          screen_ref: captured.screenshot_id,
          confidence: verdict.confidence,
          // Research lands in slice 3. Until then every finding is honestly
          // `none`, which §9.3 makes a legal, unpunished output.
          citation: { source_type: "none", url: null },
          evidence: { screenshot_id: captured.screenshot_id, bbox: verdict.bbox },
        }),
      );
    }

    // Rank by severity, then put screenshot-verified findings above inferred
    // ones, so the strongest evidence leads (quality-bar.md §3).
    findings.sort(
      (a, b) =>
        Number(a.positive) - Number(b.positive) ||
        b.severity - a.severity ||
        (a.confidence === b.confidence ? 0 : a.confidence === "high" ? -1 : 1),
    );

    const annotated = await timed("annotate", timings, () =>
      annotate(captured.screenshot_path, findings, outDir, auditId),
    );

    const costUsd = log.totalCost(auditId);
    const resultsPath = await timed("render", timings, () =>
      renderResults(
        { capture: captured, findings, dropped, annotatedImage: annotated.path, timings, costUsd },
        outDir,
      ),
    );

    const total = timings.reduce((s, t) => s + t.ms, 0);
    const high = findings.filter((f) => f.confidence === "high").length;

    console.error(
      `\n  ${heuristics.findings.length} findings from the model` +
        ` -> ${findings.length} survived the confidence gate (${high} high, ${dropped.length} dropped)` +
        (severityAdjusted > 0 ? `\n  ${severityAdjusted} severity value(s) clamped onto the 1-4 scale` : "") +
        `\n  ${annotated.pinned} pinned on the screenshot` +
        `\n  total ${(total / 1000).toFixed(1)}s   $${costUsd.toFixed(4)}` +
        `\n\n  ${resultsPath}\n`,
    );

    if (findings.length === 0) {
      // Definition of done requires >=1 cited finding. Zero is a real result,
      // not a crash, but it should not read as success.
      process.exitCode = 1;
    }
  } catch (err) {
    if (err instanceof CaptureFailed) {
      // F1/F2: named state, honest message, never an audit from imagination.
      console.error(`\nCAPTURE_FAILED: ${err.message}\n  ${err.detail}\n`);
      process.exitCode = 1;
      return;
    }
    console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    log.close();
  }
}

await main();
