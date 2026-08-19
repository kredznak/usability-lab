import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import {
  verifyWebhook,
  signWebhook,
  mapStatus,
  stripeConfig,
  readSubscription,
  WEBHOOK_TOLERANCE_MS,
} from "./stripe.js";

/**
 * The webhook verifier, which is the most dangerous function in the repo.
 *
 * `/stripe/webhook` is public and authenticated by a signature and nothing else
 * — no cookie, no CSRF token, no session. If this function can be fooled, anyone
 * on the internet can grant themselves a subscription by POSTing JSON at us. So
 * every way in that occurred to me gets a test, and the signatures are
 * **computed** rather than pasted: a fixture copied out of a passing run proves
 * only that the code still does what it did.
 */

const SECRET = "whsec_test_not_a_real_secret";

/** The refusal reason, or `null` when it was accepted. Keeps the asserts readable. */
function reasonOf(result: ReturnType<typeof verifyWebhook>): string | null {
  return result.ok ? null : result.reason;
}
const BODY = JSON.stringify({
  id: "evt_1",
  type: "customer.subscription.updated",
  data: { object: { id: "sub_1", status: "active", customer: "cus_1" } },
});

describe("a webhook signature", () => {
  test("a real one is accepted and the event comes back parsed", () => {
    const result = verifyWebhook(BODY, signWebhook(BODY, SECRET), SECRET);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.event.type, "customer.subscription.updated");
    assert.equal(result.ok && result.event.data.object.id, "sub_1");
  });

  test("a changed body is rejected, even by one character", () => {
    const header = signWebhook(BODY, SECRET);
    const tampered = BODY.replace('"status":"active"', '"status":"canceled"');
    assert.notEqual(tampered, BODY);
    const result = verifyWebhook(tampered, header, SECRET);
    assert.equal(result.ok === false && result.reason, "bad-signature");
  });

  test("another secret does not open it", () => {
    const header = signWebhook(BODY, "whsec_someone_elses");
    assert.equal(verifyWebhook(BODY, header, SECRET).ok, false);
  });

  test("no header at all is refused before anything else happens", () => {
    assert.equal(reasonOf(verifyWebhook(BODY, undefined, SECRET)), "no-header");
    assert.equal(reasonOf(verifyWebhook(BODY, "", SECRET)), "no-header");
  });

  test("a header that is not a header is malformed, not a crash", () => {
    for (const junk of ["nonsense", "t=", "v1=abc", "t=abc,v1=def", "t=1,,", "=,="]) {
      const reason = reasonOf(verifyWebhook(BODY, junk, SECRET));
      assert.ok(reason && ["malformed", "stale", "bad-signature"].includes(reason), `${junk} -> ${reason}`);
    }
  });

  test("a signature of the wrong length does not throw", () => {
    // `timingSafeEqual` throws on a length mismatch rather than returning
    // false, and a throw here would be a 500 on a route whose entire job is to
    // reject things calmly.
    const result = verifyWebhook(BODY, "t=1755000000,v1=short", SECRET);
    assert.equal(result.ok, false);
  });

  test("an old signature is stale — the replay window is real", () => {
    /**
     * Without this, the signature over a captured request stays valid forever.
     * Anyone who ever saw one `customer.subscription.updated` could replay it
     * whenever they liked, which for a *renewal* event means free access for as
     * long as they cared to keep sending it.
     */
    const now = Date.parse("2026-08-18T12:00:00.000Z");
    const header = signWebhook(BODY, SECRET, now - WEBHOOK_TOLERANCE_MS - 1000);
    assert.equal(reasonOf(verifyWebhook(BODY, header, SECRET, now)), "stale");
  });

  test("and one from the future is stale too", () => {
    // Clock skew cuts both ways; a signature dated next week is not a signature
    // we should honour for a week.
    const now = Date.parse("2026-08-18T12:00:00.000Z");
    const header = signWebhook(BODY, SECRET, now + WEBHOOK_TOLERANCE_MS + 1000);
    assert.equal(verifyWebhook(BODY, header, SECRET, now).ok, false);
  });

  test("one inside the window is fine", () => {
    const now = Date.parse("2026-08-18T12:00:00.000Z");
    const header = signWebhook(BODY, SECRET, now - WEBHOOK_TOLERANCE_MS + 1000);
    assert.equal(verifyWebhook(BODY, header, SECRET, now).ok, true);
  });

  test("two v1 signatures are normal, and the second one counts", () => {
    /**
     * Stripe signs with both secrets during a rotation. Accepting only the
     * first `v1` would break every webhook for the length of a rotation —
     * which is exactly the window in which nobody is watching the logs.
     */
    const t = Math.floor(Date.now() / 1000);
    const good = createHmac("sha256", SECRET).update(`${t}.${BODY}`).digest("hex");
    const decoy = createHmac("sha256", "whsec_old").update(`${t}.${BODY}`).digest("hex");
    assert.equal(verifyWebhook(BODY, `t=${t},v1=${decoy},v1=${good}`, SECRET).ok, true);
  });

  test("the signature is checked before the JSON is parsed", () => {
    /**
     * Two halves of one property, and both are needed.
     *
     * A correctly signed body that is not JSON reports `malformed` — so the
     * parse does run, eventually. A well-formed *event* carrying a wrong
     * signature reports `bad-signature` rather than anything about its
     * contents — which is only true if the parse had not run yet. An
     * unverified body is attacker-controlled JSON and there is no reason to
     * hand it to a parser; this is the assertion that says so.
     */
    const notJson = "{{{{";
    assert.equal(reasonOf(verifyWebhook(notJson, signWebhook(notJson, SECRET), SECRET)), "malformed");

    // Fresh timestamp, wrong signature — so `stale` cannot be what refuses it.
    const t = Math.floor(Date.now() / 1000);
    assert.equal(reasonOf(verifyWebhook(BODY, `t=${t},v1=${"0".repeat(64)}`, SECRET)), "bad-signature");
  });

  test("a signed body that is JSON but not an event is malformed", () => {
    for (const body of ['"just a string"', "null", "[]", '{"type":"x"}', '{"data":{}}']) {
      assert.equal(reasonOf(verifyWebhook(body, signWebhook(body, SECRET), SECRET)), "malformed", body);
    }
  });
});

describe("Stripe's status vocabulary, narrowed", () => {
  test("the ones that mean paying", () => {
    assert.equal(mapStatus("active"), "active");
    assert.equal(mapStatus("trialing"), "active");
  });

  test("the ones that mean something went wrong with the money", () => {
    for (const s of ["past_due", "unpaid", "incomplete"]) assert.equal(mapStatus(s), "past_due");
  });

  test("the ones that mean it is over", () => {
    for (const s of ["canceled", "incomplete_expired", "paused"]) assert.equal(mapStatus(s), "canceled");
  });

  test("a status nobody has seen before grants nothing", () => {
    // Stripe adds statuses without asking us. The safe direction is a customer
    // who has to email — not a stranger who keeps access.
    for (const s of ["", "sleeping", "active_ish", "ACTIVE"]) assert.equal(mapStatus(s), "canceled", s);
  });
});

describe("configured, or honestly nothing", () => {
  const full = {
    STRIPE_SECRET_KEY: "sk_test_x",
    STRIPE_PRICE_ID: "price_x",
    STRIPE_WEBHOOK_SECRET: "whsec_x",
  };

  test("all three gives a config", () => {
    const config = stripeConfig(full);
    assert.ok(config);
    assert.equal(config.priceId, "price_x");
  });

  test("any one missing gives nothing at all", () => {
    // There is no half-live state on purpose: a secret key without a webhook
    // secret would take money and never grant access.
    for (const key of Object.keys(full)) {
      const partial = { ...full, [key]: undefined };
      assert.equal(stripeConfig(partial), null, `missing ${key}`);
    }
    assert.equal(stripeConfig({}), null);
  });

  test("the base URL defaults to the port we are actually on", () => {
    assert.equal(stripeConfig({ ...full, PORT: "4141" })?.baseUrl, "http://localhost:4141");
  });

  test("and never keeps a trailing slash, because every use appends a path", () => {
    const config = stripeConfig({ ...full, USABILITY_LAB_BASE_URL: "https://lab.example///" });
    assert.equal(config?.baseUrl, "https://lab.example");
  });
});

describe("reading a subscription off the wire", () => {
  test("the fields we store, from where Stripe puts them", () => {
    const sub = readSubscription({
      id: "sub_9",
      customer: "cus_9",
      status: "active",
      current_period_end: 1789000000,
      metadata: { ul_email: "kelly@example.com" },
    });
    assert.equal(sub.id, "sub_9");
    assert.equal(sub.customerId, "cus_9");
    assert.equal(sub.email, "kelly@example.com");
    assert.equal(sub.currentPeriodEnd, new Date(1789000000 * 1000).toISOString());
  });

  test("the period end is also read off the first item", () => {
    /**
     * Stripe moved `current_period_end` down onto subscription items in recent
     * API versions, and nothing here can check which version an account is
     * pinned to. Reading both costs four lines; reading only the old place
     * means every subscriber's access expires immediately, because `isActive`
     * hangs on exactly this date.
     */
    const sub = readSubscription({
      id: "sub_9",
      status: "active",
      items: { data: [{ current_period_end: 1789000000 }] },
    });
    assert.equal(sub.currentPeriodEnd, new Date(1789000000 * 1000).toISOString());
  });

  test("an object missing everything comes back empty rather than throwing", () => {
    const sub = readSubscription({});
    assert.equal(sub.currentPeriodEnd, null);
    assert.equal(sub.email, null);
    assert.equal(sub.customerId, "");
  });

  test("a period end that is not a number is null, not a date in 1970", () => {
    assert.equal(readSubscription({ current_period_end: "soon" }).currentPeriodEnd, null);
    assert.equal(readSubscription({ current_period_end: null }).currentPeriodEnd, null);
  });
});
