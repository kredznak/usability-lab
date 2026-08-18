import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { capture, CaptureFailed } from "./capture.js";
import { AuditStore, EventLog, ReauditRequestStore, type AuditRow } from "./db.js";
import { OUT_ROOT } from "./paths.js";
import { Capture } from "./types.js";
import { diffCaptures, isQuiet, type CaptureDiff } from "./capture-diff.js";
import { sampledForReview } from "./sampling.js";

/**
 * `npm run reaudit <url>` — docs/design.md §1's monitoring promise.
 *
 *   npm run reaudit -- https://basecamp.com
 *
 * Captures the page, diffs it against the last published capture, and only
 * spends money if something changed.
 *
 * ## Why the diff decides whether to audit at all
 *
 * §11 already assumes this — "unchanged pages diff-skipped", a cache-hot
 * re-audit at ~$0.30. A capture costs seconds and no tokens; an audit costs
 * ~$0.65. More importantly it is the honest order: we have measured that the
 * capture diff has a zero noise floor (B15) and that the findings do not, so
 * the deterministic thing decides and the model is only asked when there is
 * something new to look at.
 *
 * ## What auto-publishes, and what does not
 *
 * §6 says re-audits auto-publish with a 1-in-5 sampled review. Approved
 * deviation, 2026-08-17: **the change summary auto-publishes; new findings do
 * not.** Three facts stack badly — findings on an unchanged page churn by 2-5
 * (B15), a published page has no correction path (B5), and auto-publish means
 * nobody reads it. The change summary is deterministic and measured; the
 * findings are neither. So this ends at REVIEW_PENDING and the sampling decides
 * how loudly to say so.
 */

const CHANGE_FILE = "capture-diff.json";

/**
 * The audit a re-audit is measured against.
 *
 * Published only. A retired run is one we decided not to stand behind, and a
 * pending one has not been read yet — comparing against either would make the
 * customer's "what changed" depend on our own housekeeping.
 */
export function chooseBaseline(rows: AuditRow[], url: string): AuditRow | null {
  const normalised = (u: string) => u.replace(/\/+$/, "").toLowerCase();
  const candidates = rows.filter(
    (r) =>
      (r.status === "PUBLISHED" || r.status === "AUTO_PUBLISHED") &&
      (normalised(r.url) === normalised(url) || normalised(r.final_url ?? "") === normalised(url)),
  );
  // `list()` returns newest first; the most recent published capture is the one
  // the customer last saw, which is what "since last time" has to mean.
  return candidates[0] ?? null;
}

export function summarise(d: CaptureDiff): string[] {
  const lines: string[] = [];
  if (d.title) lines.push(`title: "${d.title.before}" -> "${d.title.after}"`);
  if (d.final_url) lines.push(`redirects to ${d.final_url.after} (was ${d.final_url.before})`);
  for (const i of d.interactive.removed) lines.push(`gone:  <${i.tag}> ${i.label}`);
  for (const i of d.interactive.added) lines.push(`new:   <${i.tag}> ${i.label}`);
  for (const i of d.headings.removed) lines.push(`gone:  heading "${i.label}"`);
  for (const i of d.headings.added) lines.push(`new:   heading "${i.label}"`);
  for (const i of d.fields.removed) lines.push(`gone:  field ${i.tag} ${i.label}`);
  for (const i of d.fields.added) lines.push(`new:   field ${i.tag} ${i.label}`);
  for (const r of d.rotated) {
    lines.push(`list rolled over (-${r.removed}/+${r.added}): ${r.shape}`);
  }
  return lines;
}

/**
 * `npm run reaudit -- --queue` — act on what the results pages asked for.
 *
 * The other half of "no HTTP request may spend money". The button records a
 * row; this is the thing that decides to spend, and it is a command a person
 * runs (or a cron does) rather than anything a visitor can reach.
 *
 * ## Why each request is marked done even when it failed
 *
 * A request left pending after a failure is retried on every run, forever, and
 * the URL that cannot be captured is precisely the one that would be. The
 * customer's ask has been acted on; that it did not work is in the log above
 * and in their fair-use count, which is the honest place for it — see
 * `fairuse.ts` on why a failed re-audit is not refunded.
 *
 * ## Why it shells out per request
 *
 * The same reason `main` shells out to `npm run audit`: one crashed capture
 * takes down one request rather than the queue. It also means the queue runner
 * has no opinion about what a re-audit is — it stays exactly one behaviour,
 * defined once, in the branch below.
 */
function runQueue(): void {
  const requests = new ReauditRequestStore();
  const pending = requests.queue();

  if (pending.length === 0) {
    console.log(`\nNothing queued. Re-audits are asked for from a results page.\n`);
    requests.close();
    return;
  }

  console.error(`\n${pending.length} re-audit${pending.length === 1 ? "" : "s"} queued.\n`);
  let failed = 0;

  for (const r of pending) {
    console.error(`\n─── request ${r.id}: ${r.url}  (asked ${r.requested_at.slice(0, 10)})\n`);
    try {
      execFileSync("npm", ["run", "reaudit", "--", r.url], { stdio: "inherit" });
    } catch {
      failed += 1;
      console.error(`\n  request ${r.id} did not complete. Marked done anyway — see above.\n`);
    }
    requests.complete(r.id);
  }

  console.log(
    `\n${pending.length - failed} of ${pending.length} completed` +
      (failed > 0 ? `, ${failed} failed.\n` : `.\n`),
  );
  requests.close();
}

async function main(): Promise<void> {
  if (process.argv[2] === "--queue") return runQueue();

  const url = process.argv[2];
  if (!url || url.startsWith("--")) {
    console.error("usage: npm run reaudit -- <url>\n       npm run reaudit -- --queue");
    process.exit(2);
  }

  const store = new AuditStore();
  const events = new EventLog();
  const baseline = chooseBaseline(store.list(), url);
  if (!baseline) {
    console.error(
      `\nNo published audit of ${url} to compare against.\n` +
        `  A re-audit is "what changed since last time"; run \`npm run audit\` first.\n`,
    );
    store.close();
    process.exit(2);
  }

  const baselineDir = path.join(OUT_ROOT, baseline.audit_id);
  const baselineCapture = Capture.parse(
    JSON.parse(readFileSync(path.join(baselineDir, "capture.json"), "utf8")),
  );

  console.error(
    `\nre-audit ${url}\n` +
      `  against ${baseline.audit_id.slice(0, 8)}, published ${(baseline.published_at ?? "").slice(0, 10)}\n`,
  );

  let now: Capture;
  try {
    // Into the baseline's directory, deliberately: this capture exists to
    // answer "did it change", and if it did, the audit that follows takes its
    // own. Writing it as an audit artifact would leave a capture belonging to
    // no audit.
    now = await capture(url, `reaudit-${baseline.audit_id}`, path.join(baselineDir, "reaudit"));
  } catch (err) {
    console.error(
      err instanceof CaptureFailed ? `\ncapture failed: ${err.message}\n  ${err.detail}\n` : String(err),
    );
    store.close();
    process.exit(1);
  }

  const diff = diffCaptures(baselineCapture, now);
  events.record({
    audit_id: baseline.audit_id,
    type: "reaudit.checked",
    data: {
      url,
      quiet: isQuiet(diff),
      // The cost story of the whole feature is in these three numbers: how
      // often a re-audit finds nothing, and how much churn it correctly ignored.
      changes: summarise(diff).length,
      rotated: diff.rotated.length,
      partial: diff.partial.length,
    },
  });
  writeFileSync(path.join(baselineDir, CHANGE_FILE), JSON.stringify(diff, null, 2) + "\n");

  for (const p of diff.partial) console.error(`  partial: ${p}`);

  if (isQuiet(diff)) {
    // The one case that costs nothing. Note what it does NOT say: not "your
    // site is fine". Nothing here has looked at the page's quality.
    console.log(
      `\nNo change to the page since ${(baseline.published_at ?? "").slice(0, 10)}.\n` +
        (diff.rotated.length > 0
          ? `  ${diff.rotated.length} list(s) rolled forward, which is not a change.\n`
          : "") +
        `  No audit was run and nothing was spent.\n`,
    );
    store.close();
    events.close();
    return;
  }

  console.log(`\nThe page changed:\n${summarise(diff).map((l) => `  ${l}`).join("\n")}\n`);

  const answersFile = path.join(baselineDir, "answers.json");
  const args = [
    "run", "audit", "--", url,
    "--pin-to", baseline.audit_id,
    // Marks the row, so the corpus can tell a re-audit from a first audit.
    // Without it basecamp is 3 of 9 published audits and 40% of the findings,
    // and every metric drifts toward whichever page gets monitored most.
    "--reaudit-of", baseline.audit_id,
  ];
  if (existsSync(answersFile)) args.push("--answers", answersFile);
  else console.error(`  no answers.json on the baseline; auditing without the original brief\n`);

  console.error(`  running a fresh audit on the changed page\n`);
  store.close();
  events.close();
  execFileSync("npm", args, { stdio: "inherit" });

  // The audit that just ran created its own row; whether a person reads it is
  // the sampled decision. Re-opened rather than held, because the subprocess
  // wrote to the same database.
  const after = new AuditStore();
  const fresh = after.list("REVIEW_PENDING")[0];
  if (fresh) {
    console.log(
      sampledForReview(fresh.audit_id)
        ? `\n  Sampled for review — read this one before it goes out.\n` +
            `  npm run review -- ${fresh.audit_id.slice(0, 8)}\n`
        : `\n  Not in the review sample.\n` +
            `  The change summary above stands on its own; the findings still gate.\n`,
    );
  }
  after.close();
}

/**
 * Only when run as the command, so `chooseBaseline` and `summarise` can be
 * imported and tested without the CLI firing and calling process.exit.
 */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
