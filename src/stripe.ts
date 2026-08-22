/**
 * Stripe, behind a seam — §0's subscribe step, §7's `subscriptions` table, F21.
 *
 * ## Why there is an interface here at all
 *
 * There is no Stripe account yet. Written straight against the network, every
 * line of this file would be unverifiable, and the parts that matter most —
 * whether a forged webhook can grant somebody a subscription, whether
 * reconciliation revokes the right rows — would ship on my say-so. So the two
 * calls that genuinely need a network sit behind `StripeClient`, and everything
 * on this side of it is tested against a fake.
 *
 * That is the same move as the injectable resolver in `urlcheck.ts`, and it was
 * worth it there for the same reason: the interesting cases are the ones a real
 * dependency will not produce on demand.
 *
 * ## Why raw HTTP and not the `stripe` package
 *
 * Three documented REST endpoints, form-encoded, about forty lines. A dependency
 * I cannot run once is worse than code I can read — I would be guessing at
 * method names instead of guessing at field names, and only one of those is
 * checkable against Stripe's own docs. Swapping to the SDK later is a change to
 * `liveStripe` and nothing else, which is what the interface is for.
 *
 * ## What is verified and what is not, stated plainly — updated 2026-08-19
 *
 * These calls have now been **sent over HTTP to `stripe-mock`**, Stripe's own
 * server built from their OpenAPI spec — see `stripe-live.test.ts`. That covers
 * the form encoding, the auth header, the pinned version, the idempotency key,
 * the paging loop, and parsing responses shaped by the spec rather than by my
 * typing. Misspell `line_items` and the request is now refused, which is the
 * thing a stub could never do.
 *
 * **Two gaps remain, and they are the reason B21 is still open.**
 *
 * 1. stripe-mock validates *top-level* parameter names only. Everything nested
 *    passes unchecked — including `subscription_data[metadata]`, the single
 *    highest-risk key in this file, because if it is wrong the customer pays and
 *    is never granted access. That one rests on documentation alone.
 * 2. Nothing here charges a card, delivers a webhook, or round-trips metadata
 *    back out through a `customer.subscription.*` event. Only a real account
 *    does that; `docs/stripe-runbook.md` is the half hour it takes.
 */

import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import type { SubscriptionStatus } from "./db.js";
import { baseUrlFrom } from "./preflight.js";

/**
 * The API version every outbound request is pinned to — B21, 2026-08-18.
 *
 * Confirmed from https://docs.stripe.com/api/versioning ("The current version is
 * 2026-07-29.dahlia"), and pinned rather than omitted for one reason: **every
 * field name in this file was verified against that version's documentation**,
 * so sending anything else means the docs I checked are not the docs that apply.
 * Without the header, requests use whatever default is set in someone's
 * dashboard, which is a dependency on a setting nobody here can see.
 *
 * **This does not cover webhooks.** The same page: "Webhook events also use your
 * account's API version by default, unless you set an API version during
 * endpoint creation." So an incoming event can be shaped by an older version
 * than this, which is exactly why `readSubscription` reads both the old and the
 * new home of `current_period_end` rather than trusting one.
 */
export const STRIPE_API_VERSION = "2026-07-29.dahlia";


/** Everything Stripe needs from the environment. All or nothing — see below. */
export interface StripeConfig {
  secretKey: string;
  priceId: string;
  webhookSecret: string;
  /** Where Stripe sends the customer back to. */
  baseUrl: string;
  /**
   * Stripe's API root.
   *
   * Overridable so the tests can point `liveStripe` somewhere that is not
   * Stripe. `stripe-live.test.ts` points it at `stripe-mock` — Stripe's own
   * server, generated from their OpenAPI spec — which is what turned "these
   * calls have never run" into "these calls have run against something that
   * refuses a parameter Stripe does not have."
   *
   * Not a security boundary. It is read from our own environment, not from
   * anything a visitor sends.
   */
  apiBase: string;
}

/**
 * Configured, or not at all.
 *
 * There is no half-live state on purpose. A secret key without a webhook secret
 * would take money and never grant access; a price id without a key would draw
 * a button that 500s. Missing any one of the three means the page keeps saying
 * checkout is not connected, which is the truth and is already what it says.
 */
export function stripeConfig(env: NodeJS.ProcessEnv = process.env): StripeConfig | null {
  const secretKey = env.STRIPE_SECRET_KEY;
  const priceId = env.STRIPE_PRICE_ID;
  const webhookSecret = env.STRIPE_WEBHOOK_SECRET;
  if (!secretKey || !priceId || !webhookSecret) return null;
  return {
    secretKey,
    priceId,
    webhookSecret,
    // One rule, one place. `stripe.test.ts` still holds the trailing-slash case
    // from this side, which is what makes moving it safe.
    baseUrl: baseUrlFrom(env),
    apiBase: (env.STRIPE_API_BASE || "https://api.stripe.com/v1").replace(/\/+$/, ""),
  };
}

export interface CheckoutSession {
  id: string;
  /** Where to send the customer. Stripe hosts the card form; we never see a card. */
  url: string;
}

export interface StripeSubscription {
  id: string;
  customerId: string;
  /** Stripe's own word, unmapped. `mapStatus` narrows it at the boundary. */
  status: string;
  /** ISO, or null when Stripe did not give one. */
  currentPeriodEnd: string | null;
  /**
   * The address **we** put in metadata when the session was created — not the
   * one typed into Stripe's form. See `createCheckoutSession`.
   */
  email: string | null;
}

export interface StripePrice {
  id: string;
  active: boolean;
  /** `recurring` or `one_time`. A one-time price sells one charge and never renews. */
  type: string;
  interval: string | null;
  unitAmount: number | null;
  currency: string;
}

export interface StripeClient {
  createCheckoutSession(input: { email: string; auditId: string }): Promise<CheckoutSession>;
  listSubscriptions(): Promise<StripeSubscription[]>;
  /** For the preflight — the cheapest call that proves the key works. */
  retrievePrice(priceId: string): Promise<StripePrice>;
}

/**
 * Stripe's status vocabulary, narrowed to the three that change what we do.
 *
 * `db.ts` promised this mapping would live at the boundary rather than in the
 * column, and this is the boundary. **Anything unrecognised maps to `canceled`**
 * — a status we have never seen before must not grant access, and Stripe adds
 * statuses without asking us.
 */
export function mapStatus(stripeStatus: string): SubscriptionStatus {
  switch (stripeStatus) {
    case "active":
    case "trialing":
      return "active";
    case "past_due":
    case "unpaid":
    case "incomplete":
      return "past_due";
    default:
      return "canceled";
  }
}

// --- the webhook, which is the part that must not be wrong --------------------

export type WebhookFailure = "no-header" | "malformed" | "bad-signature" | "stale";

export interface StripeEvent {
  id: string;
  type: string;
  data: { object: Record<string, unknown> };
}

export type WebhookResult =
  | { ok: true; event: StripeEvent }
  | { ok: false; reason: WebhookFailure };

/**
 * How old a webhook may be and still be acted on.
 *
 * Stripe's own recommendation, and it is replay protection rather than
 * housekeeping: the signature over a captured request stays valid forever, so
 * without a window, anyone who ever saw one `checkout.session.completed` can
 * replay it whenever they like.
 */
export const WEBHOOK_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * Verify a `Stripe-Signature` header, then parse.
 *
 * The order is the whole point, and it is the same rule `tokens.ts` follows: an
 * unverified body is attacker-controlled JSON, and there is no reason to hand it
 * to a parser. This endpoint is public and unauthenticated by anything else —
 * the signature *is* the authentication — so a mistake here means anyone on the
 * internet can grant themselves a subscription.
 *
 * The header is `t=<unix>,v1=<hex>[,v1=<hex>]`, and **more than one `v1` is
 * normal**: during a secret rotation Stripe signs with both. Accepting only the
 * first would break every webhook for the duration of a rotation, which is
 * exactly when nobody is looking.
 */
export function verifyWebhook(
  rawBody: string,
  header: string | undefined,
  secret: string,
  now = Date.now(),
): WebhookResult {
  if (!header) return { ok: false, reason: "no-header" };

  let timestamp: string | null = null;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (key === "t") timestamp = value;
    else if (key === "v1") signatures.push(value);
  }
  if (!timestamp || signatures.length === 0) return { ok: false, reason: "malformed" };
  if (!/^\d+$/.test(timestamp)) return { ok: false, reason: "malformed" };

  const sentAt = Number(timestamp) * 1000;
  if (Math.abs(now - sentAt) > WEBHOOK_TOLERANCE_MS) return { ok: false, reason: "stale" };

  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
  const expectedBuf = Buffer.from(expected, "utf8");
  const matched = signatures.some((candidate) => {
    const given = Buffer.from(candidate, "utf8");
    // Length first: `timingSafeEqual` throws on a mismatch rather than
    // returning false, and a thrown exception here would be a 500 on a route
    // whose whole job is to reject things calmly.
    return given.length === expectedBuf.length && timingSafeEqual(expectedBuf, given);
  });
  if (!matched) return { ok: false, reason: "bad-signature" };

  let event: StripeEvent;
  try {
    event = JSON.parse(rawBody) as StripeEvent;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof event?.type !== "string" || typeof event?.data?.object !== "object" || !event.data.object) {
    return { ok: false, reason: "malformed" };
  }
  return { ok: true, event };
}

/**
 * Sign a payload the way Stripe does. Test-only in practice, and exported so the
 * tests build real signatures rather than asserting against a constant somebody
 * pasted — a fixture copied out of a passing run proves only that the code still
 * does what it did.
 */
export function signWebhook(rawBody: string, secret: string, now = Date.now()): string {
  const t = Math.floor(now / 1000);
  const v1 = createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
  return `t=${t},v1=${v1}`;
}

// --- what the two subscription-shaped facts look like on the wire -------------

/** Epoch seconds -> ISO, defensively. */
function isoFrom(seconds: unknown): string | null {
  return typeof seconds === "number" && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : null;
}

/**
 * A Stripe subscription object, narrowed to the four fields we store.
 *
 * ## Where `current_period_end` actually lives
 *
 * **Not on the subscription.** Checked against Stripe's current documentation
 * on 2026-08-18: the Subscription object's attribute list has no
 * `current_period_end`, and the example payload carries it only inside
 * `items.data[].current_period_end`. It was a top-level field in older API
 * versions, and a webhook shaped by an account pinned to one of those will
 * still send it there — so both are read, in that order, and neither is a
 * guess. Getting this wrong means every subscriber's access expires
 * immediately, because `isActive` hangs on exactly this date.
 *
 * ## Why the *earliest* item and not the first
 *
 * A subscription can hold several items with different periods. Stripe's own
 * list filter is documented as matching "the minimum item current_period_end",
 * so the earliest is what Stripe means by the subscription's period end. Ours
 * has one item and the two agree; taking `[0]` would have been right by
 * accident and wrong the day a plan gains a second line.
 */
export function readSubscription(object: Record<string, unknown>): StripeSubscription {
  const items = (object.items as { data?: Record<string, unknown>[] } | undefined)?.data ?? [];
  const metadata = (object.metadata as Record<string, string> | undefined) ?? {};
  const itemEnds = items
    .map((i) => i.current_period_end)
    .filter((n): n is number => typeof n === "number" && Number.isFinite(n));
  return {
    id: String(object.id ?? ""),
    customerId: typeof object.customer === "string" ? object.customer : "",
    status: String(object.status ?? ""),
    currentPeriodEnd:
      isoFrom(object.current_period_end) ??
      (itemEnds.length > 0 ? isoFrom(Math.min(...itemEnds)) : null),
    email: metadata.ul_email ?? null,
  };
}

/**
 * The live client. Exercised against `stripe-mock` and against nothing else —
 * see the header for exactly which half of that is real.
 */
export function liveStripe(config: StripeConfig): StripeClient {
  async function call(pathAndQuery: string, body?: URLSearchParams): Promise<Record<string, unknown>> {
    const headers: Record<string, string> = {
      authorization: `Bearer ${config.secretKey}`,
      "stripe-version": STRIPE_API_VERSION,
    };
    if (body) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      // A retry of the same click must not create a second subscription.
      headers["idempotency-key"] = randomUUID();
    }
    const res = await fetch(`${config.apiBase}${pathAndQuery}`, {
      method: body ? "POST" : "GET",
      headers,
      body: body?.toString(),
    });
    const json = (await res.json()) as Record<string, unknown>;
    if (!res.ok) {
      const error = (json.error as { message?: string } | undefined)?.message ?? res.statusText;
      // The key is in `config`, never in a message that reaches a log or a page.
      throw new Error(`stripe ${res.status}: ${error}`);
    }
    return json;
  }

  return {
    async createCheckoutSession({ email, auditId }) {
      /**
       * `ul_email` is set here, server-side, from the address that opened this
       * results page — and it is the only address the webhook will believe.
       *
       * Stripe's form lets the payer type any email they like. If we trusted
       * that, paying would grant access to an arbitrary address, which is the
       * whole authorization model of this product handed to whoever has a card.
       * `customer_email` is prefilled as a convenience; `metadata.ul_email` is
       * the fact.
       */
      const form = new URLSearchParams({
        mode: "subscription",
        "line_items[0][price]": config.priceId,
        "line_items[0][quantity]": "1",
        customer_email: email,
        client_reference_id: auditId,
        "metadata[ul_email]": email,
        "subscription_data[metadata][ul_email]": email,
        success_url: `${config.baseUrl}/a/${auditId}/full?paid=1`,
        cancel_url: `${config.baseUrl}/a/${auditId}/full`,
      });
      const session = await call("/checkout/sessions", form);
      return { id: String(session.id ?? ""), url: String(session.url ?? "") };
    },

    async retrievePrice(priceId) {
      const price = await call(`/prices/${encodeURIComponent(priceId)}`);
      const recurring = price.recurring as { interval?: string } | null | undefined;
      return {
        id: String(price.id ?? ""),
        active: price.active === true,
        type: String(price.type ?? ""),
        interval: recurring?.interval ?? null,
        unitAmount: typeof price.unit_amount === "number" ? price.unit_amount : null,
        currency: String(price.currency ?? ""),
      };
    },

    async listSubscriptions() {
      const out: StripeSubscription[] = [];
      let startingAfter: string | undefined;
      // Paged, because a reconciler that silently reads the first hundred rows
      // would revoke everyone after the hundredth.
      do {
        const query = new URLSearchParams({ limit: "100", status: "all" });
        if (startingAfter) query.set("starting_after", startingAfter);
        const page = await call(`/subscriptions?${query}`);
        const data = (page.data as Record<string, unknown>[] | undefined) ?? [];
        for (const object of data) out.push(readSubscription(object));
        startingAfter = page.has_more === true && data.length > 0 ? String(data[data.length - 1]!.id) : undefined;
      } while (startingAfter);
      return out;
    },
  };
}
