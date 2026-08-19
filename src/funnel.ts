import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AuditStore, EventLog, SubscriptionStore } from "./db.js";
import { stripeConfig } from "./stripe.js";
import { OUT_ROOT } from "./paths.js";

/**
 * `npm run funnel` — §0's "every step's events visible in the funnel
 * dashboard", the last clause of the definition of done that had never been
 * built.
 *
 * ## What it does not pretend to show
 *
 * §8's funnel is question-start -> completion -> preview -> email -> full ->
 * subscribe. Every stage but the last emits now; **subscribe does not, because
 * Stripe Checkout is not built**. It is printed as NOT BUILT rather than as
 * zero: a zero in a funnel means people arrived and did not convert, which
 * would be a lie about a stage that does not exist.
 *
 * The first two stages count **visits, not audits**, and are printed apart from
 * the rest for that reason. Somebody who opens the form and leaves has produced
 * no audit to be a distinct count of, so folding them into the block below —
 * where every row is "how many audits reached here" — would put two different
 * units in one column.
 *
 * The re-audit stage that follows it is the thing a subscription buys, and it
 * *is* live — which is why the funnel currently shows a conversion nobody can
 * pay for. That gap is the honest shape of today's work, not a bug in this file.
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
    // §6's visitor half, live since the server shipped. These count distinct
    // audits like every stage above, so ten people opening one preview is one
    // audit previewed — the same rule that fixed the 200% review row.
    ["previewed", "preview.viewed"],
    ["email captured", "email.captured"],
    ["full results read", "full.viewed"],
    // Pressing subscribe. Audit-keyed like everything above it, because the
    // press happens on a results page. What follows it — the payment — is not,
    // and is counted separately below for exactly that reason.
    ["checkout started", "checkout.started"],
    // What a subscription buys. Last, because it is the step past the one that
    // cannot happen yet — `main` prints the NOT BUILT subscribe line between
    // this and the stage above it.
    ["re-audit requested", "reaudit.requested"],
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

/** The one stage that sits below `subscribed NOT BUILT` in the printout. */
const AFTER_SUBSCRIBE = "re-audit requested";

function main(): void {
  const events = new EventLog();
  const audits = new AuditStore();
  const all = events.all();
  const rows = audits.list();

  const byType = new Map<string, number>();
  for (const e of all) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);

  const byStatus = new Map<string, number>();
  for (const r of rows) byStatus.set(r.status, (byStatus.get(r.status) ?? 0) + 1);

  const turnedAway = (byType.get("request.rejected") ?? 0) + (byType.get("request.throttled") ?? 0);

  /**
   * The one stage that cannot be counted from events.
   *
   * A payment is a fact about a person, not about an audit — `subscription.changed`
   * carries no `audit_id` and could not, since one subscription covers up to
   * three sites. So this is a count of rows that grant access **right now**,
   * which is also the only number anyone would act on. It is printed apart from
   * the audit funnel for the same reason the question-flow stages are.
   *
   * With no Stripe keys the line says so rather than showing a zero: a zero
   * here would mean people reached checkout and did not pay.
   */
  const subs = new SubscriptionStore();
  const active = subs.all().filter((r) => subs.isActive(r.email)).length;
  subs.close();
  const subscribeLine = stripeConfig()
    ? `  subscribed             ${String(active).padStart(4)}   active right now`
    : `  subscribed             ${String(active).padStart(4)}   active — but STRIPE KEYS ARE UNSET,\n` +
      `                              so these were granted by \`npm run subscribe\``;
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
    /**
     * §8's first two stages, and they are counted differently on purpose.
     *
     * A visitor who opens the form and leaves produces no audit, so these two
     * cannot be a percentage of anything below them and cannot be counted as
     * distinct audits the way every stage under them is. They are visits.
     * Printing them inside the same block, with the same shape, would make
     * "form opened 40" read as forty audits.
     */
    ...[
      `  form opened            ${String(byType.get("question.started") ?? 0).padStart(4)}   visits, not audits`,
      `  questions answered     ${String(byType.get("question.completed") ?? 0).padStart(4)}   requests queued`,
      turnedAway > 0
        ? `  turned away            ${String(turnedAway).padStart(4)}   bad URL or rate limited`
        : ``,
      // Filtered rather than joined: an absent row must not leave a blank line
      // behind it, or the block grows a gap on the days nobody was refused.
    ].filter(Boolean),
    ``,
    // Split around the stage that does not exist, so the printout keeps §8's
    // order: ... -> full -> subscribe -> what subscribing buys.
    ...stages.filter((s) => s.label !== AFTER_SUBSCRIBE).map(stageLine),
    outside > 0
      ? `\n  ${outside} audit(s) reached a later stage without a recorded start —\n` +
        `  they began before this log existed, and are left out of the percentages.`
      : ``,
    ``,
    subscribeLine,
    ...stages.filter((s) => s.label === AFTER_SUBSCRIBE).map(stageLine),
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
