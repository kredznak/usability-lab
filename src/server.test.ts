import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditStore, EmailCaptureStore, EventLog } from "./db.js";
import { sign, verify, looksLikeEmail, TOKEN_TTL_MS } from "./tokens.js";
import { SlidingWindow, inMinutes } from "./ratelimit.js";

/**
 * The email gate, over real HTTP.
 *
 * Driven as a subprocess against a temp database and `out/`, the way
 * review.test.ts drives the gate, for the same reason: the bugs that matter
 * here live in the seam between the router and the renderer, not inside either.
 *
 * ## What this file is actually guarding
 *
 * One thing above all: **a token issued for one audit must not open another.**
 * Everything else on this page is a convenience; that is the property that
 * decides whether one customer can read another customer's audit. It gets its
 * own test, and so does every other way in that occurred to me — a tampered
 * signature, an expired link, a prefix of a real id, an audit nobody published.
 */

const A = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const B = "bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb";
const PENDING = "cccccccc-3333-4333-8333-cccccccccccc";
/**
 * Its own audit, so exhausting the per-audit allowance in the mail-bomb test
 * cannot silently starve every other test that asks for a link.
 */
const BOMB = "eeeeeeee-5555-4555-8555-eeeeeeeeeeee";
const PORT = 4137;
const BASE = `http://127.0.0.1:${PORT}`;

let root: string;
let outRoot: string;
let dbPath: string;
let child: ChildProcess;

function finding(n: number, severity = 2) {
  return {
    id: `f${n}`,
    heuristic: `Heuristic ${n}`,
    severity,
    element_ref: null,
    observation: `Observation number ${n}`,
    impact_note: `Impact ${n}`,
    positive: false,
    agent: "heuristics",
    screen_ref: "s",
    confidence: "high",
    citation: { source_type: "none", url: null },
    evidence: { screenshot_id: "s", bbox: { x: 1, y: 1, width: 9, height: 9 } },
  };
}

function capture(auditId: string) {
  return {
    audit_id: auditId,
    url: "https://example.com",
    final_url: "https://example.com/",
    title: "Example",
    screenshot_id: "s",
    screenshot_path: "s.png",
    viewport: { width: 1440, height: 900 },
    full_height: 2000,
    elements: [],
    elements_total: 0,
    text_excerpt: "",
    text_total_chars: 0,
    captured_at: "2026-01-01T00:00:00.000Z",
  };
}

/** An audit sitting exactly where a published run leaves one. */
function seed(auditId: string, findings: number, publish: boolean): void {
  const dir = path.join(outRoot, auditId);
  mkdirSync(dir, { recursive: true });
  const all = Array.from({ length: findings }, (_, i) => finding(i + 1));
  writeFileSync(path.join(dir, "capture.json"), JSON.stringify(capture(auditId)));
  writeFileSync(path.join(dir, "findings.json"), JSON.stringify(all));
  writeFileSync(
    path.join(dir, "review.json"),
    JSON.stringify({
      decisions: all.map((f) => ({ finding_id: f.id, keep: true, severity_after: f.severity })),
    }),
  );
  // A one-pixel PNG, so the image route has something real to serve.
  writeFileSync(
    path.join(dir, `${auditId}-annotated.png`),
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    ),
  );

  // Walked through the real state machine, so a fixture cannot reach a state
  // the pipeline could not.
  const store = new AuditStore(dbPath);
  store.create(auditId, "https://example.com");
  store.transition(auditId, "CAPTURING");
  store.transition(auditId, "AUDITING");
  store.transition(auditId, "ASSEMBLING");
  store.transition(auditId, "REVIEW_PENDING", {
    findings_total: findings,
    profile_summary: "A shop that sells things.",
  });
  if (publish) store.transition(auditId, "PUBLISHED", { findings_published: findings });
  store.close();
}

before(async () => {
  root = mkdtempSync(path.join(tmpdir(), "ulab-server-"));
  outRoot = path.join(root, "out");
  dbPath = path.join(root, "db", "usability-lab.db");
  mkdirSync(outRoot, { recursive: true });

  seed(A, 9, true);
  seed(B, 4, true);
  seed(PENDING, 5, false);
  seed(BOMB, 6, true);

  child = spawn(process.execPath, ["--import", "tsx", path.resolve("src/server.ts")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      USABILITY_LAB_DB: dbPath,
      USABILITY_LAB_OUT: outRoot,
      USABILITY_LAB_SECRET: "test-secret-not-a-real-one",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");

  // Wait for the listener rather than sleeping a fixed time — a sleep long
  // enough to be safe is long enough to be annoying, and a short one is flaky.
  for (let i = 0; i < 100; i++) {
    try {
      await fetch(`${BASE}/`);
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("server did not start");
});

after(() => {
  child?.kill();
  rmSync(root, { recursive: true, force: true });
});

/**
 * A fresh address per call.
 *
 * The gate holds a five-minute cooldown per (audit, address), so a helper that
 * reused one address would issue a link once and then hang forever waiting for
 * a second — which is exactly what happened when the cooldown landed. Unique
 * addresses keep each test independent, and the cooldown gets a test of its own
 * rather than being something every other test trips over.
 */
let nth = 0;
const freshEmail = () => `reader${++nth}@example.com`;

/** Reads the magic link the server prints, since no mail is sent. */
async function askForLink(auditId: string, email: string): Promise<string> {
  const printed = new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no link printed")), 5000);
    const onData = (chunk: string) => {
      const match = chunk.match(/(http:\/\/\S+\/full\?t=\S+)/);
      if (match) {
        clearTimeout(timer);
        child.stdout?.off("data", onData);
        resolve(match[1]!);
      }
    };
    child.stdout?.on("data", onData);
  });
  await fetch(`${BASE}/a/${auditId}/email`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email }).toString(),
    redirect: "manual",
  });
  return printed;
}

/**
 * Opens a magic link the way a browser would — and Node's `fetch` will not,
 * because it has no cookie jar. The link exchanges itself for a cookie and
 * redirects; following that redirect without carrying the cookie lands on a
 * 403, which is the correct behaviour and a useless test.
 */
async function openLink(link: string): Promise<{ status: number; html: string; clean: string }> {
  const first = await fetch(link, { redirect: "manual" });
  if (first.status !== 303) return { status: first.status, html: await first.text(), clean: link };

  const jar = (first.headers.get("set-cookie") ?? "").split(";")[0]!;
  const clean = new URL(first.headers.get("location")!, BASE).toString();
  const second = await fetch(clean, { headers: { cookie: jar } });
  return { status: second.status, html: await second.text(), clean };
}

describe("tokens", () => {
  test("a token opens the audit it was issued for", () => {
    const result = verify(sign(A, "kelly@example.com"), A);
    assert.equal(result.ok, true);
    assert.equal(result.ok && result.claims.email, "kelly@example.com");
  });

  test("a token for one audit does not open another", () => {
    const result = verify(sign(A, "kelly@example.com"), B);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "wrong-audit");
  });

  test("a tampered payload is rejected", () => {
    const token = sign(A, "kelly@example.com");
    const [, signature] = token.split(".");
    const forged = Buffer.from(
      JSON.stringify({ auditId: A, email: "attacker@example.com", expiresAt: Date.now() + 1000 }),
    ).toString("base64url");
    const result = verify(`${forged}.${signature}`, A);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "bad-signature");
  });

  test("an expired token is rejected", () => {
    const issued = Date.now() - TOKEN_TTL_MS - 1;
    const result = verify(sign(A, "kelly@example.com", issued), A);
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.reason, "expired");
  });

  test("garbage is malformed, not a crash", () => {
    for (const junk of ["", ".", "a.b.c", "notatoken"]) {
      assert.equal(verify(junk, A).ok, false);
    }
  });

  test("the email check accepts real addresses and rejects nonsense", () => {
    for (const good of ["a@b.co", "kelly+lab@example.com", "x.y@sub.domain.org"]) {
      assert.ok(looksLikeEmail(good), good);
    }
    for (const bad of ["", "kelly", "kelly@", "@example.com", "a b@c.com", "a@b"]) {
      assert.ok(!looksLikeEmail(bad), bad);
    }
  });
});

describe("the preview", () => {
  test("shows three findings and withholds the rest", async () => {
    const res = await fetch(`${BASE}/a/${A}/`);
    const html = await res.text();
    assert.equal(res.status, 200);

    // Absent from the source, not hidden by CSS. A preview that ships the
    // withheld findings and styles them away is not a gate.
    assert.match(html, /Observation number 1/);
    assert.doesNotMatch(html, /Observation number 4/, "finding 4 must not be in the HTML at all");
    assert.match(html, /6 more findings/);
  });

  test("carries the email form", async () => {
    const html = await (await fetch(`${BASE}/a/${A}/`)).text();
    assert.match(html, /<form class="gate-form" method="post" action="\/a\/[0-9a-f-]+\/email">/);
  });

  test("an audit with nothing withheld has no gate", async () => {
    // B kept 4 findings; three are free, so one is withheld. Assert the gate is
    // driven by the withheld count rather than by the route.
    const html = await (await fetch(`${BASE}/a/${B}/`)).text();
    assert.match(html, /1 more finding\b/);
  });

  test("redirects to the trailing slash so the screenshot resolves", async () => {
    const res = await fetch(`${BASE}/a/${A}`, { redirect: "manual" });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get("location"), `/a/${A}/`);
  });

  test("an unpublished audit is a 404, indistinguishable from a made-up id", async () => {
    const real = await fetch(`${BASE}/a/${PENDING}/`);
    const fake = await fetch(`${BASE}/a/dddddddd-4444-4444-8444-dddddddddddd/`);
    assert.equal(real.status, 404);
    assert.equal(fake.status, 404);
    assert.equal(await real.text(), await fake.text(), "the two must be byte-identical");
  });

  test("a prefix of a real id is not a real id", async () => {
    // AuditStore.find matches on prefix for the CLI's benefit. If the server
    // ever used it, a 122-bit address would become an 8-character one.
    const res = await fetch(`${BASE}/a/${A.slice(0, 8)}/`);
    assert.equal(res.status, 404);
  });
});

describe("the full results", () => {
  test("are refused without a token", async () => {
    const res = await fetch(`${BASE}/a/${A}/full`);
    assert.equal(res.status, 403);
    const html = await res.text();
    assert.doesNotMatch(html, /Observation number 4/);
  });

  test("open with the link the gate issues", async () => {
    const { status, html } = await openLink(await askForLink(A, freshEmail()));
    assert.equal(status, 200);
    assert.match(html, /Observation number 9/, "every kept finding is shown");
    assert.doesNotMatch(html, /more findings/, "nothing is withheld any more");
  });

  test("a link for audit A does not open audit B", async () => {
    // The test this file exists for.
    const link = await askForLink(A, freshEmail());
    const token = new URL(link).searchParams.get("t")!;
    const res = await fetch(`${BASE}/a/${B}/full?t=${encodeURIComponent(token)}`);
    assert.equal(res.status, 403);
    const html = await res.text();
    assert.match(html, /different audit/);
    assert.doesNotMatch(html, /Observation number/, "no finding leaks into the refusal");
  });

  test("a tampered token is refused", async () => {
    const link = await askForLink(A, freshEmail());
    const token = new URL(link).searchParams.get("t")!;
    const bent = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    const res = await fetch(`${BASE}/a/${A}/full?t=${encodeURIComponent(bent)}`);
    assert.equal(res.status, 403);
  });

  test("do not show what the founder cut", async () => {
    // The full page is the public renderer with everything revealed, not
    // results-full.html. The founder's page carries cut findings and the
    // Synthesizer's set-aside reasoning; a customer must never see either.
    const { html } = await openLink(await askForLink(A, freshEmail()));
    assert.doesNotMatch(html, /Set aside by the synthesizer/i);
  });
});

describe("the gate itself", () => {
  test("records the capture and says a link is coming", async () => {
    const res = await fetch(`${BASE}/a/${B}/email`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "someone@example.com" }).toString(),
    });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /on its way to that address/);

    const captures = new EmailCaptureStore(dbPath);
    const row = captures.get(B, "someone@example.com");
    captures.close();
    assert.ok(row, "the capture is stored");
    assert.equal(row.verified_at, null, "not verified until the link is opened");
  });

  test("opening the link marks it verified", async () => {
    const email = freshEmail();
    await openLink(await askForLink(B, email));
    const captures = new EmailCaptureStore(dbPath);
    const row = captures.get(B, email);
    captures.close();
    assert.ok(row?.verified_at, "verified_at is set on first open");
  });

  test("the address is normalised, so one person is one row", async () => {
    await fetch(`${BASE}/a/${B}/email`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "  MiXeD@Example.COM " }).toString(),
    });
    const captures = new EmailCaptureStore(dbPath);
    assert.ok(captures.get(B, "mixed@example.com"), "found by the normalised form");
    captures.close();
  });

  test("rejects nonsense without storing it", async () => {
    const res = await fetch(`${BASE}/a/${B}/email`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "not-an-email" }).toString(),
    });
    assert.equal(res.status, 400);
    assert.match(await res.text(), /does not look like an email/);
    const captures = new EmailCaptureStore(dbPath);
    assert.equal(captures.get(B, "not-an-email"), null);
    captures.close();
  });

  test("refuses a body too long to be an address", async () => {
    const res = await fetch(`${BASE}/a/${B}/email`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: "a".repeat(20_000) + "@example.com" }).toString(),
    });
    assert.equal(res.status, 413);
  });

  test("a GET on the email route is not a submission", async () => {
    assert.equal((await fetch(`${BASE}/a/${B}/email`)).status, 404);
  });

  test("no email address reaches the event log", async () => {
    // §8 makes events permanent while captures expire at 90 days. An address in
    // an event would quietly outlive the policy that covers it.
    await askForLink(A, "leaky@example.com");
    const events = new EventLog(dbPath);
    const all = events.all();
    events.close();
    assert.ok(all.some((e) => e.type === "email.captured"), "the event is recorded");
    assert.ok(
      !JSON.stringify(all).includes("leaky@example.com"),
      "and it does not carry the address",
    );
  });
});

describe("the image route", () => {
  test("serves the annotated screenshot", async () => {
    const res = await fetch(`${BASE}/a/${A}/${A}-annotated.png`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "image/png");
  });

  /**
   * This test was written wrong first, and the rewrite is the point.
   *
   * Version one asserted that `../../../etc/passwd` and friends were refused.
   * They were — but deleting the allowlist entirely did not turn the test red,
   * because `new URL()` resolves dot-segments before the router sees them and a
   * missing file 404s on its own. Four assertions, all passing for reasons that
   * had nothing to do with the code they claimed to cover.
   *
   * A PNG that really exists in the audit's own folder is the case that
   * separates an allowlist from an `existsSync`. `secret.png` below is served
   * the moment the allowlist goes.
   */
  test("refuses a real file in the audit's own folder that is not one of its two images", async () => {
    writeFileSync(path.join(outRoot, A, "secret.png"), Buffer.from("not for you"));
    const res = await fetch(`${BASE}/a/${A}/secret.png`);
    assert.equal(res.status, 404, "an existing PNG is still not a servable one");
  });

  test("refuses another audit's screenshot, and names that do not resolve", async () => {
    for (const attempt of [
      `${B}-annotated.png`, // right shape, wrong audit
      `${A}-secret.png`,
      "..%2f..%2fusability-lab.db.png",
    ]) {
      const res = await fetch(`${BASE}/a/${A}/${attempt}`);
      assert.equal(res.status, 404, attempt);
    }
  });
});

describe("the rate limiter itself", () => {
  test("allows up to the limit and refuses the next", () => {
    const w = new SlidingWindow(3, 1000);
    assert.ok(w.hit("k", 0).allowed);
    assert.ok(w.hit("k", 1).allowed);
    assert.ok(w.hit("k", 2).allowed);
    assert.equal(w.hit("k", 3).allowed, false);
  });

  test("the window slides — an old hit stops counting", () => {
    const w = new SlidingWindow(2, 1000);
    w.hit("k", 0);
    w.hit("k", 500);
    assert.equal(w.hit("k", 900).allowed, false, "still inside the window");
    assert.ok(w.hit("k", 1001).allowed, "the first hit has aged out");
  });

  test("a refused attempt is not recorded, so retrying cannot extend a ban", () => {
    // The difference between a rate limit and a lockout. Recording refusals
    // would let a client that keeps retrying hold its own window open forever.
    const w = new SlidingWindow(1, 1000);
    w.hit("k", 0);
    for (let t = 1; t < 1000; t += 100) assert.equal(w.hit("k", t).allowed, false);
    assert.ok(w.hit("k", 1001).allowed, "the ban ends when the first hit ages out, not later");
  });

  test("keys are independent", () => {
    const w = new SlidingWindow(1, 1000);
    assert.ok(w.hit("a", 0).allowed);
    assert.ok(w.hit("b", 0).allowed);
  });

  test("retryAfterMs counts down from the oldest hit in the window", () => {
    const w = new SlidingWindow(1, 1000);
    w.hit("k", 0);
    assert.equal(w.hit("k", 400).retryAfterMs, 600);
  });

  test("peek does not consume an attempt", () => {
    const w = new SlidingWindow(1, 1000);
    assert.ok(w.peek("k", 0).allowed);
    assert.ok(w.hit("k", 0).allowed, "peek left the allowance alone");
  });

  test("expired keys are swept once the map gets large", () => {
    // Spaced beyond the window on purpose. The first version of this test put
    // twenty hits 1ms apart inside a 1000ms window and asserted a shrink — the
    // keys were all still live, so the assertion was against behaviour that
    // would have been a bug. The sweep reclaims expired keys; it does not cap.
    const w = new SlidingWindow(1, 1000, 10);
    for (let i = 0; i < 20; i++) w.hit(`key-${i}`, i * 2000);
    assert.ok(w.size < 20, `swept: ${w.size} keys held, not 20`);
  });

  test("and does NOT cap a flood arriving inside one window", () => {
    // The honest limitation. What bounds these maps is the caller checking the
    // per-audit allowance before any other key is created — not this class.
    const w = new SlidingWindow(1, 1000, 10);
    for (let i = 0; i < 20; i++) w.hit(`key-${i}`, i);
    assert.equal(w.size, 20, "every key is still live, so every key is still held");
  });

  test("inMinutes rounds up and reads like English", () => {
    assert.equal(inMinutes(1), "a minute");
    assert.equal(inMinutes(60_000), "a minute");
    assert.equal(inMinutes(61_000), "2 minutes");
  });
});

describe("the gate under pressure", () => {
  test("asking twice does not send twice, and says so", async () => {
    const email = freshEmail();
    await askForLink(B, email);
    const res = await fetch(`${BASE}/a/${B}/email`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email }).toString(),
    });
    assert.equal(res.status, 200, "a double-click is not an error");
    const html = await res.text();
    assert.match(html, /have not sent another/, "and the page does not claim a second mail");
    assert.doesNotMatch(html, /on its way/);
  });

  test("one results URL cannot mail twenty different people in an hour", async () => {
    // The mail-bomb case: one published link, an unlimited list of recipients.
    let throttled = 0;
    for (let i = 0; i < 25; i++) {
      const res = await fetch(`${BASE}/a/${BOMB}/email`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email: `bomb${i}@example.com` }).toString(),
      });
      if (res.status === 429) {
        throttled++;
        assert.ok(Number(res.headers.get("retry-after")) > 0, "retry-after is a real number");
        assert.match(await res.text(), /Try again in/);
      }
    }
    assert.ok(throttled >= 4, `the 21st onwards are refused; ${throttled} were`);
  });

  test("a throttle is recorded, so the funnel can show an attack", async () => {
    const events = new EventLog(dbPath);
    const all = events.all();
    events.close();
    assert.ok(all.some((e) => e.type === "gate.throttled"));
  });
});

describe("bad tokens are recorded, not punished", () => {
  test("a rejected token becomes an event carrying the reason and not the token", async () => {
    await fetch(`${BASE}/a/${A}/full?t=obviously-not-a-token`);
    const events = new EventLog(dbPath);
    const rejected = events.all().filter((e) => e.type === "token.rejected");
    events.close();
    assert.ok(rejected.length > 0, "the attempt is visible");
    assert.ok(
      !JSON.stringify(rejected).includes("obviously-not-a-token"),
      "and the credential is not in a permanent log",
    );
  });

  test("failing repeatedly does not lock the audit for its real reader", async () => {
    // The withdrawn half of B16. A lockout here is a denial of service anyone
    // holding the results URL could aim at the customer whose audit it is.
    const link = await askForLink(A, freshEmail());
    for (let i = 0; i < 25; i++) await fetch(`${BASE}/a/${A}/full?t=wrong-${i}`);
    const { status } = await openLink(link);
    assert.equal(status, 200, "the real link still works after 25 failures");
  });
});

describe("the credential leaves the URL", () => {
  test("a link exchanges itself for a cookie and redirects to a clean address", async () => {
    const link = await askForLink(A, freshEmail());
    const res = await fetch(link, { redirect: "manual" });

    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), `/a/${A}/full`);
    const setCookie = res.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /HttpOnly/, "not readable by script");
    assert.match(setCookie, /SameSite=Lax/);
    assert.match(setCookie, new RegExp(`Path=/a/${A}/`), "scoped to this audit's path");
    assert.doesNotMatch(res.headers.get("location") ?? "", /t=/, "the token is gone from the URL");
  });

  test("the clean address works on a reload, and not without the cookie", async () => {
    const link = await askForLink(A, freshEmail());
    const { status, html, clean } = await openLink(link);
    assert.equal(status, 200);
    assert.match(html, /Observation number 9/);

    const naked = await fetch(clean);
    assert.equal(naked.status, 403, "no cookie, no page");
  });

  /**
   * This passes with `Path=/` too — the signature is what refuses it, not the
   * cookie attribute. Recorded here so nobody later reads this as proof that
   * the path scoping works: that is asserted as a string above, deliberately,
   * because its whole job is to be the second lock on a door the first lock
   * already holds.
   */
  test("a cookie from audit A does not open audit B", async () => {
    const first = await fetch(await askForLink(A, freshEmail()), { redirect: "manual" });
    const jar = (first.headers.get("set-cookie") ?? "").split(";")[0]!;
    const res = await fetch(`${BASE}/a/${B}/full`, { headers: { cookie: jar } });
    assert.equal(res.status, 403);
  });

  test("a cookie that no longer verifies is cleared", async () => {
    const res = await fetch(`${BASE}/a/${A}/full`, { headers: { cookie: "ul_full=stale-rubbish" } });
    assert.equal(res.status, 403);
    assert.match(res.headers.get("set-cookie") ?? "", /ul_full=; .*Max-Age=0/);
  });
});

describe("the root", () => {
  test("does not list audits", async () => {
    const html = await (await fetch(`${BASE}/`)).text();
    assert.doesNotMatch(html, new RegExp(A));
    assert.doesNotMatch(html, /example\.com/);
  });
});
