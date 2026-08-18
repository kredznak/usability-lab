import { AuditStore, EventLog } from "./db.js";
import { loadPublished, NotPublishable } from "./published.js";
import { renderPublic } from "./render.js";

/**
 * `npm run correct -- <audit-id> "<what changed and why>"` — B5.
 *
 *   npm run correct -- 139d5f3e "added the sources for two findings"
 *
 * The answer to a question `docs/quality-bar.md` carried as [UNRESOLVED] for a
 * week: what does a customer get when a published page turns out to be wrong?
 *
 * Kelly's decision, 2026-08-17: **the page is fixed and it says so.** A dated
 * line, in our words, naming what changed.
 *
 * ## Why this exists as a command rather than a script
 *
 * It has happened twice already. Both times a published page was regenerated
 * by a throwaway script that stepped around `review.ts`'s refusal to touch a
 * PUBLISHED audit, and nothing anywhere recorded that what the visitor saw had
 * changed. A guard that can only be bypassed will be bypassed; the fix is to
 * give it somewhere to send you.
 *
 * ## What this does not do
 *
 * It does not notify anyone. A correction the customer never hears about is
 * half a policy, and email is a slice that does not exist yet.
 *
 * It re-renders with *today's* code, not the code that published the page — so
 * a correction can pick up unrelated renderer changes, and the dated line names
 * only the reason you typed. Accepted deliberately at two pages a week; the
 * alternative is diffing old and new HTML and refusing on anything unstated.
 */

async function main(): Promise<void> {
  const [prefix, reason] = [process.argv[2], process.argv[3]];
  if (!prefix || !reason) {
    console.error(
      `\nusage: npm run correct -- <audit-id> "<what changed and why>"\n\n` +
        `  The reason is shown to the customer, so write it for them:\n` +
        `  npm run correct -- 139d5f3e "added the sources for two findings"\n`,
    );
    process.exit(2);
  }

  const store = new AuditStore();
  const matches = store.find(prefix);
  if (matches.length !== 1) {
    console.error(`"${prefix}" matched ${matches.length} audits; need exactly one.`);
    store.close();
    process.exit(2);
  }

  const audit = matches[0]!;
  if (audit.status !== "PUBLISHED" && audit.status !== "AUTO_PUBLISHED") {
    // The exact inverse of review.ts's guard. Nothing has been shown to a
    // visitor yet, so there is nothing to correct — re-review it instead.
    console.error(
      `\n${audit.audit_id.slice(0, 8)} is ${audit.status}, not published.\n` +
        `  There is nothing a visitor has seen, so there is nothing to correct.\n` +
        `  npm run review -- ${audit.audit_id.slice(0, 8)}\n`,
    );
    store.close();
    process.exit(2);
  }

  // `loadPublished` rebuilds the kept set from the founder's recorded decisions
  // rather than from findings.json, so a correction cannot quietly restore
  // something that was cut or revert a severity adjusted at the gate.
  let page;
  try {
    page = loadPublished(audit);
  } catch (err) {
    if (!(err instanceof NotPublishable)) throw err;
    console.error(
      `Cannot rebuild what ${audit.audit_id.slice(0, 8)} published: ${err.reason}.\n` +
        `  The artifacts that recorded it are not on disk.`,
    );
    store.close();
    process.exit(2);
  }

  const events = new EventLog();
  events.record({
    audit_id: audit.audit_id,
    type: "audit.corrected",
    data: { reason },
  });

  // Read back rather than appended in memory: the page must show the history
  // the log holds, not a version of it this process happens to have.
  const corrections = events
    .all(audit.audit_id)
    .filter((e) => e.type === "audit.corrected")
    .map((e) => ({ at: e.at, reason: String(e.data.reason ?? "") }));

  const publicPath = await renderPublic({ ...page, corrections }, page.dir);

  events.close();
  store.close();

  console.log(
    `\nCORRECTED  ${audit.audit_id.slice(0, 8)}\n` +
      `  ${publicPath}\n` +
      `  The page now carries ${corrections.length} correction(s), oldest first.\n\n` +
      `  Nobody has been told. There is no notification path yet.\n`,
  );
}

await main();
