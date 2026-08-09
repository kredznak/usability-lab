import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { capture, CaptureFailed } from "./capture.js";
import { runSubAgent } from "./agents/runner.js";
import { rubricFor } from "./agents/rubrics.js";
import { runProfiler } from "./agents/profiler.js";
import { runSynthesizer, identify } from "./agents/synthesizer.js";
import { orchestrate } from "./orchestrator/index.js";
import { deriveSignals } from "./signals.js";
import { deriveConfidence } from "./confidence.js";
import { annotate } from "./annotate.js";
import { renderResults } from "./render.js";
import { CallLog } from "./db.js";
import { Finding, normalizeSeverity, type RawFinding } from "./types.js";
import { QUESTIONS, ContextProfile, type Answers } from "./profile.js";

/**
 * v0 slice 2 — one URL and five answers, end to end.
 *
 *   capture -> profile -> signals -> orchestrate (R0-R5, cap 4)
 *     -> sub-agents -> synthesize -> derived confidence -> annotate -> page
 *
 * Deliberately NOT here: Research and citations (every finding still reports
 * source_type "none", which §9.3 makes a legal output), the lint gate, the
 * Content agent, founder review, multi-page capture. See §0 of docs/design.md.
 */

interface Timing {
  step: string;
  ms: number;
}

async function timed<T>(step: string, timings: Timing[], fn: () => Promise<T>): Promise<T> {
  const started = Date.now();
  process.stderr.write(`  ${step.padEnd(14)} `);
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

/** §6: "max 2 sub-agents concurrent within one audit". */
const MAX_CONCURRENT_AGENTS = 2;

async function inPools<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return results;
}

async function collectAnswers(argv: string[]): Promise<Answers> {
  const fileFlag = argv.indexOf("--answers");
  if (fileFlag !== -1) {
    const file = argv[fileFlag + 1];
    if (!file) throw new Error("--answers needs a path to a JSON file");
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Answers;
    return parsed;
  }

  // Non-interactive with no answers file is a legitimate run: the profile comes
  // back empty and the spawn rules fall through to page signals alone.
  if (!process.stdin.isTTY) return {};

  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answers: Answers = {};
  process.stderr.write("\nFive questions. Press enter to skip any of them.\n\n");
  for (const q of QUESTIONS) {
    answers[q] = (await rl.question(`  ${q}\n  > `)).trim();
    process.stderr.write("\n");
  }
  rl.close();
  return answers;
}

/** With no answers to profile, we say so rather than inventing a profile. */
const EMPTY_PROFILE: ContextProfile = {
  site_kind: "other",
  concerns: [],
  goal: "unknown",
  drop_point: "unknown",
  summary: "No context was given, so this is a general review of the page.",
};

async function main(): Promise<void> {
  const url = process.argv[2];
  if (!url || url.startsWith("--")) {
    console.error("usage: npm run audit -- <url> [--answers answers.json]");
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

  const answers = await collectAnswers(process.argv.slice(2));

  // UUIDv7 is the correlation key in §8; v4 is a stand-in until we add a v7
  // generator. Either way it is the single ID threaded through every artifact.
  const auditId = randomUUID();
  const outDir = path.join("out", auditId);
  const timings: Timing[] = [];
  const log = new CallLog();
  /** §7: DEGRADED is a logged, visible state — never a quiet one. */
  const degraded: string[] = [];

  console.error(`\naudit ${auditId}\n${url}\n`);

  try {
    const client = new Anthropic();

    const captured = await timed("capture", timings, () => capture(url, auditId, outDir));
    const signals = deriveSignals(captured);

    const hasAnswers = Object.values(answers).some((a) => a && a.length > 0);
    const profile = hasAnswers
      ? (await timed("profile", timings, () => runProfiler(client, answers, auditId, log))).profile
      : EMPTY_PROFILE;

    const plan = await timed("orchestrate", timings, () =>
      orchestrate(client, profile, signals, auditId, log),
    );
    if (plan.override_rejected) degraded.push(`orchestrator: ${plan.override_rejected}`);

    console.error(
      `\n  spawning ${plan.spawn.join(", ")}` +
        plan.fired
          .filter((f) => plan.spawn.includes(f.agent))
          .map((f) => `\n    ${f.rule} ${f.agent.padEnd(17)} ${f.because}`)
          .join("") +
        plan.dropped.map((d) => `\n    -- ${d.agent.padEnd(17)} dropped: ${d.reason}`).join("") +
        `\n  ${plan.rationale}\n`,
    );

    // Reviewers never see each other's findings (§2 reach), so they are
    // genuinely independent and run concurrently — bounded by §6's limit of 2.
    const runs = await timed("review", timings, () =>
      inPools(plan.spawn, MAX_CONCURRENT_AGENTS, async (agent) => {
        try {
          return await runSubAgent(client, rubricFor(agent), captured, log);
        } catch (err) {
          // One reviewer failing must not discard the work of the others. The
          // audit continues without that lane and says so.
          degraded.push(
            `${agent} produced nothing: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { agent, findings: [] as RawFinding[], latencyMs: 0, costUsd: 0 };
        }
      }),
    );

    const identified = identify(runs);
    if (identified.length === 0) throw new Error("no reviewer produced a finding");

    const synthesis = await timed("synthesize", timings, () =>
      runSynthesizer(client, identified, profile.summary, auditId, log),
    );
    if (synthesis.degraded) degraded.push(`synthesizer: ${synthesis.degraded}`);

    // Confidence gate. Pure, synchronous, and the only place confidence is set —
    // re-derived here, after the merge, from the evidence rather than from
    // anything the Synthesizer decided (§9.1 over §2's roster line).
    const findings: Finding[] = [];
    const dropped: { reason: string; heuristic: string }[] = [];
    let severityAdjusted = 0;

    for (const m of synthesis.merged) {
      const verdict = deriveConfidence(m.finding, captured);
      if (verdict.kind === "drop") {
        dropped.push({ reason: verdict.reason, heuristic: m.finding.heuristic });
        continue;
      }
      const severity = normalizeSeverity(m.finding.severity);
      if (severity.adjusted) severityAdjusted++;

      findings.push(
        Finding.parse({
          ...m.finding,
          severity: severity.value,
          id: `${auditId}-f${findings.length + 1}`,
          agent: m.merged_from.join("+"),
          screen_ref: captured.screenshot_id,
          confidence: verdict.confidence,
          // Research lands in slice 3. Until then every finding is honestly
          // `none`, which §9.3 makes a legal, unpunished output.
          citation: { source_type: "none", url: null },
          evidence: { screenshot_id: captured.screenshot_id, bbox: verdict.bbox },
        }),
      );
    }

    // The Synthesizer ranked these against the visitor's concern, and that order
    // is preserved above. Positives move to the end so the audit does not open
    // on a compliment, but nothing else re-sorts what it decided.
    findings.sort((a, b) => Number(a.positive) - Number(b.positive));

    // §4 lists `findings` as a permanent store, and the outcome suite scores
    // saved findings rather than re-running paid audits. Writing the HTML alone
    // meant the only machine-readable record of an audit was its screenshot.
    await writeFile(
      path.join(outDir, "findings.json"),
      JSON.stringify(findings, null, 2),
      "utf8",
    );

    const annotated = await timed("annotate", timings, () =>
      annotate(captured.screenshot_path, findings, outDir, auditId),
    );

    const costUsd = log.totalCost(auditId);
    const resultsPath = await timed("render", timings, () =>
      renderResults(
        {
          capture: captured,
          findings,
          dropped,
          annotatedImage: annotated.path,
          timings,
          costUsd,
          profile,
          signals,
          plan,
          synthesis,
          degraded,
        },
        outDir,
      ),
    );

    const total = timings.reduce((s, t) => s + t.ms, 0);
    const high = findings.filter((f) => f.confidence === "high").length;

    console.error(
      `\n  ${identified.length} findings from ${plan.spawn.length} reviewers` +
        ` -> ${synthesis.merged.length} after synthesis (${synthesis.excluded.length} excluded)` +
        ` -> ${findings.length} survived the confidence gate (${high} high, ${dropped.length} dropped)` +
        (severityAdjusted > 0
          ? `\n  ${severityAdjusted} severity value(s) clamped onto the 1-4 scale`
          : "") +
        (synthesis.rejected.length > 0
          ? `\n  ${synthesis.rejected.length} synthesis reference(s) could not be honoured`
          : "") +
        `\n  ${annotated.pinned} pinned on the screenshot` +
        (degraded.length > 0 ? `\n  DEGRADED: ${degraded.join("; ")}` : "") +
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
