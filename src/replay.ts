/**
 * `npm run research:replay` — re-run the citation step on findings we already have.
 *
 * ## Why this exists
 *
 * Thirteen sources were added on 2026-08-19 and nothing could say whether they
 * helped. The only way to find out was a full audit — ~$0.65, a fresh capture,
 * six reviewers and a synthesizer all re-rolled. That does not answer the
 * question: B15 measured this pipeline agreeing with itself about a third of
 * the time, so two full runs differ for reasons that have nothing to do with the
 * corpus. Comparing them would mostly measure the weather.
 *
 * So: hold the findings fixed, vary only the corpus. Same findings in, current
 * sources applied, one model call per audit.
 *
 * ## What it measures, and what it does not
 *
 * It measures **coverage** — how many findings can now be supported by something
 * we hold. It says nothing about whether the new citations are *good*, and those
 * are not the same question. A badly-fitting source raises coverage and makes
 * the audit worse, which quality-bar.md calls the worst thing this product can
 * publish. That is why every new citation is printed with the `why` sentence
 * that justified it: **the number is not the deliverable, the `why` lines are.**
 *
 * ## Why it writes nowhere near the originals
 *
 * `citations.json` is the baseline this is compared against, and it is also the
 * evidence that produced six of the thirteen new sources. Overwriting it to
 * measure it would destroy the measurement. Replays land in
 * `out/<audit>/replays/<label>.json` and nothing else is touched — no page is
 * re-rendered, no finding is edited, no audit status moves.
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import Anthropic from "@anthropic-ai/sdk";
import { runResearcher } from "./agents/researcher.js";
import { Finding } from "./types.js";
import { CallLog, AuditStore } from "./db.js";
import { SOURCES, sourceById } from "./sources.js";
import { OUT_ROOT } from "./paths.js";

const BOLD = "\x1b[1m";
const DIM = "\x1b[2m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";
const RESET = "\x1b[0m";

interface Baseline {
  finding_id: string;
  source_id: string | null;
  why: string;
}

interface ReplayRow {
  audit_id: string;
  url: string;
  findings: number;
  /** Citations as originally recorded, for the before/after. */
  before: { cited: number; total: number };
  after: { cited: number; total: number };
  /** Only the ones that changed — the lines a person has to read. */
  gained: { finding_id: string; heuristic: string; source_id: string; why: string }[];
  lost: { finding_id: string; heuristic: string; was: string; why: string }[];
  degraded: string | null;
  costUsd: number;
}

/**
 * Audits whose research step ran and returned — and which the corpus scores.
 *
 * Two filters, and the second one is the load-bearing one.
 *
 * **Research must have returned.** Anything else has no baseline: an audit that
 * predates Research has no `citations.json`, and one whose step crashed has a
 * file full of nothing. Both would show a spectacular improvement from zero.
 *
 * **The corpus's own exclusions apply.** `npm run outcome` skips audits retired
 * as FAILED and skips re-audits, and the number this replay is compared against
 * is *that* number. Replaying a superset would produce a before/after against a
 * baseline computed over a different population — arithmetic that looks fine and
 * answers nothing.
 *
 * This is not hypothetical. The first run of this script picked up twelve audits
 * where the corpus holds six, including two Cotopaxi runs retired on 2026-08-16
 * for resting on a broken capture. `corpus.ts` already carries the lesson: those
 * runs scored **0 false**, because a capture that lost half the page reads as a
 * clean audit and quietly raises whatever you are measuring.
 */
function replayable(): { auditId: string; dir: string }[] {
  const store = new AuditStore();
  const out: { auditId: string; dir: string }[] = [];
  try {
    const retired = new Set(
      (["FAILED", "CAPTURE_FAILED"] as const).flatMap((s) => store.list(s).map((r) => r.audit_id)),
    );
    for (const row of store.list()) {
      if (retired.has(row.audit_id)) continue;
      // A re-audit is monitoring, not eval data — Kelly's call, 2026-08-17.
      if (row.baseline_audit_id) continue;
      if (store.researchOutcome(row.audit_id) !== "ok") continue;
      const dir = path.join(OUT_ROOT, row.audit_id);
      if (!existsSync(path.join(dir, "findings.json"))) continue;
      if (!existsSync(path.join(dir, "citations.json"))) continue;
      out.push({ auditId: row.audit_id, dir });
    }
  } finally {
    store.close();
  }
  return out;
}

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const labelArg = args.indexOf("--label");
const label = labelArg >= 0 ? args[labelArg + 1] : "replay";
const only = args.find((a) => !a.startsWith("--") && a !== label);

let targets = replayable();
if (only) targets = targets.filter((t) => t.auditId.startsWith(only));

if (targets.length === 0) {
  console.error("No replayable audits. Needs findings.json, citations.json, and a research call that returned.");
  process.exit(1);
}

console.log(
  `\n${BOLD}Research replay${RESET} ${DIM}· ${targets.length} audit(s) · ${SOURCES.length} sources · label "${label}"${RESET}\n`,
);

if (dryRun) {
  // Spends nothing, on purpose. `npm run audit` and `npm run reaudit` both have
  // the same rule (B20): a person should be able to see what a run would do
  // before it costs anything.
  for (const { auditId, dir } of targets) {
    const findings = JSON.parse(readFileSync(path.join(dir, "findings.json"), "utf8")) as unknown[];
    const before = JSON.parse(readFileSync(path.join(dir, "citations.json"), "utf8")) as Baseline[];
    const cited = before.filter((b) => b.source_id !== null).length;
    console.log(
      `  ${auditId.slice(0, 8)}  ${findings.length} findings  ` +
        `baseline ${cited}/${before.length} cited  ${DIM}-> 1 research call${RESET}`,
    );
  }
  console.log(`\n${DIM}--dry-run: nothing was sent and nothing was spent.${RESET}\n`);
  process.exit(0);
}

if (!process.env.ANTHROPIC_API_KEY) {
  console.error("ANTHROPIC_API_KEY is not set.");
  process.exit(1);
}

const client = new Anthropic();
const log = new CallLog();
const rows: ReplayRow[] = [];

for (const { auditId, dir } of targets) {
  const findings = (JSON.parse(readFileSync(path.join(dir, "findings.json"), "utf8")) as unknown[]).map(
    (f) => Finding.parse(f),
  );
  const baseline = JSON.parse(readFileSync(path.join(dir, "citations.json"), "utf8")) as Baseline[];
  const wasCited = new Map(baseline.map((b) => [b.finding_id, b.source_id]));

  const capturePath = path.join(dir, "capture.json");
  const url = existsSync(capturePath)
    ? (JSON.parse(readFileSync(capturePath, "utf8")) as { final_url?: string }).final_url ?? "?"
    : "?";

  process.stdout.write(`  ${auditId.slice(0, 8)}  ${url.slice(0, 44).padEnd(44)} `);

  /**
   * `auditId` is passed through so the call lands in `model_calls` under the
   * audit it belongs to — the replay's spend is real spend and §4 says log every
   * call from run 1. It does not change the audit's own research outcome,
   * because `researchOutcome` asks whether *any* researcher call succeeded and
   * the original already did.
   */
  const result = await runResearcher(client, findings, auditId, log);

  const byId = new Map(findings.map((f) => [f.id, f]));
  const gained: ReplayRow["gained"] = [];
  const lost: ReplayRow["lost"] = [];

  for (const note of result.notes) {
    const before = wasCited.get(note.finding_id) ?? null;
    const heuristic = byId.get(note.finding_id)?.heuristic ?? "?";
    if (!before && note.source_id) {
      gained.push({ finding_id: note.finding_id, heuristic, source_id: note.source_id, why: note.why });
    } else if (before && !note.source_id) {
      lost.push({ finding_id: note.finding_id, heuristic, was: before, why: note.why });
    }
  }

  const beforeCited = baseline.filter((b) => b.source_id !== null).length;
  rows.push({
    audit_id: auditId,
    url,
    findings: findings.length,
    before: { cited: beforeCited, total: baseline.length },
    after: { cited: result.cited, total: findings.length },
    gained,
    lost,
    degraded: result.degraded,
    costUsd: result.costUsd,
  });

  const delta = result.cited - beforeCited;
  console.log(
    `${beforeCited}/${baseline.length} -> ${result.cited}/${findings.length}  ` +
      `${delta > 0 ? GREEN : delta < 0 ? YELLOW : DIM}${delta >= 0 ? "+" : ""}${delta}${RESET}` +
      (result.degraded ? `  ${YELLOW}DEGRADED: ${result.degraded}${RESET}` : ""),
  );

  const replayDir = path.join(dir, "replays");
  mkdirSync(replayDir, { recursive: true });
  writeFileSync(
    path.join(replayDir, `${label}.json`),
    JSON.stringify({ label, sources: SOURCES.length, notes: result.notes }, null, 2) + "\n",
  );
}

log.close();

const before = rows.reduce((n, r) => n + r.before.cited, 0);
const beforeTotal = rows.reduce((n, r) => n + r.before.total, 0);
const after = rows.reduce((n, r) => n + r.after.cited, 0);
const afterTotal = rows.reduce((n, r) => n + r.after.total, 0);
const cost = rows.reduce((n, r) => n + r.costUsd, 0);

const pct = (n: number, d: number) => (d === 0 ? "n/a" : `${((100 * n) / d).toFixed(1)}%`);

console.log(
  `\n${BOLD}uncited${RESET}  ` +
    `${pct(beforeTotal - before, beforeTotal)} (${beforeTotal - before}/${beforeTotal})` +
    `  ->  ${BOLD}${pct(afterTotal - after, afterTotal)} (${afterTotal - after}/${afterTotal})${RESET}` +
    `\n${DIM}$${cost.toFixed(4)} across ${rows.length} call(s)${RESET}\n`,
);

/**
 * The part that matters more than the number.
 *
 * A citation that does not support the finding it is attached to is worse than
 * no citation. Coverage cannot tell the difference, so every gained citation is
 * printed with the sentence the model said does the work — and a person reads
 * them before any of this is called an improvement.
 */
const allGained = rows.flatMap((r) => r.gained);
if (allGained.length > 0) {
  console.log(`${BOLD}${allGained.length} newly cited — read these, the number does not check them${RESET}\n`);
  for (const g of allGained) {
    const source = sourceById(g.source_id);
    console.log(`  ${GREEN}+${RESET} ${g.heuristic}`);
    console.log(`    ${DIM}${g.source_id}${source ? ` — ${source.title}` : `  ${YELLOW}(NOT IN TABLE)${RESET}`}${RESET}`);
    console.log(`    ${g.why.slice(0, 300)}\n`);
  }
}

const allLost = rows.flatMap((r) => r.lost);
if (allLost.length > 0) {
  // Losses are as interesting as gains: a finding that was cited and now is not
  // means either the model changed its mind or a better-fitting row displaced a
  // stretch. Both are worth seeing.
  console.log(`${YELLOW}${allLost.length} citation(s) lost${RESET}\n`);
  for (const l of allLost) {
    console.log(`  ${YELLOW}-${RESET} ${l.heuristic}  ${DIM}was ${l.was}${RESET}`);
    console.log(`    ${l.why.slice(0, 300)}\n`);
  }
}

console.log(`${DIM}Written to out/<audit>/replays/${label}.json — nothing else was touched.${RESET}\n`);
