import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuditStore, EventLog } from "./db.js";
import { OUT_ROOT } from "./paths.js";

/**
 * `npm run funnel` — §0's "every step's events visible in the funnel
 * dashboard", the last clause of the definition of done that had never been
 * built.
 *
 * ## What it does not pretend to show
 *
 * §8's funnel is question-start -> completion -> preview -> email -> full ->
 * subscribe. There is no web app, no email gate and no Stripe, so four of those
 * six stages cannot emit anything. They are printed as NOT BUILT rather than as
 * zero: a zero in a funnel means people arrived and did not convert, which
 * would be a lie about a stage that does not exist.
 *
 * ## Why p95 and not an average
 *
 * The synthesizer's mean over its last five runs is about nine minutes, which
 * describes none of them: four ran 8-43s and one ran 1618s. An average hides
 * exactly the shape B14 turned out to be, and the whole reason this page exists
 * is that the 27-minute step was found by a person reading a log line.
 */

interface StepStat {
  step: string;
  n: number;
  p50: number;
  p95: number;
  max: number;
  failures: number;
}

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  // Nearest-rank. At n=3 an interpolating percentile invents values between
  // measurements, and every number here is a real run we can go and look at.
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length - 1, Math.max(0, rank - 1))]!;
}

export function stepStats(
  events: { type: string; data: Record<string, unknown> }[],
): StepStat[] {
  const byStep = new Map<string, { ms: number[]; failures: number }>();
  for (const e of events) {
    if (!e.type.startsWith("step.")) continue;
    const step = e.type.slice("step.".length);
    const entry = byStep.get(step) ?? { ms: [], failures: 0 };
    entry.ms.push(Number(e.data.ms ?? 0));
    if (e.data.ok === false) entry.failures += 1;
    byStep.set(step, entry);
  }

  return [...byStep.entries()]
    .map(([step, { ms, failures }]) => {
      const sorted = [...ms].sort((a, b) => a - b);
      return {
        step,
        n: ms.length,
        p50: percentile(sorted, 50),
        p95: percentile(sorted, 95),
        max: sorted[sorted.length - 1] ?? 0,
        failures,
      };
    })
    .sort((a, b) => b.p95 - a.p95);
}

export interface Stage {
  label: string;
  n: number;
  /** Percent of the audits this log actually saw start. Null for the first stage. */
  pct: number | null;
}

/**
 * The funnel, counting audits rather than events.
 *
 * It first read `reviewed at the gate 4 — 200% of requested`, which was two
 * true numbers over each other. `review.decided` fires once per *sitting*, and
 * both audits were gated twice: once answering "not yet", once publishing. A
 * funnel stage counts things that got somewhere, not actions taken.
 *
 * The denominator has its own trap. Events are not backfilled, so an audit
 * started before this log existed can still be reviewed after it — arriving at
 * a later stage without ever entering the first. Those are excluded from the
 * percentages and reported separately, because silently counting them would
 * put a stage above 100% again, and silently dropping them would hide work
 * that happened.
 */
export function funnelStages(
  events: { type: string; audit_id: string | null }[],
): { stages: Stage[]; outside: number } {
  const idsFor = (type: string) =>
    new Set(events.filter((e) => e.type === type && e.audit_id).map((e) => e.audit_id!));

  const requested = idsFor("audit.requested");
  const stageTypes = [
    ["completed", "audit.completed"],
    ["reviewed at the gate", "review.decided"],
    ["published", "audit.published"],
  ] as const;

  const outside = new Set<string>();
  const stages: Stage[] = [{ label: "audit requested", n: requested.size, pct: null }];

  for (const [label, type] of stageTypes) {
    const ids = idsFor(type);
    for (const id of ids) if (!requested.has(id)) outside.add(id);
    const counted = [...ids].filter((id) => requested.has(id)).length;
    stages.push({
      label,
      n: counted,
      pct: requested.size > 0 ? (counted / requested.size) * 100 : null,
    });
  }

  return { stages, outside: outside.size };
}

const secs = (ms: number) => `${(ms / 1000).toFixed(1)}s`;

function main(): void {
  const events = new EventLog();
  const audits = new AuditStore();
  const all = events.all();
  const rows = audits.list();

  const byType = new Map<string, number>();
  for (const e of all) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);

  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);

  const stats = stepStats(all);
  const { stages, outside } = funnelStages(all);
  const failed = byType.get("audit.failed") ?? 0;
  const reaudits = all.filter((e) => e.type === "reaudit.checked");
  const quiet = reaudits.filter((e) => e.data.quiet === true).length;

  const stageLine = (s: Stage) =>
    `  ${s.label.padEnd(22)} ${String(s.n).padStart(4)}` +
    (s.pct === null ? "" : `   ${s.pct.toFixed(0)}% of requested`);

  const lines = [
    ``,
    `THE FUNNEL — ${all.length} events, ${rows.length} audits`,
    all.length === 0
      ? `\n  No events yet. The log starts empty and is not backfilled, so audits\n` +
        `  run before this existed are absent — not a quiet week.\n`
      : ``,
    ...stages.map(stageLine),
    outside > 0
      ? `\n  ${outside} audit(s) reached a later stage without a recorded start —\n` +
        `  they began before this log existed, and are left out of the percentages.`
      : ``,
    ``,
    `  email captured         NOT BUILT`,
    `  subscribed             NOT BUILT`,
    ``,
    `RE-AUDITS  ${reaudits.length} checked, ${quiet} found nothing and spent nothing`,
    ``,
    `AUDITS BY STATE`,
    ...[...byStatus.entries()].map(([s, n]) => `  ${s.padEnd(22)} ${String(n).padStart(4)}`),
    ``,
    `STEP DURATION — p95, because an average hides the step that hung`,
    `  ${"step".padEnd(14)} ${"n".padStart(3)} ${"p50".padStart(8)} ${"p95".padStart(8)} ${"max".padStart(8)}  failures`,
    ...stats.map(
      (s) =>
        `  ${s.step.padEnd(14)} ${String(s.n).padStart(3)} ${secs(s.p50).padStart(8)} ` +
        `${secs(s.p95).padStart(8)} ${secs(s.max).padStart(8)}  ${s.failures || ""}`,
    ),
    ``,
    `  audits failed: ${failed}`,
    ``,
  ];

  console.log(lines.join("\n"));

  mkdirSync(OUT_ROOT, { recursive: true });
  const out = path.join(OUT_ROOT, "funnel.html");
  writeFileSync(
    out,
    `<!doctype html><meta charset="utf-8"><title>The Usability Lab — funnel</title>` +
      `<style>body{font:14px/1.6 ui-monospace,monospace;max-width:70ch;margin:3rem auto;padding:0 1rem}` +
      `pre{white-space:pre-wrap}</style>` +
      `<h1>The funnel</h1><pre>${lines.join("\n").replace(/</g, "&lt;")}</pre>`,
    "utf8",
  );
  console.log(`  ${out}\n`);

  events.close();
  audits.close();
}

/** Only as the command — importing `stepStats` must not print a dashboard. */
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
