import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, request as httpRequest, type Server } from "node:http";
import { liveStripe, STRIPE_API_VERSION, type StripeConfig } from "./stripe.js";

/**
 * `liveStripe` against something that knows Stripe's schema — B21.
 *
 * ## Why this file exists
 *
 * Everything else in `stripe.test.ts` drives a stub I wrote. A stub agrees with
 * whatever the code sends it, so the suite could be 400 tests deep and still not
 * know whether `liveStripe` produces a request Stripe would accept. That was the
 * whole of B21: **no request had ever left the process.**
 *
 * `stripe-mock` is Stripe's own server, built from their OpenAPI spec. Pointing
 * `STRIPE_API_BASE` at it — a seam that already existed — sends the real
 * requests over real HTTP and parses real spec-shaped responses back.
 *
 * ## Exactly how much this proves, measured rather than assumed
 *
 * Probed by hand on 2026-08-19 against stripe-mock 0.202.0:
 *
 * | sent                              | status |
 * |-----------------------------------|--------|
 * | `line_itemz[0][price]`            | 400    |
 * | `subscription_datum[metadata][…]` | 400    |
 * | `subscription_data[nonsense_key]` | 200    |
 * | `line_items[0][quantityy]`        | 200    |
 *
 * **It validates top-level parameter names and nothing below them.** So a
 * misspelled `subscription_data` is caught here and a misspelled
 * `subscription_data[metadata]` is not — and that nested key is the one B21
 * calls the highest risk in the file, because getting it wrong means every
 * customer pays and is never granted access. That case is still only covered by
 * reading Stripe's documentation, and it is still the reason B21 stays open.
 *
 * What is genuinely new here: the form encoding, the auth header, the pinned
 * version, the idempotency key, the paging loop, and `readSubscription` reading
 * a subscription object shaped by Stripe's spec instead of by my typing.
 *
 * ## Why there is a recorder in front of the mock
 *
 * stripe-mock returns fixtures. It echoes `client_reference_id` and the URLs
 * back, but `metadata` comes back `{}` no matter what you send — so the fields
 * this integration actually depends on are invisible from the response alone.
 * The recorder is a plain forwarding proxy that keeps what went past it, which
 * is the only way to assert on a header or on a body key the fixture drops.
 *
 * ## Skipping
 *
 * If `stripe-mock` is not installed every test here skips rather than fails.
 * A machine without it is missing a Homebrew formula, not a working product,
 * and a red suite for that would train people to ignore red suites.
 */

interface Recorded {
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

let mock: ChildProcess | null = null;
let recorder: Server | null = null;
let config: StripeConfig | null = null;
const seen: Recorded[] = [];

/** Spawn stripe-mock on an ephemeral port and wait for it to say which one. */
function startMock(): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn("stripe-mock", ["-http-port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
    mock = child;
    const timer = setTimeout(() => reject(new Error("stripe-mock did not announce a port")), 10_000);
    const onData = (chunk: Buffer) => {
      const match = /Listening for HTTP at address: .*:(\d+)/.exec(chunk.toString());
      if (match) {
        clearTimeout(timer);
        resolve(Number(match[1]));
      }
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData); // it has announced on either, depending on version
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err); // ENOENT when it is not installed
    });
  });
}

/** A forwarding proxy that keeps a copy of every request. */
function startRecorder(upstreamPort: number): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        seen.push({ method: req.method ?? "", path: req.url ?? "", headers: { ...req.headers }, body });
        const upstream = httpRequest(
          { host: "127.0.0.1", port: upstreamPort, method: req.method, path: req.url, headers: req.headers },
          (upstreamRes) => {
            res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
            upstreamRes.pipe(res);
          },
        );
        upstream.on("error", () => res.writeHead(502).end());
        upstream.end(body);
      });
    });
    recorder = server;
    server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
}

/**
 * Distinctive on purpose. stripe-mock's own 401 text contains the literal
 * `sk_test_123` as an example, so a key-leak assertion written against that
 * string would fail on Stripe's prose rather than on our bug.
 *
 * No underscores after the prefix: stripe-mock demands a "valid looking testmode
 * secret API key" and 401s on `sk_test_NEVER_LOG_THIS_9f3a` while accepting
 * `sk_test_NEVERLOGTHIS9f3a`. Worth knowing, because a 401 from that rule looks
 * exactly like a 401 from a wrong key.
 */
const SECRET = "sk_test_NEVERLOGTHIS9f3a";

before(async () => {
  let mockPort: number;
  try {
    mockPort = await startMock();
  } catch {
    mock = null;
    return; // not installed — every test below skips
  }
  const recorderPort = await startRecorder(mockPort);
  config = {
    secretKey: SECRET,
    priceId: "price_123",
    webhookSecret: "whsec_test",
    baseUrl: "https://lab.example",
    apiBase: `http://127.0.0.1:${recorderPort}/v1`,
  };
});

after(() => {
  mock?.kill();
  recorder?.close();
});

/** The last request the recorder saw, which is the one the test just made. */
function lastRequest(): Recorded {
  const last = seen[seen.length - 1];
  assert.ok(last, "the recorder saw nothing — liveStripe did not send a request");
  return last;
}

describe("a checkout session, sent", () => {
  test("Stripe's own schema accepts the form we build", async (t) => {
    if (!config) return t.skip("stripe-mock is not installed");
    const session = await liveStripe(config).createCheckoutSession({
      email: "buyer@example.com",
      auditId: "aud-42",
    });
    // A fixture id, but a real round trip: parsed out of a spec-shaped response.
    assert.match(session.id, /^cs_/);
    assert.match(session.url, /^https:\/\//);
  });

  test("the metadata the whole authorization model rests on is in the body", async (t) => {
    if (!config) return t.skip("stripe-mock is not installed");
    await liveStripe(config).createCheckoutSession({ email: "buyer@example.com", auditId: "aud-42" });
    const body = new URLSearchParams(lastRequest().body);

    /**
     * Both copies, because they answer different webhooks: the session carries
     * one and the subscription carries the other, and it is the subscription's
     * that every `customer.subscription.*` event is attributed by.
     *
     * The response cannot show this — stripe-mock returns `metadata: {}` for
     * anything you send. Only the recorder can.
     */
    assert.equal(body.get("metadata[ul_email]"), "buyer@example.com");
    assert.equal(body.get("subscription_data[metadata][ul_email]"), "buyer@example.com");

    assert.equal(body.get("line_items[0][price]"), "price_123");
    assert.equal(body.get("line_items[0][quantity]"), "1");
    assert.equal(body.get("mode"), "subscription");
    // `paid=1` is what the results page reads to say "Payment received".
    assert.equal(body.get("success_url"), "https://lab.example/a/aud-42/full?paid=1");
    assert.equal(body.get("cancel_url"), "https://lab.example/a/aud-42/full");
    assert.equal(body.get("client_reference_id"), "aud-42");
  });

  test("the version we verified the field names against is the version we send", async (t) => {
    if (!config) return t.skip("stripe-mock is not installed");
    await liveStripe(config).createCheckoutSession({ email: "b@example.com", auditId: "aud-1" });
    const req = lastRequest();
    // Pinned rather than omitted: the docs B21 checked were that version's docs.
    assert.equal(req.headers["stripe-version"], STRIPE_API_VERSION);
    assert.equal(req.headers.authorization, `Bearer ${SECRET}`);
    assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded");
  });

  test("a retried click cannot buy twice", async (t) => {
    if (!config) return t.skip("stripe-mock is not installed");
    const client = liveStripe(config);
    await client.createCheckoutSession({ email: "b@example.com", auditId: "aud-1" });
    const first = lastRequest().headers["idempotency-key"];
    await client.createCheckoutSession({ email: "b@example.com", auditId: "aud-1" });
    const second = lastRequest().headers["idempotency-key"];
    assert.ok(first, "a POST with no idempotency key is a double charge waiting for a flaky network");
    assert.notEqual(first, second, "a fresh key per call, or every session after the first is swallowed");
  });

  test("a read carries no idempotency key, because there is nothing to make idempotent", async (t) => {
    if (!config) return t.skip("stripe-mock is not installed");
    await liveStripe(config).retrievePrice("price_123");
    const req = lastRequest();
    assert.equal(req.method, "GET");
    assert.equal(req.headers["idempotency-key"], undefined);
  });
});

describe("what comes back, shaped by Stripe rather than by me", () => {
  test("a price parses, and the recurring fields the preflight blocks on are there", async (t) => {
    if (!config) return t.skip("stripe-mock is not installed");
    const price = await liveStripe(config).retrievePrice("price_123");
    assert.equal(price.id, "price_123");
    assert.equal(price.type, "recurring");
    assert.equal(price.interval, "month"); // read out of the nested `recurring` object
    assert.equal(price.active, true);
    assert.equal(price.currency, "usd");
    assert.equal(typeof price.unitAmount, "number");
  });

  test("a subscription's period end is found where Stripe actually puts it", async (t) => {
    if (!config) return t.skip("stripe-mock is not installed");
    const subs = await liveStripe(config).listSubscriptions();
    assert.ok(subs.length > 0, "the fixture list should not be empty");
    const sub = subs[0]!;
    assert.match(sub.id, /^sub_/);
    /**
     * B21's first finding, confirmed a second time and from a different source.
     * The docs said `current_period_end` had moved into `items.data[]`; this is
     * Stripe's OpenAPI spec agreeing, and it is the field access is granted by.
     * Null here means every customer pays and stays locked out.
     */
    assert.ok(sub.currentPeriodEnd, "no period end means no access, for everybody");
    assert.match(sub.currentPeriodEnd!, /^\d{4}-\d{2}-\d{2}T/);
    assert.ok(sub.status.length > 0);
  });

  test("the list is asked for every status, not just the paying ones", async (t) => {
    if (!config) return t.skip("stripe-mock is not installed");
    await liveStripe(config).listSubscriptions();
    const req = lastRequest();
    // `reconcile` revokes as well as grants, so it has to see the cancelled ones.
    assert.match(req.path, /status=all/);
    assert.match(req.path, /limit=100/);
  });
});

describe("when Stripe says no", () => {
  test("an error becomes a message, and the message is not the key", async (t) => {
    if (!config) return t.skip("stripe-mock is not installed");
    // Same server, wrong root — the cheapest way to make a real Stripe-shaped
    // error come back over a real socket.
    const wrong = { ...config, apiBase: `${config.apiBase}/nowhere` };
    await assert.rejects(
      () => liveStripe(wrong).retrievePrice("price_123"),
      (err: Error) => {
        assert.match(err.message, /^stripe 404: /);
        assert.match(err.message, /Unrecognized request URL/); // Stripe's words, passed through
        assert.ok(!err.message.includes(SECRET), "the secret key must never reach a log or a page");
        return true;
      },
    );
  });
});

describe("the canary", () => {
  /**
   * Every assertion above is worth exactly as much as stripe-mock's willingness
   * to refuse a bad request. If a future version stops validating, these tests
   * would keep passing while checking nothing — the failure mode this project
   * keeps meeting, where a thing that looks like it works is the bug.
   *
   * So: send a deliberately misspelled top-level parameter and require a 400.
   * When this goes green-by-accident, it goes red instead.
   */
  test("stripe-mock still rejects a parameter Stripe does not have", async (t) => {
    if (!config) return t.skip("stripe-mock is not installed");
    const res = await fetch(`${config.apiBase}/checkout/sessions`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        mode: "subscription",
        "line_items[0][price]": "price_123",
        success_url: "https://lab.example/ok",
        "subscription_datum[metadata][ul_email]": "b@example.com",
      }).toString(),
    });
    assert.equal(res.status, 400, "the schema check these tests rely on has stopped happening");
  });
});
