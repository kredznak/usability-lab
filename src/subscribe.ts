/**
 * `npm run subscribe -- <email>` — a subscription, granted by hand.
 *
 *   npm run subscribe -- someone@example.com
 *   npm run subscribe -- someone@example.com --days 90
 *   npm run subscribe -- someone@example.com --cancel
 *
 * ## Why this exists before Stripe does
 *
 * §0 ships "subscribe (Stripe Checkout)", and Checkout is the third of that
 * work that needs keys nobody has yet. Everything a subscription *buys* — the
 * re-audit button, the fair-use cap, the queue — is built and needs a
 * subscriber to exercise it. This is the honest way to make one: it writes the
 * same row the Stripe webhook will write, through the same store, and leaves
 * both Stripe id columns null so a hand-granted row is distinguishable from a
 * paid one at a glance.
 *
 * It is also not throwaway. F21's repair is "daily reconciliation grants
 * access", and the granting half of that job is this function — the reconciler
 * will call `upsert`, decide the period end from Stripe's answer instead of
 * from `--days`, and be the same three lines.
 *
 * ## What it will not do
 *
 * Take money, or pretend to have. There is no `stripe_customer_id` to invent
 * and no charge behind this; a row written here means "we have decided this
 * address may use the product", which at nine published audits is a sentence a
 * founder is allowed to say out loud.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { SubscriptionStore } from "./db.js";
import { looksLikeEmail } from "./tokens.js";

/** A month, as the default period a hand-granted subscription runs for. */
const DEFAULT_DAYS = 30;

function main(): void {
  const args = process.argv.slice(2);
  const email = (args[0] ?? "").trim().toLowerCase();
  const cancel = args.includes("--cancel");
  const daysArg = args[args.indexOf("--days") + 1];
  const days = args.includes("--days") ? Number(daysArg) : DEFAULT_DAYS;

  if (!looksLikeEmail(email)) {
    console.error(
      `usage: npm run subscribe -- <email> [--days N] [--cancel]\n` +
        `  grants ${DEFAULT_DAYS} days by default; --cancel revokes immediately.\n`,
    );
    process.exit(2);
  }
  if (!cancel && (!Number.isFinite(days) || days <= 0)) {
    console.error(`--days must be a positive number of days.\n`);
    process.exit(2);
  }

  const subs = new SubscriptionStore();

  if (cancel) {
    // Status *and* period end, together. `isActive` needs only one of them to
    // say no, but leaving a future end date on a cancelled row is how a later
    // reader concludes the customer still has time left.
    subs.upsert(email, { status: "canceled", currentPeriodEnd: null });
    console.log(`\n  ${email} — canceled. Access ends now.\n`);
    subs.close();
    return;
  }

  const end = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
  subs.upsert(email, { status: "active", currentPeriodEnd: end });
  console.log(
    `\n  ${email} — active until ${end.slice(0, 10)} (${days} days).\n` +
      `  No Stripe ids: this was granted by hand, and the row says so.\n`,
  );
  subs.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
