/**
 * `npm run reconcile` — F21, the daily job that makes webhooks non-critical.
 *
 * §12: *"Stripe webhook missed (customer paid, still locked out) — daily
 * reconciliation vs. Stripe + webhook retries; reconciliation grants access;
 * one customer, ≤24h."* This is that job. It is also the reason `db.ts` can
 * afford to make access **expire** rather than persist: a period end that stops
 * moving forward locks somebody out, and this is what unlocks them.
 *
 * ## What it treats as true
 *
 * Stripe. Every time. Our `subscriptions` table is a cache of somebody else's
 * billing system, and a cache that argues with its source is worse than no
 * cache. So this never asks "did we mean to do that" — it copies.
 *
 * ## Why it revokes as well as grants
 *
 * F21 names only the grant direction, because that is the failure that hurts a
 * customer. The other direction — a cancellation whose webhook we missed —
 * costs money quietly and forever, and it is the same query. Doing only half of
 * it would mean the job that exists to make webhooks non-critical still leaves
 * one webhook critical.
 *
 * ## What it will not do
 *
 * Touch a row Stripe has never heard of. A subscription granted by hand with
 * `npm run subscribe` has no Stripe ids, and revoking it because Stripe does not
 * list it would delete the only kind of subscription this product currently has.
 * Those rows are reported and left alone.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { SubscriptionStore, EventLog, type SubscriptionRow } from "./db.js";
import { mapStatus, stripeConfig, liveStripe, type StripeClient, type StripeSubscription } from "./stripe.js";

export interface Drift {
  email: string;
  /** What we had. `null` when we had no row at all. */
  before: { status: string; periodEnd: string | null } | null;
  after: { status: string; periodEnd: string | null };
  /** What changed, in a word, for the operator and the event log. */
  kind: "granted" | "revoked" | "renewed" | "created";
}

export interface Reconciliation {
  drift: Drift[];
  /** Rows we hold that Stripe does not list, left alone deliberately. */
  unknownToStripe: string[];
  checked: number;
}

/**
 * Compare and decide, without touching anything.
 *
 * Pure so the interesting cases are arithmetic: a subscription Stripe knows and
 * we do not, one whose period moved, one Stripe cancelled while we still say
 * active, and one of ours Stripe has never heard of. None of those are states a
 * real account would hold on request.
 */
export function planReconciliation(
  ours: SubscriptionRow[],
  theirs: StripeSubscription[],
): Reconciliation {
  const byEmail = new Map(ours.map((r) => [r.email, r]));
  const seen = new Set<string>();
  const drift: Drift[] = [];

  for (const sub of theirs) {
    // A subscription with no `ul_email` is one we cannot attribute — it was not
    // created by this system, or its metadata was stripped. Skipped rather than
    // guessed at: the alternative is granting access to an address inferred
    // from a billing record.
    if (!sub.email) continue;
    const email = sub.email.trim().toLowerCase();
    seen.add(email);

    const status = mapStatus(sub.status);
    const after = { status, periodEnd: sub.currentPeriodEnd };
    const existing = byEmail.get(email);

    if (!existing) {
      drift.push({ email, before: null, after, kind: "created" });
      continue;
    }
    const before = { status: existing.status, periodEnd: existing.current_period_end };
    if (before.status === after.status && before.periodEnd === after.periodEnd) continue;

    const kind: Drift["kind"] =
      before.status !== "active" && after.status === "active"
        ? "granted"
        : before.status === "active" && after.status !== "active"
          ? "revoked"
          : "renewed";
    drift.push({ email, before, after, kind });
  }

  return {
    drift,
    unknownToStripe: ours.filter((r) => !seen.has(r.email)).map((r) => r.email),
    checked: theirs.length,
  };
}

/** Apply a plan. Separate from deciding it, so a dry run is the same code minus this. */
export function applyReconciliation(
  plan: Reconciliation,
  subs: SubscriptionStore,
  events?: EventLog,
): void {
  for (const d of plan.drift) {
    subs.upsert(d.email, {
      status: d.after.status as SubscriptionRow["status"],
      currentPeriodEnd: d.after.periodEnd,
    });
    // The address is not in the event; §8 makes events permanent. What is worth
    // keeping for a year is that reconciliation had to correct something, and
    // in which direction.
    events?.record({ audit_id: null, type: "subscription.reconciled", data: { kind: d.kind } });
  }
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes("--dry-run");
  const config = stripeConfig();
  if (!config) {
    console.error(
      `\nStripe is not configured, so there is nothing to reconcile against.\n` +
        `  Set STRIPE_SECRET_KEY, STRIPE_PRICE_ID and STRIPE_WEBHOOK_SECRET in .env.\n` +
        `  Subscriptions granted with \`npm run subscribe\` are unaffected either way.\n`,
    );
    process.exit(2);
  }

  const subs = new SubscriptionStore();
  const events = new EventLog();
  const client: StripeClient = liveStripe(config);

  const theirs = await client.listSubscriptions();
  const plan = planReconciliation(subs.all(), theirs);

  console.log(`\nreconcile — ${plan.checked} subscription(s) at Stripe\n`);
  if (plan.drift.length === 0) console.log(`  nothing to correct.`);
  for (const d of plan.drift) {
    console.log(
      `  ${d.kind.padEnd(8)} ${d.email}  ${d.before?.status ?? "(no row)"} -> ${d.after.status}` +
        `  until ${d.after.periodEnd?.slice(0, 10) ?? "—"}`,
    );
  }
  if (plan.unknownToStripe.length > 0) {
    console.log(
      `\n  ${plan.unknownToStripe.length} row(s) Stripe has never heard of, left alone:\n` +
        plan.unknownToStripe.map((e) => `    ${e}`).join("\n") +
        `\n  (these are hand-granted — see \`npm run subscribe\`)`,
    );
  }

  if (dryRun) console.log(`\n  --dry-run: nothing was written.\n`);
  else {
    applyReconciliation(plan, subs, events);
    console.log(`\n  ${plan.drift.length} row(s) corrected.\n`);
  }

  subs.close();
  events.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
