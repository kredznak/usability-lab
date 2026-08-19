/**
 * `npm run stripe:check` — B21's preflight.
 *
 * ## What it is for
 *
 * Stripe is built here but has never been sent a request. The failures that
 * follow from that are all silent: a one-off price sells a single charge and
 * never renews, an inactive price makes every Checkout session 400, a live key
 * pointed at localhost takes real money for a page nobody can reach. None of
 * those announce themselves — you find out from a customer.
 *
 * So this is the thing that finds out first. One cheap call, and everything else
 * is arithmetic over what came back.
 *
 * ## Why the checks are separate from the printing
 *
 * `preflight` takes a client and returns results, so the interesting cases —
 * a price that is not recurring, a key that does not authenticate, a live key
 * with a localhost base URL — are all testable without an account, which is the
 * same problem B21 exists to describe.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { PRICE_USD } from "./render.js";
import {
  stripeConfig,
  liveStripe,
  STRIPE_API_VERSION,
  type StripeClient,
  type StripeConfig,
} from "./stripe.js";

export interface Check {
  name: string;
  ok: boolean;
  /** One line, written for whoever has to fix it. */
  detail: string;
  /** True when this is a warning rather than a refusal. */
  warn?: boolean;
}

/** Cents, because Stripe counts in the currency's smallest unit. */
const EXPECTED_CENTS = PRICE_USD * 100;

export async function preflight(config: StripeConfig, client: StripeClient): Promise<Check[]> {
  const checks: Check[] = [];

  const live = config.secretKey.startsWith("sk_live_");
  const localhost = /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])/.test(config.baseUrl);
  checks.push({
    name: "key mode",
    ok: !(live && localhost),
    warn: live && localhost,
    detail: live
      ? localhost
        ? `LIVE key with a localhost base URL (${config.baseUrl}). Real cards, and Stripe will send customers back to an address only you can open.`
        : `live key — real money.`
      : `test key. Card 4242 4242 4242 4242 will work; no real money moves.`,
  });

  checks.push({
    name: "webhook secret",
    ok: config.webhookSecret.startsWith("whsec_"),
    detail: config.webhookSecret.startsWith("whsec_")
      ? `present.`
      : `does not start with whsec_ — this is probably not a webhook signing secret, and every delivery will fail its signature check.`,
  });

  let price;
  try {
    price = await client.retrievePrice(config.priceId);
  } catch (err) {
    checks.push({
      name: "price",
      ok: false,
      detail: `could not be read: ${String(err)}. Either the key does not authenticate or the price id is wrong.`,
    });
    return checks;
  }

  checks.push({ name: "api key", ok: true, detail: `authenticates, pinned to ${STRIPE_API_VERSION}.` });

  /**
   * The check worth the whole file.
   *
   * A one-time price in `mode=subscription` is rejected by Checkout, and a
   * recurring price is the difference between a subscription and a single
   * charge. Nothing else here would notice: the button would work, the customer
   * would pay once, and the renewal that access hangs on would never come.
   */
  checks.push({
    name: "price is recurring",
    ok: price.type === "recurring" && price.interval !== null,
    detail:
      price.type === "recurring"
        ? `recurring, every ${price.interval}.`
        : `type is "${price.type}" — a one-off charge. Checkout in subscription mode will refuse it.`,
  });

  checks.push({
    name: "price is active",
    ok: price.active,
    detail: price.active ? `active.` : `archived in Stripe. Every checkout session will fail.`,
  });

  checks.push({
    name: "price matches the page",
    ok: price.unitAmount === EXPECTED_CENTS && price.currency === "usd",
    warn: true,
    detail:
      price.unitAmount === EXPECTED_CENTS && price.currency === "usd"
        ? `$${PRICE_USD}/mo, matching the results page.`
        : `Stripe says ${price.unitAmount === null ? "no fixed amount" : `${price.unitAmount} ${price.currency}`}, ` +
          `the results page says $${PRICE_USD}. One of them is lying to a customer.`,
  });

  return checks;
}

async function main(): Promise<void> {
  const config = stripeConfig();
  if (!config) {
    console.error(
      `\nStripe is not configured — nothing to check.\n\n` +
        `  Set STRIPE_SECRET_KEY, STRIPE_PRICE_ID and STRIPE_WEBHOOK_SECRET in .env.\n` +
        `  All three or none: with any missing, the results page says checkout is not\n` +
        `  connected and /stripe/webhook 404s. See docs/stripe-runbook.md.\n`,
    );
    process.exit(2);
  }

  console.log(`\nstripe:check — ${config.apiBase}\n`);
  const checks = await preflight(config, liveStripe(config));

  for (const c of checks) {
    const mark = c.ok ? "ok  " : c.warn ? "warn" : "FAIL";
    console.log(`  ${mark}  ${c.name.padEnd(22)} ${c.detail}`);
  }

  const failed = checks.filter((c) => !c.ok && !c.warn);
  console.log(
    failed.length === 0
      ? `\n  Nothing blocking. This does not prove a payment works — only a real\n` +
          `  subscription does that, and docs/stripe-runbook.md is how.\n`
      : `\n  ${failed.length} blocking problem(s). Checkout would fail for a customer.\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
