import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { capture, CaptureFailed } from "./capture.js";
import { runSubAgent } from "./agents/runner.js";
import { pageTiles } from "./agents/tiles.js";
import { rubricFor, RUBRICS } from "./agents/rubrics.js";
import { runProfiler } from "./agents/profiler.js";
import { runSynthesizer, identify } from "./agents/synthesizer.js";
import { runResearcher } from "./agents/researcher.js";
import { orchestrate } from "./orchestrator/index.js";
import { deriveSignals } from "./signals.js";
import { deriveConfidence } from "./confidence.js";
import { annotate } from "./annotate.js";
import { renderResults, renderPublic } from "./render.js";
import { lintAudit, quarantined } from "./lint.js";
import { disputedFindings } from "./publishing.js";
import { CallLog, AuditStore, EventLog, AuditRequestStore, type AuditStatus } from "./db.js";
import { OUT_ROOT } from "./paths.js";
import { ceilingFromEnv, spendLine, utcDay, verdict } from "./spend.js";
import { countingFetch } from "./http.js";
import { Finding, normalizeSeverity, type RawFinding, type ReviewRecord } from "./types.js";
import { QUESTIONS, ContextProfile, type Answers } from "./profile.js";

/**
 * v0 slice 2 — one URL and five answers, end to end.
 *
 *   capture -> profile -> signals -> orchestrate (R0-R5, cap 4)
 *     -> sub-agents -> synthesize -> derived confidence -> annotate -> page
 *
 * The run ends at AUTO_PUBLISHED, or at REVIEW_PENDING when something
 * mechanical disputes a finding — changed 2026-08-24, and it used to end at
 * REVIEW_PENDING always. The gate narrowed from "a person reads every audit" to
 * "a person reads the ones `claims.ts` can show are wrong about the page",
 * because that is the failure the gate actually caught: 10 of 165 findings cut,
 * and every written reason a count stated as fact and wrong.
 *
 * `npm run review <audit-id>` still publishes a held one, and is unchanged.
 *
 * Research runs on the survivors of synthesis and cites from a curated corpus
 * only (src/sources.ts). No web search: a source id resolves to a URL in code,
 * so a fabricated citation is not something the model has a field to express.
 *
 * Deliberately NOT here: web search and competitor examples, the lint gate, the
 * Content agent, multi-page capture, and any citation-based confidence boost.
 * See §0 of docs/design.md.
 */

interface Timing {
  step: string;
  ms: number;
}

/**
 * Every step is timed here, so every step is logged here.
 *
 * One call site covers capture, profile, orchestrate, review, synthesize,
 * research, annotate and render. Emitting from each step individually would
 * mean eight chances to forget one, and the step nobody remembered to
 * instrument would be the one that hung.
 *
 * The failure path emits too. B14 ran 27 minutes and reported success; the
 * steps worth seeing on a dashboard are precisely the ones that went wrong.
 */
async function timed<T>(
  step: string,
  timings: Timing[],
  fn: () => Promise<T>,
  events?: { log: EventLog; auditId: string },
): Promise<T> {
  const started = Date.now();
  process.stderr.write(`  ${step.padEnd(14)} `);
  try {
    const result = await fn();
    const ms = Date.now() - started;
    timings.push({ step, ms });
    events?.log.record({ audit_id: events.auditId, type: `step.${step}`, data: { ms, ok: true } });
    process.stderr.write(`${(ms / 1000).toFixed(1)}s\n`);
    return result;
  } catch (err) {
    const ms = Date.now() - started;
    events?.log.record({
      audit_id: events.auditId,
      type: `step.${step}`,
      data: { ms, ok: false, error: err instanceof Error ? err.message : String(err) },
    });
    process.stderr.write(`failed after ${(ms / 1000).toFixed(1)}s\n`);
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

/**
 * `npm run audit -- --queue` — run what the question flow asked for.
 *
 * The other half of "no HTTP request may spend money", and the same shape as
 * `reaudit --queue`: the form writes a row, a person (or, one day, a cron) runs
 * this. A stranger can fill the queue; only this can fill the bill.
 *
 * ## Why it shells out per request
 *
 * One crashed capture takes down one request rather than the queue, and the
 * definition of "an audit" stays in exactly one place — `main` below — rather
 * than being partly re-implemented here.
 *
 * ## Why the request is claimed before the audit runs
 *
 * `start` writes the audit id and returns false if somebody already claimed the
 * row, so two runners cannot buy the same audit twice. It also means a request
 * whose run dies is left pointing at the wreckage rather than looking untouched
 * and being picked up again — a URL that reliably kills a capture would
 * otherwise be retried on every pass, forever.
 */
function runQueue(): void {
  const asks = new AuditRequestStore();
  const pending = asks.queue();

  if (pending.length === 0) {
    console.log(`\nNothing queued. Audits are asked for from the question flow at \`/\`.\n`);
    asks.close();
    return;
  }

  console.error(`\n${pending.length} audit${pending.length === 1 ? "" : "s"} queued.\n`);
  let failed = 0;

  /**
   * F11's ceiling, re-read between audits rather than once at the top.
   *
   * A queue of thirty is thirty chances to cross it, and the whole point is to
   * stop at the crossing rather than after the last one. Reading it once would
   * make the guard depend on how much was already spent when the runner
   * happened to start.
   */
  const calls = new CallLog();
  const ceiling = ceilingFromEnv();
  let deferred = 0;
  const spentToday = () => verdict(calls.spentOn(utcDay(new Date())), ceiling);

  for (const [i, r] of pending.entries()) {
    const budget = spentToday();
    if (budget.stop) {
      // Not claimed, so the row keeps its place and tomorrow's run picks it up.
      deferred = pending.length - i;
      console.error(`\n${spendLine(budget)}\n`);
      break;
    }
    if (budget.warn) console.error(`  ${spendLine(budget)}`);

    const auditId = randomUUID();
    if (!asks.start(r.request_id, auditId)) {
      console.error(`  ${r.request_id.slice(0, 8)} was claimed by someone else; skipping.`);
      continue;
    }

    // The visitor's own words, on disk for as long as one subprocess takes to
    // read them. 0600 and removed in a `finally`, because "temporary" is a
    // property of the code that deletes it and not of the directory.
    const answersFile = path.join(tmpdir(), `ulab-answers-${r.request_id}.json`);
    writeFileSync(answersFile, r.answers, { mode: 0o600 });

    console.error(`\n─── ${r.request_id.slice(0, 8)}: ${r.url}  (asked ${r.requested_at.slice(0, 10)})\n`);
    try {
      execFileSync(
        "npm",
        ["run", "audit", "--", r.url, "--answers", answersFile, "--audit-id", auditId],
        { stdio: "inherit" },
      );
    } catch {
      failed += 1;
      console.error(`\n  ${r.request_id.slice(0, 8)} did not complete — see above.\n`);
    } finally {
      rmSync(answersFile, { force: true });
    }
  }

  const ran = pending.length - failed - deferred;
  console.log(
    `\n${ran} of ${pending.length} completed` +
      (failed > 0 ? `, ${failed} failed` : ``) +
      (deferred > 0 ? `, ${deferred} deferred to tomorrow` : ``) +
      `.\n` +
      `  Published audits still gate on \`npm run review\`.\n`,
  );
  calls.close();
  asks.close();
}

async function main(): Promise<void> {
  if (process.argv[2] === "--queue") return runQueue();

  const url = process.argv[2];
  if (!url || url.startsWith("--")) {
    console.error(
      "usage: npm run audit -- <url> [--answers answers.json] [--pin-to <audit-id>]\n" +
        "                            [--reaudit-of <audit-id>] [--audit-id <uuid>]\n" +
        "       npm run audit -- --queue",
    );
    process.exit(2);
  }
  try {
    new URL(url);
  } catch {
    console.error(`not a valid URL: ${url}`);
    process.exit(2);
  }

  /**
   * `--audit-id <uuid>` lets the caller name the audit before it exists.
   *
   * Only the queue runner passes it, and it needs to: a request row is stamped
   * with the audit id *before* the audit starts, so the visitor's status page
   * can answer "where is it" while the capture is still running. Minting the id
   * here and reporting it afterwards would leave that page blank for the two
   * minutes it matters most, and a runner that died mid-capture would leave a
   * row that looked untouched.
   *
   * Validated as a UUID rather than taken on trust: this becomes a directory
   * name under `out/` and a primary key, and "whatever the caller said" is not
   * a thing either of those should be.
   */
  const idFlag = process.argv.indexOf("--audit-id");
  const supplied = idFlag === -1 ? null : (process.argv[idFlag + 1] ?? null);
  if (supplied !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(supplied)) {
    console.error(`--audit-id must be a UUID`);
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
  const auditId = supplied ?? randomUUID();
  const outDir = path.join(OUT_ROOT, auditId);
  const timings: Timing[] = [];
  const log = new CallLog();
  const audits = new AuditStore();
  const events = new EventLog();
  /** §7: DEGRADED is a logged, visible state — never a quiet one. */
  const degraded: string[] = [];

  /**
   * `--reaudit-of` records which audit this one is a re-audit of.
   *
   * Deliberately separate from `--pin-to`, which they always travel together
   * with in practice. Pinning reviewer lanes and being a re-audit are two
   * different facts, and inferring one from the other would silently drop a
   * manually pinned experiment out of the eval set.
   */
  const reauditFlag = process.argv.indexOf("--reaudit-of");
  const baselineAuditId = reauditFlag === -1 ? null : (process.argv[reauditFlag + 1] ?? null);

  audits.create(auditId, url, baselineAuditId);
  events.record({ audit_id: auditId, type: "audit.requested", data: { url } });

  /**
   * `--pin-to <audit>` reuses that audit's reviewer lanes instead of deciding
   * fresh ones. See the note on `orchestrate`: two runs of the same page on the
   * same prompts drew two different lane sets, and a diff cannot tell "this is
   * new" from "nobody looked last time".
   *
   * Resolved before the run so an unknown id fails immediately, rather than
   * after a capture and a profile call have been paid for.
   */
  const pinFlag = process.argv.indexOf("--pin-to");
  let pinnedTo: { auditId: string; lanes: string[] } | undefined;
  if (pinFlag !== -1) {
    const prefix = process.argv[pinFlag + 1];
    const matches = prefix ? audits.find(prefix) : [];
    if (matches.length !== 1) {
      console.error(
        `--pin-to "${prefix ?? ""}" matched ${matches.length} audits; need exactly one.`,
      );
      process.exit(2);
    }
    const lanes = audits.lanesOf(matches[0]!.audit_id, Object.keys(RUBRICS));
    if (lanes.length === 0) {
      console.error(`${matches[0]!.audit_id.slice(0, 8)} ran no reviewers; nothing to pin to.`);
      process.exit(2);
    }
    pinnedTo = { auditId: matches[0]!.audit_id, lanes };
  }

  /**
   * Status is bookkeeping; the audit is the work. If the state machine refuses
   * an edge we want to hear about it loudly, but not by losing a $0.50 run that
   * already produced findings — so a failed transition is reported and the
   * pipeline continues.
   */
  const setStatus = (to: AuditStatus, fields = {}) => {
    try {
      audits.transition(auditId, to, fields);
    } catch (err) {
      degraded.push(`status ${to}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  console.error(`\naudit ${auditId}\n${url}\n`);

  try {
    // The counting fetch is the only reason B14 will explain itself next time:
    // SDK retries are invisible from the outside, and a step that silently
    // tried three times looks exactly like one slow call.
    const client = new Anthropic({ fetch: countingFetch() });

    setStatus("CAPTURING");
    const captured = await timed("capture", timings, () => capture(url, auditId, outDir), { log: events, auditId });

    /**
     * The five answers, kept with the audit.
     *
     * A re-audit has to ask the same question of the page as the audit it is
     * compared against, and the profile is built from these. Only
     * `profile_summary` was stored, which is the model's paraphrase — rebuilding
     * a profile from it would compare a page against a different brief and call
     * the difference a change in the site.
     */
    await writeFile(path.join(outDir, "answers.json"), JSON.stringify(answers, null, 2), "utf8");
    setStatus("AUDITING", { final_url: captured.final_url, title: captured.title });
    const signals = deriveSignals(captured);

    const hasAnswers = Object.values(answers).some((a) => a && a.length > 0);
    const profile = hasAnswers
      ? (await timed("profile", timings, () => runProfiler(client, answers, auditId, log), { log: events, auditId })).profile
      : EMPTY_PROFILE;

    const plan = await timed("orchestrate", timings, () =>
      orchestrate(client, profile, signals, auditId, log, pinnedTo),
      { log: events, auditId },
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

    // Cropped once for the whole fan-out. Every reviewer of this audit gets the
    // same slices, and the request marks them cached, so the images are written
    // to the cache once and read by the rest.
    const tiles = await pageTiles(captured);

    // Reviewers never see each other's findings (§2 reach), so they are
    // genuinely independent and run concurrently — bounded by §6's limit of 2.
    const runs = await timed("review", timings, () =>
      inPools(plan.spawn, MAX_CONCURRENT_AGENTS, async (agent) => {
        try {
          return await runSubAgent(client, rubricFor(agent), captured, log, tiles);
        } catch (err) {
          // One reviewer failing must not discard the work of the others. The
          // audit continues without that lane and says so.
          degraded.push(
            `${agent} produced nothing: ${err instanceof Error ? err.message : String(err)}`,
          );
          return { agent, findings: [] as RawFinding[], latencyMs: 0, costUsd: 0 };
        }
      }),
      { log: events, auditId },
    );

    const identified = identify(runs);
    if (identified.length === 0) throw new Error("no reviewer produced a finding");

    setStatus("RESEARCHING");

    const synthesis = await timed("synthesize", timings, () =>
      runSynthesizer(client, identified, profile.summary, auditId, log),
      { log: events, auditId },
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

    /**
     * Research runs on the findings that survived synthesis, not on the raw
     * reviewer output. §5's arrow order is `audit → research → assemble`, which
     * would research ~29 findings so that ~18 could use the result — about 40%
     * of the step's spend on findings nobody will ever read. Same output,
     * cheaper. The state machine's AUDITING → RESEARCHING → ASSEMBLING edges
     * are unchanged.
     *
     * A failure here costs citations, never the audit: every finding still
     * ships, honestly reporting `none`.
     */
    const research = await timed("research", timings, () =>
      runResearcher(client, findings, auditId, log),
      { log: events, auditId },
    );
    if (research.degraded) degraded.push(`research: ${research.degraded}`);
    const cited = research.findings;

    /**
     * The lint gate — §0's "research -> lint -> founder review".
     *
     * Deterministic, zero tokens, and it does not block: the gate is a person,
     * and lint's job is to put the things worth seeing in front of them before
     * they read thirteen findings in a row. The one exception is `echo` (F6),
     * where publishing a finding that repeats the page's instruction in its own
     * voice is worse than losing it.
     *
     * Measured over the whole corpus before shipping: **zero flags on 296
     * findings across 23 audits.** It is a guard, not a finder.
     */
    const lintFlags = lintAudit(cited, captured);
    const quarantine = quarantined(lintFlags);
    /**
     * Quarantined findings leave the publishable set here, before `annotate`,
     * so pin numbers stay positions in one array. They are not lost: their full
     * text is written to `lint.json` alongside the flag that removed them.
     */
    const publishable = cited.filter((f) => !quarantine.has(f.id));
    if (lintFlags.length > 0) {
      await writeFile(
        path.join(outDir, "lint.json"),
        JSON.stringify(
          { flags: lintFlags, quarantined: cited.filter((f) => quarantine.has(f.id)) },
          null,
          2,
        ),
        "utf8",
      );
      events.record({
        audit_id: auditId,
        type: "step.lint",
        data: { flags: lintFlags.length, quarantined: quarantine.size },
      });
      console.error(
        `\n  lint: ${lintFlags.length} flag(s)` +
          lintFlags.map((f) => `\n    ${f.rule.padEnd(10)} ${f.detail}`).join(""),
      );
      for (const f of lintFlags) degraded.push(`lint ${f.rule}: ${f.detail}`);
    }
    if (research.notes.length > 0) {
      await writeFile(
        path.join(outDir, "citations.json"),
        JSON.stringify(research.notes, null, 2),
        "utf8",
      );
    }

    setStatus("ASSEMBLING");

    // §4 lists `findings` as a permanent store, and the outcome suite scores
    // saved findings rather than re-running paid audits. Writing the HTML alone
    // meant the only machine-readable record of an audit was its screenshot.
    await writeFile(
      path.join(outDir, "findings.json"),
      JSON.stringify(publishable, null, 2),
      "utf8",
    );

    const annotated = await timed("annotate", timings, () =>
      annotate(captured.screenshot_path, publishable, outDir, auditId),
      { log: events, auditId },
    );

    const costUsd = log.totalCost(auditId);
    const resultsPath = await timed("render", timings, () =>
      renderResults(
        {
          capture: captured,
          // The founder's page shows what will be published, so pins on the
          // annotated image line up with the cards beside them.
          findings: publishable,
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
      { log: events, auditId },
    );

    events.record({
      audit_id: auditId,
      type: "audit.completed",
      data: {
        findings: findings.length,
        cost_usd: costUsd,
        total_ms: timings.reduce((n, t) => n + t.ms, 0),
        degraded: degraded.length,
      },
    });

    // Whether a person has to read this one — see publishing.ts for the rule
    // and the 165 decisions behind it. A held audit is delayed, not binned:
    // `npm run review` still publishes it.
    const disputed = disputedFindings(publishable, captured);

    if (disputed.length > 0) {
      setStatus("REVIEW_PENDING", {
        profile_summary: profile.summary,
        findings_total: findings.length,
        cost_usd: costUsd,
      });
    } else {
      /**
       * `published.ts` reads the kept set from `review.json` and never from
       * `findings.json`, and refuses to render without it. That rule is older
       * than this path and worth keeping, so the machine writes a review record
       * rather than routing around the one file that decides what a customer
       * sees.
       *
       * `decided_by: "auto"` is what stops it poisoning the corpus. These
       * decisions are not usefulness labels — they are "nothing mechanical
       * objected", which is a different claim and a unanimous one. Mixed into
       * the 165 human decisions they would read as perfect agreement and drown
       * the only signal B29 has. `corpus.ts` skips them.
       */
      const record: ReviewRecord = {
        audit_id: auditId,
        reviewed_at: new Date().toISOString(),
        decided_by: "auto",
        decisions: publishable.map((f) => ({
          finding_id: f.id,
          keep: true,
          severity_before: f.severity,
          severity_after: f.severity,
          note: null,
        })),
      };
      writeFileSync(path.join(outDir, "review.json"), JSON.stringify(record, null, 2) + "\n");

      await renderPublic(
        {
          capture: captured,
          kept: publishable,
          allFindings: publishable,
          annotatedImage: annotated.path,
          summary: profile.summary,
        },
        outDir,
      );

      setStatus("AUTO_PUBLISHED", {
        profile_summary: profile.summary,
        findings_total: findings.length,
        findings_published: publishable.length,
        cost_usd: costUsd,
      });
      events.record({
        audit_id: auditId,
        type: "audit.published",
        data: { kept: publishable.length, auto: true },
      });
    }

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
        `\n  ${research.cited} of ${cited.length} carry a citation` +
        (degraded.length > 0 ? `\n  DEGRADED: ${degraded.join("; ")}` : "") +
        `\n  total ${(total / 1000).toFixed(1)}s   $${costUsd.toFixed(4)}` +
        `\n\n  ${resultsPath}` +
        `\n\n  REVIEW_PENDING — nothing is published yet.` +
        `\n  npm run review -- ${auditId.slice(0, 8)}\n`,
    );

    if (findings.length === 0) {
      // Definition of done requires >=1 cited finding. Zero is a real result,
      // not a crash, but it should not read as success.
      process.exitCode = 1;
    }
  } catch (err) {
    // An audit that died is the most important row on a dashboard, so it is
    // recorded before the status transition rather than after.
    events.record({
      audit_id: auditId,
      type: "audit.failed",
      data: {
        error: err instanceof Error ? err.message : String(err),
        at_step: timings.length > 0 ? timings[timings.length - 1]!.step : "capture",
      },
    });
    if (err instanceof CaptureFailed) {
      // F1/F2: named state, honest message, never an audit from imagination.
      setStatus("CAPTURE_FAILED");
      console.error(`\nCAPTURE_FAILED: ${err.message}\n  ${err.detail}\n`);
      process.exitCode = 1;
      return;
    }
    setStatus("FAILED");
    console.error(`\nFAILED: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  } finally {
    log.close();
    audits.close();
    events.close();
  }
}

await main();
