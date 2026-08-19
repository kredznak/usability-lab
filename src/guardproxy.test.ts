import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest, type Server } from "node:http";
import { startGuardProxy, type GuardProxy } from "./guardproxy.js";
import { resolveGuarded } from "./urlcheck.js";

/**
 * The guard proxy — B19.
 *
 * ## What is tested where, and why it is split
 *
 * **The policy** — which addresses count as private — is tested in
 * `urlcheck.test.ts`, range by range, and is not re-tested here. **The
 * plumbing** is tested here: that a refusal actually refuses, that an allowed
 * host actually gets through, that a refusal is recorded rather than silent.
 *
 * They have to be split, because any server this file can start sits on
 * loopback — which is exactly what the policy refuses. So the tests that need
 * to reach a real socket swap `isBlocked`. That injection proves the wiring
 * carries a decision; it does not decide anything, and the real decision is
 * tested against the real ranges in the other file.
 *
 * If that split ever collapses — if someone tests the policy through here with
 * `isBlocked` injected — the suite would be asserting that a function it
 * supplied returns what it supplied.
 */

let origin: Server;
let originPort: number;

before(async () => {
  origin = createServer((req, res) => {
    // Echo the Host header back, because "did the proxy preserve the site's
    // name while dialling an address" is the property that keeps virtual
    // hosting and TLS working.
    res.writeHead(200, { "content-type": "text/plain" });
    res.end(`served ${req.url} host=${req.headers.host}`);
  });
  await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
  originPort = (origin.address() as { port: number }).port;
});

after(() => {
  origin.close();
});

/** A proper proxy request: absolute URI in the request line. */
function proxied(proxyUrl: string, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const proxy = new URL(proxyUrl);
    const req = httpRequest(
      {
        host: proxy.hostname,
        port: Number(proxy.port),
        method: "GET",
        path: target,
        headers: { host: new URL(target).host },
      },
      (res: NodeJS.ReadableStream & { statusCode?: number }) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("what the guard lets through", () => {
  test("an allowed host is reached, and keeps its own name in the Host header", async () => {
    /**
     * `isBlocked` is swapped so a loopback origin is reachable — see the file
     * note. The resolver is swapped too, so `site.test` is a name that resolves
     * without touching DNS.
     */
    const proxy = await startGuardProxy({
      resolve: async () => [{ address: "127.0.0.1", family: 4 }],
      isBlocked: () => false,
    });
    try {
      const res = await proxied(proxy.url, `http://site.test:${originPort}/hello`);
      assert.equal(res.status, 200);
      assert.match(res.body, /served \/hello/);
      // Dialled by address, addressed by name.
      assert.match(res.body, new RegExp(`host=site\\.test:${originPort}`));
      assert.deepEqual(proxy.refusals, []);
    } finally {
      await proxy.close();
    }
  });
});

describe("what the guard refuses", () => {
  test("a host that resolves inward is refused, and the refusal is recorded", async () => {
    // The real policy, unswapped: the resolver answers with cloud metadata.
    const proxy = await startGuardProxy({
      resolve: async () => [{ address: "169.254.169.254", family: 4 }],
    });
    try {
      const res = await proxied(proxy.url, `http://rebound.test:${originPort}/secrets`);
      assert.equal(res.status, 403);
      assert.equal(proxy.refusals.length, 1);
      assert.equal(proxy.refusals[0]!.host, "rebound.test");
      assert.equal(proxy.refusals[0]!.reason, "private-host");
    } finally {
      await proxy.close();
    }
  });

  test("one public answer does not excuse a private one", async () => {
    /**
     * The rebinding shape that a `[0]` check would miss: a name answering with
     * a public address first and loopback second passes most of the time, which
     * is worse than failing always because it survives every manual check.
     */
    const proxy = await startGuardProxy({
      resolve: async () => [
        { address: "93.184.216.34", family: 4 },
        { address: "127.0.0.1", family: 4 },
      ],
    });
    try {
      const res = await proxied(proxy.url, `http://mixed.test:${originPort}/`);
      assert.equal(res.status, 403);
      assert.equal(proxy.refusals[0]!.reason, "private-host");
    } finally {
      await proxy.close();
    }
  });

  test("a name that does not resolve is refused rather than attempted", async () => {
    const proxy = await startGuardProxy({
      resolve: async () => {
        throw new Error("NXDOMAIN");
      },
    });
    try {
      const res = await proxied(proxy.url, `http://gone.test:${originPort}/`);
      assert.equal(res.status, 403);
      assert.equal(proxy.refusals[0]!.reason, "unresolvable");
    } finally {
      await proxy.close();
    }
  });

  test("the proxy listens on loopback only", async () => {
    // A guard proxy reachable from the network is an open proxy, and an open
    // proxy that resolves hosts on your behalf is a gift.
    const proxy = await startGuardProxy();
    try {
      assert.match(proxy.url, /^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await proxy.close();
    }
  });
});

describe("resolveGuarded hands back an address, not a verdict", () => {
  /**
   * The distinction B19 turns on. A function that returns "yes, fine" leaves the
   * caller to resolve the name again, and the second answer is the attacker's.
   */
  test("an allowed host comes back with the address to dial", async () => {
    const verdict = await resolveGuarded("ok.test", async () => [
      { address: "93.184.216.34", family: 4 },
    ]);
    assert.equal(verdict.ok, true);
    assert.equal(verdict.ok && verdict.address, "93.184.216.34");
    assert.equal(verdict.ok && verdict.family, 4);
  });

  test("a literal address needs no lookup at all", async () => {
    let asked = false;
    const verdict = await resolveGuarded("93.184.216.34", async () => {
      asked = true;
      return [];
    });
    assert.equal(verdict.ok, true);
    assert.equal(asked, false, "a literal is already the answer");
  });

  test("a private literal is refused without a lookup", async () => {
    const verdict = await resolveGuarded("169.254.169.254", async () => []);
    assert.equal(verdict.ok === false && verdict.reason, "private-host");
  });

  test("every answer is checked, not the first", async () => {
    const verdict = await resolveGuarded("mixed.test", async () => [
      { address: "93.184.216.34", family: 4 },
      { address: "10.0.0.1", family: 4 },
    ]);
    assert.equal(verdict.ok === false && verdict.reason, "private-host");
  });
});
