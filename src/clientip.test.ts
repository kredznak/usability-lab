import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { clientIp, CLIENT_IP_HEADER_VAR } from "./clientip.js";

/**
 * Who the rate limiter thinks you are.
 *
 * ## The bug this exists to prevent
 *
 * `asksByClient` allows five audit requests an hour per client, keyed on
 * `req.socket.remoteAddress`. That is honest on localhost and becomes **the
 * proxy's address** the moment anything terminates TLS in front of the app —
 * so every visitor lands in one bucket and the sixth request from anyone on
 * earth is refused. A per-client limit silently becomes a per-site one, and it
 * looks like a broken router rather than a rate limit.
 *
 * ## And the bug it must not introduce
 *
 * The obvious fix — read `X-Forwarded-For` — is worse than the disease. A
 * header the client sets turns a per-client limit into a per-header-value one,
 * which is no limit at all: anyone wanting a hundred audits sends a hundred
 * different values. `server.ts` has said so in a comment since B16.
 *
 * So the header is trusted only when an operator names it, and the default is
 * exactly today's behaviour. The load-bearing test is the first one below: a
 * spoofed header with nothing configured must be ignored.
 */

const ORIGINAL = process.env[CLIENT_IP_HEADER_VAR];

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env[CLIENT_IP_HEADER_VAR];
  else process.env[CLIENT_IP_HEADER_VAR] = ORIGINAL;
});

/** The two fields of a request this actually reads. */
function req(socket: string | undefined, headers: Record<string, string | string[]> = {}) {
  return { socket: { remoteAddress: socket }, headers };
}

describe("with nothing configured, headers are not trusted", () => {
  test("a spoofed header is ignored entirely", () => {
    delete process.env[CLIENT_IP_HEADER_VAR];
    const got = clientIp(
      req("203.0.113.9", {
        "x-forwarded-for": "1.2.3.4",
        "cf-connecting-ip": "5.6.7.8",
        "x-real-ip": "9.9.9.9",
      }),
    );
    assert.equal(got, "203.0.113.9", "the socket is the only source until an operator says otherwise");
  });

  test("a request with no socket address is not a crash", () => {
    delete process.env[CLIENT_IP_HEADER_VAR];
    assert.equal(clientIp(req(undefined)), "unknown");
  });
});

describe("when an operator names the header in front", () => {
  test("that header is used", () => {
    process.env[CLIENT_IP_HEADER_VAR] = "cf-connecting-ip";
    assert.equal(clientIp(req("127.0.0.1", { "cf-connecting-ip": "203.0.113.7" })), "203.0.113.7");
  });

  test("the name is matched case-insensitively, because Node lowercases headers", () => {
    process.env[CLIENT_IP_HEADER_VAR] = "CF-Connecting-IP";
    assert.equal(clientIp(req("127.0.0.1", { "cf-connecting-ip": "203.0.113.7" })), "203.0.113.7");
  });

  test("only the named header counts — others are still ignored", () => {
    process.env[CLIENT_IP_HEADER_VAR] = "cf-connecting-ip";
    const got = clientIp(req("127.0.0.1", { "x-forwarded-for": "1.2.3.4" }));
    assert.equal(got, "127.0.0.1", "naming one header does not trust the rest");
  });

  test("a missing header falls back to the socket rather than failing", () => {
    // A proxy that stops sending it is a misconfiguration, not a reason to 500.
    // The limit degrades to per-proxy, which is the behaviour we had before.
    process.env[CLIENT_IP_HEADER_VAR] = "cf-connecting-ip";
    assert.equal(clientIp(req("127.0.0.1", {})), "127.0.0.1");
  });

  test("an empty header falls back too", () => {
    process.env[CLIENT_IP_HEADER_VAR] = "cf-connecting-ip";
    assert.equal(clientIp(req("127.0.0.1", { "cf-connecting-ip": "   " })), "127.0.0.1");
  });

  test("a comma list takes the last entry, not the first", () => {
    /**
     * `X-Forwarded-For` reads `client, proxy1, proxy2` — appended left to right.
     * The **leftmost** is what the original caller claimed and is freely
     * forgeable; the **rightmost** is what the nearest proxy actually observed.
     * With exactly one trusted hop, that is the real peer.
     *
     * Which is why the runbook names `cf-connecting-ip` instead: Cloudflare
     * writes a single value and overwrites anything a client sent, so there is
     * no hop-counting to get wrong.
     */
    process.env[CLIENT_IP_HEADER_VAR] = "x-forwarded-for";
    assert.equal(clientIp(req("127.0.0.1", { "x-forwarded-for": "1.2.3.4, 203.0.113.7" })), "203.0.113.7");
  });

  test("a repeated header is handled, since Node gives an array", () => {
    process.env[CLIENT_IP_HEADER_VAR] = "x-forwarded-for";
    assert.equal(clientIp(req("127.0.0.1", { "x-forwarded-for": ["1.2.3.4", "203.0.113.7"] })), "203.0.113.7");
  });

  test("a header long enough to be an attack is refused, not used as a key", () => {
    // The value becomes a Map key in a SlidingWindow. B16's lesson was that an
    // attacker-chosen key must not be able to grow an unbounded map, and a
    // 4KB header value is a cheap way to try.
    process.env[CLIENT_IP_HEADER_VAR] = "cf-connecting-ip";
    assert.equal(clientIp(req("127.0.0.1", { "cf-connecting-ip": "9".repeat(200) })), "127.0.0.1");
  });
});
