import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { AuditStore, EventLog } from "./db.js";
import { OUT_ROOT } from "./paths.js";
import {
  Capture,
  Finding,
  normalizeSeverity,
  type ReviewDecision,
  type ReviewRecord,
} from "./types.js";
import { renderPublic, locationLine, FREE_FINDINGS } from "./render.js";
import { checkClaim } from "./claims.js";

/**
 * `npm run review <audit-id>` — the founder gate. §6's REVIEW_PENDING → PUBLISHED,
 * and CLAUDE.md's "first audits gate on founder review".
 *
 *   npm run review                 # list what is waiting
 *   npm run review -- 1e6d5d13     # review one audit (id prefix)
 *
 * Keep or cut each finding, adjust severity where the reviewers got it wrong,
 * then publish. Nothing reaches a visitor without passing through here.
 *
 * ## Why the decisions are also labels
 *
 * "Would a founder change something because of this?" is the question the
 * outcome suite cannot answer mechanically, and the one that decides whether the
 * product is worth paying for. It is also *exactly* the judgment being made at
 * this gate. So keep/cut is written to `review.json` and read by
 * `npm run corpus` as the usefulness label — the eval set grows as a byproduct
 * of shipping rather than as a separate chore nobody does.
 *
 * A cut is not an accusation of falsehood. A finding can be perfectly true and
 * still not worth a visitor's attention; that distinction is why truth and
 * usefulness are separate fields, and why a cut reason is worth typing.
 */

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

function wrap(text: string, width = 74, indent = "  "): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else {
      line += " " + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.map((l) => indent + l).join("\n");
}

const store = new AuditStore();
const events = new EventLog();

const args = process.argv.slice(2);
const prefix = args.find((a) => !a.startsWith("--"));

if (!prefix) {
  const waiting = store.list("REVIEW_PENDING");
  if (waiting.length === 0) {
    console.log("\nNothing is waiting for review.\n");
  } else {
    console.log(`\n${BOLD}${waiting.length} audit(s) awaiting review${RESET}\n`);
    for (const a of waiting) {
      console.log(
        `  ${a.audit_id.slice(0, 8)}  ${String(a.findings_total).padStart(3)} findings  ` +
          `$${a.cost_usd.toFixed(2).padStart(5)}  ${a.url}`,
      );
    }
    console.log(`\n  npm run review -- ${waiting[0]!.audit_id.slice(0, 8)}\n`);
  }
  store.close();
  process.exit(0);
}

const matches = store.find(prefix);
if (matches.length === 0) {
  console.error(`No audit starts with "${prefix}".`);
  store.close();
  process.exit(2);
}
if (matches.length > 1) {
  console.error(`"${prefix}" matches ${matches.length} audits. Use more characters.`);
  store.close();
  process.exit(2);
}

const audit = matches[0]!;
if (audit.status !== "REVIEW_PENDING") {
  // Reviewing a published audit would silently rewrite what a visitor has
  // already seen. The correction path for that is still UNRESOLVED in
  // quality-bar.md, and guessing at it here would be worse than refusing.
  console.error(
    `\nAudit ${audit.audit_id.slice(0, 8)} is ${audit.status}, not REVIEW_PENDING.` +
      (audit.status === "PUBLISHED"
        ? `\nIt has already been published. Re-reviewing would rewrite what the visitor saw.\n` +
          `To fix a published page and say so, use the correction path (B5):\n` +
          `  npm run correct -- ${audit.audit_id.slice(0, 8)} "what changed and why"\n`
        : `\n`),
  );
  store.close();
  process.exit(2);
}

/**
 * `--decline=<reason>` — the gate's only other way out.
 *
 * Until 2026-08-23 REVIEW_PENDING led to PUBLISHED and nowhere else, so an
 * audit the founder did not want published had no state to be in. Leaving it
 * pending recorded nothing and kept it in this queue forever; FAILED was the
 * only reachable terminal state and would have been a lie, since the audit
 * worked. `2ae5a280` — myschools.nyc, a public school enrolment service — is
 * the one that made the gap real.
 *
 * A flag and not a prompt. The refusal is about the audit, not its findings,
 * and making someone answer eleven keep/cut questions to reach a publish
 * prompt they already intend to refuse is the friction the resume path exists
 * to remove. It also means no keep/cut labels are invented for findings nobody
 * judged.
 *
 * The reason is required. B29 measured the alternative: the optional reason
 * offered on every cut has been used zero times in 115 decisions. An optional
 * one here would go the same way, and DECLINED would then say no more than
 * leaving the audit pending already did.
 */
const declineArg = args.find((a) => a === "--decline" || a.startsWith("--decline="));
if (declineArg) {
  const reason = declineArg.slice("--decline".length).replace(/^=/, "").trim();
  const short = audit.audit_id.slice(0, 8);

  if (!reason) {
    console.error(
      `\nDeclining ${short} needs a reason.\n\n` +
        `  npm run review -- ${short} --decline="why this should not be published"\n\n` +
        `  ${DIM}The reason is the point. DECLINED without one says no more than` +
        ` leaving it pending already did.${RESET}\n`,
    );
    store.close();
    events.close();
    process.exit(2);
  }

  store.transition(audit.audit_id, "DECLINED");
  events.record({
    audit_id: audit.audit_id,
    type: "review.declined",
    data: { reason, findings: audit.findings_total },
  });
  store.close();
  events.close();

  console.log(
    `\n${YELLOW}DECLINED${RESET}  ${audit.url}\n` +
      `  ${DIM}${short} — ${audit.findings_total} findings, none published, none labelled.${RESET}\n\n` +
      `  ${reason}\n\n` +
      `  ${DIM}Terminal. It will not appear in this queue again, and there is no` +
      ` path back to PUBLISHED.${RESET}\n`,
  );
  process.exit(0);
}

const dir = path.join(OUT_ROOT, audit.audit_id);
const findingsFile = path.join(dir, "findings.json");
if (!existsSync(findingsFile)) {
  console.error(`No findings.json in ${dir}. The audit did not get far enough to review.`);
  store.close();
  process.exit(2);
}

const findings = (JSON.parse(readFileSync(findingsFile, "utf8")) as unknown[]).map((f) =>
  Finding.parse(f),
);
const capture = Capture.parse(JSON.parse(readFileSync(path.join(dir, "capture.json"), "utf8")));

/**
 * Answers come from a person at a terminal, or from a pipe.
 *
 * readline cannot do the second one. On a non-TTY stream it emits a `line` for
 * every buffered row the moment input arrives; `rl.question()` takes the next
 * one and the rest are dropped on the floor, then the stream closes. Piping 17
 * answers in got exactly one recorded and the other sixteen discarded — safe,
 * because a partial review refuses to publish, but silent about why.
 *
 * So piped input is read whole, up front, and served from a queue. That also
 * makes the gate scriptable — there is no end-to-end test of the publish path
 * yet, and this is what one would be built on. See docs/backlog.md B4.
 */
const piped = !process.stdin.isTTY;
const queued: string[] = piped ? readFileSync(0, "utf8").split("\n") : [];
const rl = piped ? null : createInterface({ input: process.stdin, output: process.stdout });

let closed = false;
rl?.on("close", () => {
  closed = true;
});

/** See label.ts — rl.question never settles once stdin closes, losing the session. */
async function ask(prompt: string): Promise<string | null> {
  if (piped) {
    const next = queued.shift();
    if (next === undefined) return null;
    // Echo, so a piped run reads back as the conversation it stands in for.
    process.stdout.write(`${prompt}${next}\n`);
    return next;
  }
  if (closed || !rl) return null;
  return Promise.race([
    rl.question(prompt),
    new Promise<null>((resolve) => rl.once("close", () => resolve(null))),
  ]);
}

/**
 * B29. The reason a cut or a severity change cannot be recorded without.
 *
 * The gate's own docstring called a cut reason "the only record of why", and
 * for the first 115 decisions that record was empty — not because reviewers
 * refused, but because `Enter` alone kept and asked nothing, so the cheapest
 * keystroke was also the least informative one.
 *
 * Blocking outright would extract "bad" from someone who has no words to hand,
 * and a corpus of "bad" is worse than silence because it looks like signal. So
 * a dash is an answer: it records that the question was asked and declined,
 * which is a thing the data can currently never say.
 */
async function reasonFor(what: string): Promise<{ note: string | null; declined: boolean } | null> {
  for (;;) {
    const answer = await ask(
      `  ${YELLOW}Why ${what}?${RESET} ${DIM}(a dash records that you would rather not say)${RESET}\n  > `,
    );
    if (answer === null) return null;
    const text = answer.trim();
    if (text === "-") return { note: null, declined: true };
    if (text) return { note: text, declined: false };
    console.log(`  ${DIM}A reason, or - to decline. This is the only record of why.${RESET}`);
  }
}

/**
 * Lint flags first, before any finding.
 *
 * They are the reason lint runs before this gate rather than after it: a
 * reviewer reading thirteen findings in a row should know up front if one of
 * them addressed them as having failed, or if the audit found nothing good to
 * say. Quarantined findings are already gone by this point and are recorded in
 * lint.json, so nothing here can restore them.
 */
const lintFile = path.join(dir, "lint.json");
if (existsSync(lintFile)) {
  const { flags } = JSON.parse(readFileSync(lintFile, "utf8")) as {
    flags: { rule: string; detail: string; quarantine: boolean }[];
  };
  console.log(
    `\n${YELLOW}${flags.length} lint flag(s)${RESET}` +
      flags
        .map((f) => `\n  ${f.quarantine ? `${RED}quarantined${RESET} ` : ""}${f.rule}: ${f.detail}`)
        .join("") +
      `\n`,
  );
}

/**
 * A saved review, offered back instead of thrown away.
 *
 * `review.json` is written before the publish prompt so that answering "not
 * yet" keeps every judgment. Until now there was no way to *use* what it kept:
 * the only route to publishing was to answer all of them again from the top.
 * That made hesitating expensive, which is backwards for a gate whose whole
 * purpose is unhurried judgment — on a fifteen-finding audit, "let me think"
 * cost a re-read of all fifteen.
 *
 * It also emitted a second `review.decided` for one review. `funnelStages()`
 * counts distinct audit ids and survives that (it is the 200%-of-requested bug
 * its own comment describes), but §8's founder-review reject rate is a sum over
 * these rows and would not. So publishing saved decisions records nothing new:
 * the sitting that made them already spoke.
 *
 * Labels are only offered back if they describe *these* findings. Re-running an
 * audit rewrites findings.json with fresh ids, and publishing decisions about
 * findings that no longer exist would be worse than asking again.
 */
const reviewFile = path.join(dir, "review.json");
let saved: ReviewRecord | null = null;

if (existsSync(reviewFile)) {
  const parsed = JSON.parse(readFileSync(reviewFile, "utf8")) as ReviewRecord;
  const already = new Set(parsed.decisions.map((d) => d.finding_id));
  if (already.size === findings.length && findings.every((f) => already.has(f.id))) {
    saved = parsed;
  } else {
    console.log(
      `\n${YELLOW}A saved review is on disk, but it does not describe these findings.${RESET}\n` +
        `  ${DIM}It decided ${parsed.decisions.length}; there are ${findings.length} here.` +
        ` Ignoring it and asking again.${RESET}\n`,
    );
  }
}

/** Set only by an explicit `p`. Any other key redoes the review from the top. */
let publishSaved = false;

if (saved) {
  const keptBefore = saved.decisions.filter((d) => d.keep).length;
  const cutBefore = saved.decisions.length - keptBefore;
  const movedBefore = saved.decisions.filter((d) => d.severity_after !== d.severity_before).length;

  console.log(
    `\n${BOLD}${audit.url}${RESET}\n` +
      `${DIM}${audit.audit_id}${RESET}\n\n` +
      `  ${GREEN}You have already reviewed this.${RESET}  ${keptBefore} kept, ${cutBefore} cut` +
      `${movedBefore > 0 ? `, ${movedBefore} severity adjusted` : ""}\n` +
      `  ${DIM}decided ${saved.reviewed_at}${RESET}\n\n` +
      `  ${GREEN}p${RESET} publish those decisions     ` +
      `${YELLOW}r${RESET} redo the review from the top     ${DIM}q${RESET} quit\n`,
  );

  const answer = await ask(`  > `);
  const key = (answer ?? "q").trim().charAt(0).toLowerCase();

  if (answer === null || key === "q") {
    rl?.close();
    console.log(`\n  Nothing changed. The audit is still REVIEW_PENDING.\n`);
    store.close();
    process.exit(0);
  }

  publishSaved = key === "p";
}

if (!publishSaved) {
  console.log(
    `\n${BOLD}${audit.url}${RESET}\n` +
      `${DIM}${audit.audit_id} · ${findings.length} findings · $${audit.cost_usd.toFixed(2)}${RESET}\n\n` +
      (audit.profile_summary ? `${wrap(audit.profile_summary, 74, "  ")}\n\n` : "") +
      `  ${GREEN}k${RESET} keep     ${RED}c${RESET} cut     ${YELLOW}1-4${RESET} keep at that severity     ` +
      `${DIM}q${RESET} quit without publishing\n` +
      `  ${DIM}Enter alone keeps. Add a reason after the letter: ${RESET}c true but nobody would act\n` +
      `  ${DIM}A cut or a severity change asks for a reason if you did not type one.${RESET}\n\n` +
      `  ${DIM}Keep/cut is also the usefulness label — the question is whether a founder\n` +
      `  would change something because of this, not whether it is true.${RESET}\n`,
  );
}

const decisions: ReviewDecision[] = publishSaved ? saved!.decisions : [];
let quit = false;

/** Empty when publishing a saved review: the answers are already in hand. */
const toAsk = publishSaved ? [] : [...findings.entries()];

for (const [i, f] of toAsk) {
  console.log(
    `${DIM}${"─".repeat(78)}${RESET}\n` +
      `${DIM}[${i + 1}/${findings.length}]${RESET} ${BOLD}${f.heuristic}${RESET}\n` +
      `${DIM}severity ${f.severity} · ${f.confidence} confidence · ${f.agent}` +
      `${f.positive ? ` · ${GREEN}positive${RESET}${DIM}` : ""}${RESET}\n`,
  );
  console.log(wrap(f.observation));
  console.log(`\n${DIM}${wrap(f.impact_note)}${RESET}`);
  console.log(`\n${DIM}${wrap(`Location: ${locationLine(f, capture)}`)}${RESET}`);

  /**
   * B30. The cited element's rendered name, shown only when it carries text the
   * capture could not — which is exactly when verifying against `capture.json`
   * would mislead you.
   *
   * This exists because of a near miss. `2928c314` finding 13 quoted a live
   * counter; `capture.json` had the sentence and no number, so the finding read
   * as unsupported and was one keystroke from being cut. It was true — the
   * digits live in a closed shadow root and reach the screenshot but not the
   * DOM. The line below is what would have said so without opening the PNG.
   */
  const citedEl = f.element_ref
    ? capture.elements.find((e) => e.ref === f.element_ref)
    : undefined;
  if (citedEl?.rendered_name) {
    console.log(
      `\n${YELLOW}${wrap(
        `Rendered: “${citedEl.rendered_name}” — the browser reports text here that ` +
          `the capture could not read. Check the screenshot, not capture.json.`,
      )}${RESET}`,
    );
  }

  // B29. Timed from the prompt, not from the print above it: what is being
  // measured is the pause before the judgment, not how fast a terminal draws.
  const askedAt = Date.now();
  /**
   * B32. What the capture says about the finding's own assertions, at the
   * moment the decision is made.
   *
   * `checkClaim` has existed since the first false positives and was imported
   * by exactly one file — `corpus.ts`, an offline builder. It had never run
   * during an audit or at this gate, which is why the four numeric errors a
   * founder has caught here were all caught by counting them by hand.
   *
   * Shown as data, never as a verdict. One of these lines is a known false
   * alarm: a finding quoting basecamp's live counter reads as contradicted
   * because the digits live in a closed shadow root, and the `Rendered:` line
   * immediately above exists to say so. Measured on every audit on disk, this
   * prints on about 4% of findings.
   */
  const failed = checkClaim(f, capture).checks.filter((c) => !c.ok);
  if (failed.length > 0) {
    console.log(
      `\n${YELLOW}  Checked against the capture — what the data holds, not a verdict:${RESET}\n` +
        failed.map((c) => `${YELLOW}${wrap(`· ${c.detail}`, 72, "    ")}${RESET}`).join("\n"),
    );
  }

  const answer = await ask(`\n  ${BOLD}Keep it?${RESET}\n  > `);
  const ms = Date.now() - askedAt;
  if (answer === null) {
    quit = true;
    break;
  }

  const raw = answer.trim();
  const key = raw.charAt(0).toLowerCase();
  let note = raw.slice(1).trim() || null;

  if (key === "q") {
    quit = true;
    break;
  }

  const severity = /^[1-4]$/.test(key) ? normalizeSeverity(Number(key)).value : f.severity;
  const keep = key !== "c";
  const moved = severity !== f.severity;

  /**
   * The two informative actions, and the only two that are asked about. Keeps
   * stay a single keystroke — 155 of the first 165 decisions were keeps, and
   * making the common path expensive buys noise, not signal.
   *
   * Typing the severity it already had is not a change and is not questioned.
   */
  let declined = false;
  if ((!keep || moved) && !note) {
    const given = await reasonFor(keep ? `severity ${f.severity} -> ${severity}` : "cut");
    if (given === null) {
      quit = true;
      break;
    }
    note = given.note;
    declined = given.declined;
  }

  decisions.push({
    finding_id: f.id,
    keep,
    severity_before: f.severity,
    severity_after: severity,
    note,
    // Omitted rather than false, so a keep records exactly what it did before.
    ...(declined ? { reason_declined: true } : {}),
    ms,
  });
  console.log(
    `${DIM}  ${keep ? "kept" : "cut"}${moved ? `, severity ${f.severity} -> ${severity}` : ""}${RESET}\n`,
  );
}

if (quit && decisions.length < findings.length) {
  rl?.close();
  // A partial review cannot publish: the findings never reached would be
  // silently dropped, which looks identical to a deliberate cut.
  console.log(
    `\n${YELLOW}Stopped after ${decisions.length} of ${findings.length}.${RESET}\n` +
      `  Nothing was published and nothing was saved — the audit is still REVIEW_PENDING.\n` +
      `  Run the same command again to start over.\n`,
  );
  store.close();
  process.exit(0);
}

const decided = new Map(decisions.map((d) => [d.finding_id, d]));
const kept = findings
  .filter((f) => decided.get(f.id)?.keep)
  .map((f) => {
    const d = decided.get(f.id)!;
    return d.severity_after === f.severity ? f : Finding.parse({ ...f, severity: d.severity_after });
  });

const cut = findings.length - kept.length;
const adjusted = decisions.filter((d) => d.severity_after !== d.severity_before).length;
const keptIssues = kept.filter((f) => !f.positive);

console.log(
  `\n${BOLD}${kept.length} kept, ${cut} cut${adjusted > 0 ? `, ${adjusted} severity adjusted` : ""}.${RESET}\n` +
    `  The visitor's page will show ${Math.min(FREE_FINDINGS, keptIssues.length)} of ` +
    `${keptIssues.length} issues, and say how many are held back.\n`,
);

/**
 * Saved before the publish prompt, not after.
 *
 * These decisions are the usefulness labels — the reason the gate was built
 * ahead of Research. Writing them only on publish meant a founder could judge
 * every finding, answer "not yet", and lose the lot. Deciding not to publish is
 * a judgment about the audit; it says nothing about whether the seventeen calls
 * just made were right.
 */
if (!publishSaved) {
  const record: ReviewRecord = {
    audit_id: audit.audit_id,
    reviewed_at: new Date().toISOString(),
    // Said explicitly now that a machine can write this file too. Records
    // before 2026-08-24 carry no field and are read as founder, which they were.
    decided_by: "founder",
    decisions,
  };
  writeFileSync(reviewFile, JSON.stringify(record, null, 2) + "\n");

  /**
   * The gate is the only step where a person's judgment enters, and until now it
   * left no trace outside review.json. Kept/cut counts are what "founder-review
   * reject rate" in §8's quality dashboard is made of — which is why publishing
   * an already-recorded review does not run this again.
   */
  events.record({
    audit_id: audit.audit_id,
    type: "review.decided",
    data: {
      kept: kept.length,
      cut,
      adjusted,
      findings: findings.length,
      // B29. Counts, not text — the reasons themselves stay in review.json.
      // A session that cut three findings and explained none is the shape the
      // funnel should be able to show without opening a file.
      reasons: decisions.filter((d) => d.note && d.note.trim()).length,
      declined: decisions.filter((d) => d.reason_declined).length,
    },
  });
}

// Reuses the one interface rather than opening a second. A fresh readline over
// an already-ended stdin never resolves, so a piped review would hang here at
// the last question — after every judgment had been made and none saved.
//
// `p` was already the answer to this question. Asking it twice for one intent
// is the friction this branch exists to remove.
const go = publishSaved
  ? "y"
  : ((await ask(`  ${BOLD}Publish?${RESET} (y/N) > `)) ?? "").trim().toLowerCase();
rl?.close();

if (go !== "y") {
  console.log(
    `\n  Not published. The audit is still REVIEW_PENDING.\n` +
      `  ${DIM}${decisions.length} decisions saved to review.json — run the same command` +
      ` again to redo them.${RESET}\n`,
  );
  store.close();
  process.exit(0);
}

const publicPath = await renderPublic(
  {
    capture,
    kept,
    allFindings: findings,
    annotatedImage: path.join(dir, `${audit.audit_id}-annotated.png`),
    summary: audit.profile_summary ?? "A review of this page.",
    decidedBy: "founder",
  },
  dir,
);

store.transition(audit.audit_id, "PUBLISHED", { findings_published: kept.length });
events.record({
  audit_id: audit.audit_id,
  type: "audit.published",
  data: { kept: kept.length, shown: Math.min(FREE_FINDINGS, keptIssues.length), issues: keptIssues.length },
});
store.close();
events.close();

console.log(
  `\n${GREEN}PUBLISHED${RESET}\n` +
    `  ${publicPath}\n` +
    `  ${path.join(dir, "results-full.html")}  ${DIM}(everything, including what you cut)${RESET}\n\n` +
    `  ${DIM}${decisions.length} usefulness labels recorded. Run \`npm run corpus\` to fold them in.${RESET}\n`,
);
