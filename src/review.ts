import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import path from "node:path";
import { AuditStore } from "./db.js";
import {
  Capture,
  Finding,
  normalizeSeverity,
  type ReviewDecision,
  type ReviewRecord,
} from "./types.js";
import { renderPublic, locationLine, FREE_FINDINGS } from "./render.js";

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
        ? `\nIt has already been published. Re-reviewing would rewrite what the visitor saw.\n`
        : `\n`),
  );
  store.close();
  process.exit(2);
}

const dir = path.join("out", audit.audit_id);
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

const rl = createInterface({ input: process.stdin, output: process.stdout });
let closed = false;
rl.on("close", () => {
  closed = true;
});

/** See label.ts — rl.question never settles once stdin closes, losing the session. */
async function ask(prompt: string): Promise<string | null> {
  if (closed) return null;
  return Promise.race([
    rl.question(prompt),
    new Promise<null>((resolve) => rl.once("close", () => resolve(null))),
  ]);
}

console.log(
  `\n${BOLD}${audit.url}${RESET}\n` +
    `${DIM}${audit.audit_id} · ${findings.length} findings · $${audit.cost_usd.toFixed(2)}${RESET}\n\n` +
    (audit.profile_summary ? `${wrap(audit.profile_summary, 74, "  ")}\n\n` : "") +
    `  ${GREEN}k${RESET} keep     ${RED}c${RESET} cut     ${YELLOW}1-4${RESET} keep at that severity     ` +
    `${DIM}q${RESET} quit without publishing\n` +
    `  ${DIM}Enter alone keeps. Add a reason after the letter: ${RESET}c true but nobody would act\n\n` +
    `  ${DIM}Keep/cut is also the usefulness label — the question is whether a founder\n` +
    `  would change something because of this, not whether it is true.${RESET}\n`,
);

const decisions: ReviewDecision[] = [];
let quit = false;

for (const [i, f] of findings.entries()) {
  console.log(
    `${DIM}${"─".repeat(78)}${RESET}\n` +
      `${DIM}[${i + 1}/${findings.length}]${RESET} ${BOLD}${f.heuristic}${RESET}\n` +
      `${DIM}severity ${f.severity} · ${f.confidence} confidence · ${f.agent}` +
      `${f.positive ? ` · ${GREEN}positive${RESET}${DIM}` : ""}${RESET}\n`,
  );
  console.log(wrap(f.observation));
  console.log(`\n${DIM}${wrap(f.impact_note)}${RESET}`);
  console.log(`\n${DIM}${wrap(`Location: ${locationLine(f, capture)}`)}${RESET}`);

  const answer = await ask(`\n  ${BOLD}Keep it?${RESET}\n  > `);
  if (answer === null) {
    quit = true;
    break;
  }

  const raw = answer.trim();
  const key = raw.charAt(0).toLowerCase();
  const note = raw.slice(1).trim() || null;

  if (key === "q") {
    quit = true;
    break;
  }

  if (/^[1-4]$/.test(key)) {
    const severity = normalizeSeverity(Number(key)).value;
    decisions.push({
      finding_id: f.id,
      keep: true,
      severity_before: f.severity,
      severity_after: severity,
      note,
    });
    console.log(`${DIM}  kept, severity ${f.severity} -> ${severity}${RESET}\n`);
    continue;
  }

  const keep = key !== "c";
  decisions.push({
    finding_id: f.id,
    keep,
    severity_before: f.severity,
    severity_after: f.severity,
    note,
  });
  console.log(`${DIM}  ${keep ? "kept" : "cut"}${RESET}\n`);
}

rl.close();

if (quit && decisions.length < findings.length) {
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

const confirm = createInterface({ input: process.stdin, output: process.stdout });
const go = (await confirm.question(`  ${BOLD}Publish?${RESET} (y/N) > `)).trim().toLowerCase();
confirm.close();

if (go !== "y") {
  console.log(`\n  Not published. The audit is still REVIEW_PENDING.\n`);
  store.close();
  process.exit(0);
}

const record: ReviewRecord = {
  audit_id: audit.audit_id,
  reviewed_at: new Date().toISOString(),
  decisions,
};
writeFileSync(path.join(dir, "review.json"), JSON.stringify(record, null, 2) + "\n");

const publicPath = await renderPublic(
  {
    capture,
    kept,
    annotatedImage: path.join(dir, `${audit.audit_id}-annotated.png`),
    profile: {
      site_kind: "other",
      concerns: [],
      goal: "unknown",
      drop_point: "unknown",
      summary: audit.profile_summary ?? "A review of this page.",
    },
  },
  dir,
);

store.transition(audit.audit_id, "PUBLISHED", { findings_published: kept.length });
store.close();

console.log(
  `\n${GREEN}PUBLISHED${RESET}\n` +
    `  ${publicPath}\n` +
    `  ${path.join(dir, "results-full.html")}  ${DIM}(everything, including what you cut)${RESET}\n\n` +
    `  ${DIM}${decisions.length} usefulness labels recorded. Run \`npm run corpus\` to fold them in.${RESET}\n`,
);
