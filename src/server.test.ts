import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import http from "node:http";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  AuditStore,
  EmailCaptureStore,
  EventLog,
  SubscriptionStore,
  ReauditRequestStore,
  AuditRequestStore,
  type AuditStatus,
} from "./db.js";
import { QUESTIONS } from "./profile.js";
import { sign, verify, looksLikeEmail, csrfFor, csrfMatches, TOKEN_TTL_MS } from "./tokens.js";
import { signWebhook, STRIPE_API_VERSION } from "./stripe.js";
import { signAccount } from "./tokens.js";
import { SlidingWindow, inMinutes } from "./ratelimit.js";
import { AUDITS_PER_MONTH } from "./fairuse.js";

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
/**
 * Its own audit again, for the re-audit button. Same reason as BOMB: these
 * tests each open a session, and twenty sessions an hour is the per-audit
 * allowance every other test on this page is also spending.
 */
const SUB = "ffffffff-6666-4666-8666-ffffffffffff";
/**
 * Not a fixture. `dddddddd-…` is hardcoded below as the made-up id that must
 * 404, so seeding an audit at it turns that test green for the wrong reason —
 * which is exactly what happened when this constant was first written.
 */
const NEVER_SEEDED = "dddddddd-4444-4444-8444-dddddddddddd";
const PORT = 4137;
const BASE = `http://127.0.0.1:${PORT}`;

/**
 * One key, shared with the subprocess — and set here, before anything imports
 * its way into `tokens.ts`.
 *
 * Until the re-audit button, no test needed the parent and the server to agree
 * about signing: tokens were either made and checked in-process, or made by the
 * child and only ever handed back to it. So the parent had quietly been reading
 * the repo's real `out/.secret` this whole time, and nothing failed. The first
 * test to compute a CSRF token for a session the *child* issued is the first
 * one that could notice, and it did.
 */
const SECRET = "test-secret-not-a-real-one";
process.env.USABILITY_LAB_SECRET = SECRET;

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
  seed(SUB, 7, true);

  child = spawn(process.execPath, ["--import", "tsx", path.resolve("src/server.ts")], {
    env: {
      ...process.env,
      PORT: String(PORT),
      USABILITY_LAB_DB: dbPath,
      USABILITY_LAB_OUT: outRoot,
      USABILITY_LAB_SECRET: SECRET,
      /**
       * So a test can have its own rate-limit bucket by sending this header.
       *
       * `asksByClient` allows five audit requests an hour per client and every
       * test here arrives from the same socket, so a handful of submissions in
       * one file exhausts it for the rest. Naming a header lets a test opt into
       * its own bucket; a test that sends nothing falls back to the socket and
       * behaves exactly as before — which is what the rate-limit tests rely on.
       */
      USABILITY_LAB_CLIENT_IP_HEADER: "x-test-client",
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

/**
 * A reader who has been through the whole gate and is holding a live cookie.
 *
 * Returns the jar as well as the page, because the re-audit button POSTs and
 * `fetch` will not carry a cookie for us. The CSRF token is read out of the
 * rendered HTML rather than computed, so these tests exercise the value the
 * server actually put on the page — computing it here would test my arithmetic
 * against itself.
 */
async function session(
  auditId: string,
  email = freshEmail(),
): Promise<{ email: string; jar: string; html: string }> {
  const link = await askForLink(auditId, email);
  const first = await fetch(link, { redirect: "manual" });
  assert.equal(first.status, 303);
  const jar = (first.headers.get("set-cookie") ?? "").split(";")[0]!;
  const clean = new URL(first.headers.get("location")!, BASE).toString();
  const page = await fetch(clean, { headers: { cookie: jar } });
  return { email, jar, html: await page.text() };
}

const csrfIn = (html: string) => html.match(/name="csrf" value="([^"]+)"/)?.[1] ?? "";

/**
 * The CSRF token a session is entitled to, computed rather than read off a page.
 *
 * Needed whenever the page under test deliberately renders no button — a reader
 * who is not subscribed, or one who has hit the cap. Posting junk in those cases
 * is refused by the CSRF check whether or not the check under test exists, and
 * three tests here were written that way before a revert pass caught them. This
 * is also the realistic attacker: someone holding a valid session who builds the
 * form themselves.
 */
const liveCsrf = (jar: string) => csrfFor(jar.slice(jar.indexOf("=") + 1));

function subscribe(email: string, days = 30): void {
  const subs = new SubscriptionStore(dbPath);
  subs.upsert(email, {
    status: "active",
    currentPeriodEnd: new Date(Date.now() + days * 86_400_000).toISOString(),
  });
  subs.close();
}

async function askForReaudit(
  auditId: string,
  jar: string,
  csrf: string,
): Promise<{ status: number; html: string }> {
  const res = await fetch(`${BASE}/a/${auditId}/reaudit`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar },
    body: new URLSearchParams({ csrf }).toString(),
    redirect: "manual",
  });
  return { status: res.status, html: await res.text() };
}

function queuedFor(email: string): number {
  const requests = new ReauditRequestStore(dbPath);
  const n = requests.forEmail(email).length;
  requests.close();
  return n;
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

  test("a CSRF token belongs to one session and no other", () => {
    const mine = sign(A, "kelly@example.com");
    const theirs = sign(A, "someone@example.com");
    assert.ok(csrfMatches(mine, csrfFor(mine)));
    assert.ok(!csrfMatches(mine, csrfFor(theirs)));
  });

  test("no session means no CSRF token can be valid", () => {
    // The empty-string case, spelled out. `HMAC(secret, "csrf:")` is a real,
    // computable value, and a check that only compared strings would accept it
    // from a caller holding no cookie at all.
    assert.ok(!csrfMatches("", csrfFor("")));
    assert.ok(!csrfMatches(sign(A, "kelly@example.com"), ""));
  });

  test("a CSRF token is not a session token, and cannot be swapped for one", () => {
    const token = sign(A, "kelly@example.com");
    assert.notEqual(csrfFor(token), token.split(".")[1]);
    assert.equal(verify(csrfFor(token), A).ok, false);
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
    const fake = await fetch(`${BASE}/a/${NEVER_SEEDED}/`);
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

/**
 * The second allowlisted file route, over HTTP.
 *
 * `assets.test.ts` covers the lookup itself and watched three of its five tests
 * fail against a path-joining implementation — one of which read the repo's
 * `.env`. This is the thin layer above that: the right headers, and a 404 that
 * goes through the same `notFound` as everything else.
 */
describe("static assets", () => {
  test("the font is served, typed correctly, and cached hard", async () => {
    const res = await fetch(`${BASE}/s/inter.woff2`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "font/woff2");
    assert.match(res.headers.get("cache-control")!, /immutable/);
    const body = Buffer.from(await res.arrayBuffer());
    assert.equal(body.subarray(0, 4).toString("latin1"), "wOF2", "bytes arrived intact");
  });

  test("anything not on the list is a 404, traversal included", async () => {
    for (const p of [
      "/s/.env",
      "/s/..%2f.env",
      "/s/inter-LICENSE.txt", // ships beside the font, is not servable
      "/s/nope.woff2",
      "/s/",
      "/s/a/b",
    ]) {
      assert.equal((await fetch(`${BASE}${p}`)).status, 404, p);
    }
  });
});

/**
 * The header that had never been asserted.
 *
 * `send` has put `default-src 'none'; img-src 'self'; style-src 'unsafe-inline'`
 * on every response since the server shipped, and until now `grep` found exactly
 * one occurrence of it in the repo: the line that set it. Nothing would have
 * noticed it being weakened.
 *
 * It is about to become configurable, because the marketing pages need a font
 * and the question flow needs one script. That is the moment to pin down what
 * must never move: **an audit page quotes text captured from a stranger's site**,
 * so a `<script>` smuggled through a finding has to have nowhere to run. The
 * quotation lesson applies here too — the danger is not that we render markup,
 * it is that we render somebody else's.
 */
describe("content-security-policy", () => {
  test("an audit page denies scripts and fonts, because it quotes captured pages", async () => {
    const res = await fetch(`${BASE}/a/${A}/`);
    const csp = res.headers.get("content-security-policy")!;
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /script-src/, "an audit page must never authorise a script");
    assert.doesNotMatch(csp, /font-src/, "an audit page has no font to fetch");
    assert.doesNotMatch(csp, /unsafe-eval/);
  });

  /**
   * The default has to be the safe one. A route added later by someone not
   * thinking about headers should come out locked down, not accidentally open —
   * so the policy is asserted somewhere nobody would think to configure it.
   */
  test("a 404 is strict too", async () => {
    const res = await fetch(`${BASE}/a/${NEVER_SEEDED}/`);
    assert.equal(res.status, 404);
    const csp = res.headers.get("content-security-policy")!;
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /script-src/);
  });

  /**
   * `frame-ancestors` gets its own test because it is the directive that looks
   * redundant next to `default-src 'none'` and is not: it has no fallback to
   * `default-src`, so a reviewer tidying the policy could delete it, see every
   * other assertion here stay green, and leave every page frameable.
   *
   * The pages named below are the ones where it earns its keep — an audit page
   * carries the subscribe button, and the homepage and question flow are what a
   * stranger would be lured into framing.
   */
  test("nothing here may be framed, on any surface", async () => {
    for (const path of ["/", "/start", `/a/${A}/`, `/a/${NEVER_SEEDED}/`]) {
      const csp = (await fetch(`${BASE}${path}`)).headers.get("content-security-policy") ?? "";
      assert.match(csp, /frame-ancestors 'none'/, `${path} can be framed`);
    }
  });

  /**
   * HSTS is a promise about a hostname, so it is sent only where a hostname has
   * been claimed. Sending it from a local run would be writing something into a
   * response that is not true of the address serving it — browsers ignore the
   * header over plain http, so this is about honesty rather than safety.
   *
   * The public half is asserted in "one host, one site", which is the suite that
   * has a server with a public base URL.
   */
  test("a local run makes no HSTS promise", async () => {
    const res = await fetch(`${BASE}/`);
    assert.equal(res.headers.get("strict-transport-security"), null);
  });
});

/**
 * The shell every non-audit surface renders through.
 *
 * `/r/<made-up-uuid>` 404s, and that 404 goes through `notFound` -> `page()`.
 * The route is not what is under test — the frame is. Asserting it here rather
 * than on the homepage means it keeps being asserted after the homepage is
 * rewritten.
 *
 * This is also the first caller to pass a non-default policy, so `font-src`
 * arriving in the response header is what proves the seam added to `send()`
 * actually works. Until now nothing exercised it.
 */
describe("the shell", () => {
  test("carries the new tokens and points at the self-hosted font", async () => {
    const html = await (await fetch(`${BASE}/r/${randomUUID()}`)).text();
    assert.match(html, /--paper:\s*#FBFAF8/);
    assert.match(html, /--ink:\s*#26221E/);
    assert.match(html, /\/s\/inter\.woff2/);
    assert.doesNotMatch(
      html,
      /#E4572E/i,
      "the accent belongs to render.ts, where the severity pins need it",
    );
  });

  test("asks for a font and still refuses scripts", async () => {
    const csp = (await fetch(`${BASE}/r/${randomUUID()}`)).headers.get("content-security-policy")!;
    assert.match(csp, /font-src 'self'/, "the seam in send() reaches the wire");
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /script-src/, "the shell runs nothing; only /start will");
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

/**
 * The re-audit button, which is the only thing on this server that can cause
 * money to be spent later.
 *
 * The property under test is not "the button works". It is that **nothing
 * queues work except a subscriber, holding a live session, posting a form we
 * rendered** — and that a subscriber cannot queue more than the plan covers.
 * Every test below is one of the ways past that, tried.
 */
describe("asking for a re-audit", () => {
  test("the offer is only on the full page, never the preview", async () => {
    const preview = await (await fetch(`${BASE}/a/${SUB}/`)).text();
    assert.doesNotMatch(preview, /Keep watching this page/);
    assert.doesNotMatch(preview, /class="offer"/);

    const { html } = await session(SUB);
    assert.match(html, /Keep watching this page/);
  });

  test("a reader who is not subscribed is told checkout is missing, not shown a button", async () => {
    const { email, jar, html } = await session(SUB);
    assert.doesNotMatch(html, /name="csrf"/);
    assert.match(html, /Checkout is not connected yet/);

    // And posting anyway changes nothing — with a CSRF token this session is
    // genuinely entitled to, so the subscription check is what has to refuse.
    const res = await askForReaudit(SUB, jar, liveCsrf(jar));
    assert.equal(res.status, 403);
    assert.equal(queuedFor(email), 0);
  });

  test("a subscriber gets the button, and one press records one request", async () => {
    const email = freshEmail();
    subscribe(email);
    const { jar, html } = await session(SUB, email);
    const csrf = csrfIn(html);
    assert.ok(csrf, "a subscriber's page carries a CSRF token");

    const res = await askForReaudit(SUB, jar, csrf);
    assert.equal(res.status, 200);
    assert.match(res.html, /Queued/);
    assert.equal(queuedFor(email), 1);

    const events = new EventLog(dbPath);
    const requested = events.all(SUB).filter((e) => e.type === "reaudit.requested");
    events.close();
    assert.equal(requested.length, 1);
    // The address is in the request row, not in the permanent event log — §8.
    assert.deepEqual(requested[0]!.data, {});
  });

  test("pressing it again queues nothing, and says so", async () => {
    const email = freshEmail();
    subscribe(email);
    const { jar, html } = await session(SUB, email);
    const csrf = csrfIn(html);

    await askForReaudit(SUB, jar, csrf);
    const second = await askForReaudit(SUB, jar, csrf);
    assert.equal(second.status, 200);
    assert.match(second.html, /already have a re-audit queued/);
    assert.equal(queuedFor(email), 1, "one decision, one capture");
  });

  test("a valid session with the wrong CSRF token queues nothing", async () => {
    const email = freshEmail();
    subscribe(email);
    const { jar } = await session(SUB, email);

    const res = await askForReaudit(SUB, jar, "not-the-token");
    assert.equal(res.status, 403);
    assert.match(res.html, /did not come from this page/);
    assert.equal(queuedFor(email), 0);
  });

  test("one subscriber's CSRF token does not work in another's session", async () => {
    const mine = freshEmail();
    const theirs = freshEmail();
    subscribe(mine);
    subscribe(theirs);
    const a = await session(SUB, mine);
    const b = await session(SUB, theirs);

    const res = await askForReaudit(SUB, a.jar, csrfIn(b.html));
    assert.equal(res.status, 403);
    assert.equal(queuedFor(mine), 0);
  });

  test("no cookie, no request — and the rejection is recorded", async () => {
    const before = new EventLog(dbPath).all(SUB).filter((e) => e.type === "token.rejected").length;
    const res = await fetch(`${BASE}/a/${SUB}/reaudit`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "csrf=x",
    });
    assert.equal(res.status, 403);

    const events = new EventLog(dbPath);
    const after = events.all(SUB).filter((e) => e.type === "token.rejected");
    events.close();
    assert.equal(after.length, before + 1);
    assert.equal(after[after.length - 1]!.data.route, "reaudit");
  });

  /**
   * A GET here would be a link, and a link is something Slack, iMessage and
   * every mail client fetch on the reader's behalf. A prefetch must not be able
   * to spend $0.65.
   */
  test("a re-audit cannot be started by following a link", async () => {
    const email = freshEmail();
    subscribe(email);
    const { jar } = await session(SUB, email);
    const res = await fetch(`${BASE}/a/${SUB}/reaudit`, { headers: { cookie: jar } });
    assert.equal(res.status, 404);
    assert.equal(queuedFor(email), 0);
  });

  test(`the ${AUDITS_PER_MONTH + 1}th ask this month is refused, and nothing is queued`, async () => {
    const email = freshEmail();
    subscribe(email);

    // Ten already spent this month, all completed, all for this same site — so
    // the site limit cannot be what refuses.
    const requests = new ReauditRequestStore(dbPath);
    for (let i = 0; i < AUDITS_PER_MONTH; i++) {
      requests.request(SUB, email, "https://example.com/");
    }
    for (const r of requests.forEmail(email)) requests.complete(r.id);
    requests.close();

    const { jar, html } = await session(SUB, email);
    // The page refuses before the button is even drawn.
    assert.doesNotMatch(html, /name="csrf"/);
    assert.match(html, new RegExp(`${AUDITS_PER_MONTH} re-audits this month`));

    /**
     * And so does the route, which is the one that matters.
     *
     * The CSRF token is computed from the session here rather than read out of
     * the HTML, because the page above deliberately carries none — and a post
     * with a *bogus* token would be refused by the CSRF check whether or not
     * the cap exists, which is a test that passes for the wrong reason. This is
     * also a real customer: one who loaded the page while they still had asks
     * left, and spent the last one in another tab before pressing.
     */
    const res = await askForReaudit(SUB, jar, liveCsrf(jar));
    assert.equal(res.status, 429);
    assert.equal(queuedFor(email), AUDITS_PER_MONTH, "the eleventh was not recorded");
  });

  test("an expired subscription buys nothing", async () => {
    const email = freshEmail();
    const subs = new SubscriptionStore(dbPath);
    // Paid, and the period has run out. `isActive` hangs on the date, not the
    // word — see db.ts on why access expires rather than persists.
    subs.upsert(email, { status: "active", currentPeriodEnd: "2020-01-01T00:00:00.000Z" });
    subs.close();

    const { jar, html } = await session(SUB, email);
    assert.match(html, /Checkout is not connected yet/);
    assert.equal((await askForReaudit(SUB, jar, liveCsrf(jar))).status, 403);
    assert.equal(queuedFor(email), 0);
  });
});

/**
 * The question flow — the first route here a stranger can use to make us *do*
 * something rather than read something.
 *
 * Two properties carry this suite. **A submitted URL never reaches a browser
 * without passing `checkUrl`**, because the alternative is our own network. And
 * **submitting spends nothing** — the row is a request, and a person runs the
 * queue.
 */
describe("the question flow", () => {
  /**
   * A public literal, so `checkUrl` short-circuits before DNS.
   *
   * A hostname here would put a real resolver in the middle of a unit test:
   * slow when it works, red when the network is down, and green for the wrong
   * reason if something ever resolves it locally.
   */
  const OK_URL = "http://93.184.216.34/pricing";

  const submit = (fields: Record<string, string>, base = BASE) =>
    fetch(`${base}/request`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(fields).toString(),
      redirect: "manual",
    });

  function queued(): number {
    const asks = new AuditRequestStore(dbPath);
    const n = asks.queue().length;
    asks.close();
    return n;
  }

  test("the question flow asks the same five questions the CLI does", async () => {
    const html = await (await fetch(`${BASE}/start`)).text();
    for (const q of QUESTIONS) {
      assert.match(html, new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "&#39;")), q);
    }
    assert.match(html, /name="url"/);
  });

  test("and still lists no audits", async () => {
    for (const path of ["/", "/start"]) {
      const html = await (await fetch(`${BASE}${path}`)).text();
      assert.doesNotMatch(html, new RegExp(A), path);
      assert.doesNotMatch(html, /example\.com/, path);
    }
  });

  test("the homepage has no form on it — the questions moved", async () => {
    const html = await (await fetch(`${BASE}/`)).text();
    assert.doesNotMatch(html, /<form/i);
    assert.match(html, /href="\/start"/, "and it points at where they went");
  });

  /**
   * §7 of the spec, over HTTP.
   *
   * `funnel.ts` prints `question.started` as "form opened". That was true while
   * `/` was the form. If this route had kept the name, the dashboard would have
   * counted homepage views under a label that says otherwise, and gone on
   * printing a completion rate to the same precision as before — the same shape
   * as the 85%-uncited figure, which was an honest-looking number over a
   * changed population.
   */
  test("a homepage view and a form open are different events", async () => {
    const count = (type: string) => {
      const e = new EventLog(dbPath);
      const n = e.all().filter((x) => x.type === type).length;
      e.close();
      return n;
    };
    const startedBefore = count("question.started");
    const homeBefore = count("home.viewed");

    await fetch(`${BASE}/`);
    assert.equal(count("question.started"), startedBefore, "a homepage view is not a form open");
    assert.equal(count("home.viewed"), homeBefore + 1);

    await fetch(`${BASE}/start`);
    assert.equal(count("question.started"), startedBefore + 1, "opening the flow still records it");
    assert.equal(count("home.viewed"), homeBefore + 1, "and does not double as a homepage view");
  });

  test("the flow authorises its script by hash and nothing else", async () => {
    const csp = (await fetch(`${BASE}/start`)).headers.get("content-security-policy")!;
    assert.match(csp, /script-src 'sha256-/);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe-inline/);
    assert.match(csp, /font-src 'self'/);
  });

  test("each page authorises only its own script, never the other's", async () => {
    /**
     * Both pages run a script now — the homepage got cursor parallax on
     * 2026-08-20 — and each names its own by hash. The failure this guards
     * against is the tempting one: widening MARKETING_CSP to cover both so
     * there is one policy to think about. That would authorise the stepper on
     * the homepage and the parallax on the flow, and neither page would notice,
     * because a CSP is only ever felt when it refuses something.
     */
    const home = (await fetch(`${BASE}/`)).headers.get("content-security-policy")!;
    const start = (await fetch(`${BASE}/start`)).headers.get("content-security-policy")!;

    const hashOf = (csp: string) => csp.match(/'sha256-([A-Za-z0-9+/=]+)'/)?.[1];
    assert.ok(hashOf(home), "the homepage names a script");
    assert.ok(hashOf(start), "the flow names a script");
    assert.notEqual(hashOf(home), hashOf(start), "two scripts, two hashes");

    assert.equal(home.match(/sha256-/g)?.length, 1, "the homepage authorises exactly one");
    assert.equal(start.match(/sha256-/g)?.length, 1, "so does the flow");

    // And the untouched surfaces still authorise nothing.
    const shell = (await fetch(`${BASE}/r/${randomUUID()}`)).headers.get("content-security-policy")!;
    assert.doesNotMatch(shell, /script-src/, "a page with no script must not name one");
  });

  test("neither view writes anything into the permanent log", async () => {
    // §8 makes events permanent. These two carry a type and a timestamp and
    // nothing else — no URL, no referrer, nothing about who arrived.
    await fetch(`${BASE}/`);
    const events = new EventLog(dbPath);
    const home = events.all().filter((e) => e.type === "home.viewed");
    events.close();
    assert.deepEqual(Object.keys(home[home.length - 1]!.data), []);
  });

  test("a URL pointing at our own network is refused, and queues nothing", async () => {
    const before = queued();
    for (const url of ["http://127.0.0.1:4137/", "http://169.254.169.254/", "file:///etc/passwd"]) {
      const res = await submit({ url });
      assert.equal(res.status, 400, url);
      const html = await res.text();
      // The reason is generic. What the visitor typed comes back in the form
      // field — escaped, so they need not retype it — but never inside the
      // sentence explaining the refusal. `urlcheck.test.ts` holds that one.
      assert.match(html, /private network|http or https/);
    }
    assert.equal(queued(), before, "nothing reached the queue");
  });

  test("a refusal records the reason and never the URL", async () => {
    await submit({ url: "javascript:alert(1)" });
    const events = new EventLog(dbPath);
    const rejected = events.all().filter((e) => e.type === "request.rejected");
    events.close();
    assert.ok(rejected.length > 0);
    const last = rejected[rejected.length - 1]!;
    assert.equal(last.data.reason, "scheme");
    assert.deepEqual(Object.keys(last.data), ["reason"], "the URL must not be in a permanent log");
  });

  test("a good submission queues a request and hands back a private address", async () => {
    const before = queued();
    const res = await submit({ url: OK_URL, q0: "A shop", q1: "People bounce" });
    assert.equal(res.status, 303);
    const location = res.headers.get("location")!;
    assert.match(location, /^\/r\/[0-9a-f-]{36}$/);
    assert.equal(queued(), before + 1);

    const asks = new AuditRequestStore(dbPath);
    const row = asks.get(location.slice(3))!;
    asks.close();
    assert.equal(row.url, "http://93.184.216.34/pricing");
    assert.equal(row.audit_id, null, "queued, not started — an HTTP request spends nothing");
    const answers = JSON.parse(row.answers) as Record<string, string>;
    assert.equal(answers[QUESTIONS[0]], "A shop");
    assert.equal(answers[QUESTIONS[1]], "People bounce");
  });

  test("the answers are not written to the permanent event log", async () => {
    await submit({ url: OK_URL, q0: "we sell artisanal widgets to dentists" });
    const events = new EventLog(dbPath);
    const completed = events.all().filter((e) => e.type === "question.completed");
    events.close();
    const last = completed[completed.length - 1]!;
    assert.deepEqual(Object.keys(last.data), ["answered"]);
    assert.equal(JSON.stringify(last.data).includes("dentists"), false);
  });

  /**
   * Deliberately the home for the re-render assertions too.
   *
   * The over-long check runs *before* the rate limiter, so this test costs
   * nothing from the five-an-hour per-client allowance — and that allowance is
   * real: adding one more `submit()` to this describe block turned the next
   * test 429 and made it look like the router had broken.
   */
  test("an over-long answer is refused, and the whole flow comes back filled in", async () => {
    const before = queued();
    const res = await submit({ url: OK_URL, q0: "x".repeat(1001), q1: "keep this" });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /longer than 1000 characters/);
    assert.match(html, /keep this/, "the other answers survive the mistake");
    assert.match(html, /name="q4"/, "every step returns, not just the one at fault");
    assert.match(html, /name="url"/);
    // q0 was the long one, and step 0 is the URL — so the flow reopens on step 1.
    // Sending them to step 0 would show the URL field under an error about an
    // answer, which is worse than not helping.
    assert.match(html, /data-error-step="1"/, "it reopens on the answer that was refused");
    assert.equal(queued(), before);
  });

  test("what a visitor types is escaped before it is shown back to them", async () => {
    const res = await submit({ url: "not a url", q0: `<script>alert(1)</script>` });
    const html = await res.text();
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
  });

  test("the form is POST only", async () => {
    assert.equal((await fetch(`${BASE}/request`)).status, 404);
  });
});

describe("where is my audit", () => {
  /** A request row, made directly — the status page is what is under test. */
  function ask(url = "https://example.com/"): string {
    const asks = new AuditRequestStore(dbPath);
    const id = randomUUID();
    asks.create(id, url, { [QUESTIONS[0]]: "A shop" });
    asks.close();
    return id;
  }

  test("a queued request says so, and says nothing about an audit", async () => {
    const html = await (await fetch(`${BASE}/r/${ask()}`)).text();
    assert.match(html, /In the queue/);
  });

  test("a made-up request id is a 404", async () => {
    assert.equal((await fetch(`${BASE}/r/${randomUUID()}`)).status, 404);
  });

  test("a prefix of a real request id is not a real request id", async () => {
    const id = ask();
    assert.equal((await fetch(`${BASE}/r/${id.slice(0, 8)}`)).status, 404);
  });

  test("the page follows the audit, and says the honest thing at each step", async () => {
    const requestId = ask();
    const auditId = randomUUID();
    const asks = new AuditRequestStore(dbPath);
    assert.equal(asks.start(requestId, auditId), true);
    assert.equal(asks.start(requestId, randomUUID()), false, "a claimed request cannot be claimed twice");
    asks.close();

    const at = async () => (await fetch(`${BASE}/r/${requestId}`)).text();

    // Claimed, but the audit row does not exist for the moment between the
    // stamp and the subprocess starting.
    assert.match(await at(), /Starting now/);

    const store = new AuditStore(dbPath);
    store.create(auditId, "https://example.com/");
    store.transition(auditId, "CAPTURING");
    // Was "Your team is assembling. Reviewers are on the page now." — which was
    // said during capture, before any reviewer existed. No step has finished
    // here, so the true sentence is the browser one.
    assert.match(await at(), /Opening your page in a real browser/);

    store.transition(auditId, "AUDITING");
    store.transition(auditId, "ASSEMBLING");
    store.transition(auditId, "REVIEW_PENDING");
    assert.match(await at(), /a person is reading it/);

    store.transition(auditId, "PUBLISHED");
    const done = await at();
    assert.match(done, new RegExp(`href="/a/${auditId}/"`));
    store.close();
  });

  /**
   * DECLINED fell through to `default:`, which tells a waiting visitor their
   * audit is still running and refreshes forever. It will never publish.
   *
   * A declined audit is a judgment we made, not a fault of the page, and the
   * page saying so is the difference between a decision and a hang.
   */
  test("an audit we declined stops, and does not pretend to still be working", async () => {
    const requestId = ask();
    const auditId = randomUUID();
    const asks = new AuditRequestStore(dbPath);
    asks.start(requestId, auditId);
    asks.close();

    const store = new AuditStore(dbPath);
    store.create(auditId, "https://example.com/");
    for (const s of ["CAPTURING", "AUDITING", "ASSEMBLING", "REVIEW_PENDING"] as const) {
      store.transition(auditId, s);
    }
    store.transition(auditId, "DECLINED");
    store.close();

    const html = await (await fetch(`${BASE}/r/${requestId}`)).text();
    assert.doesNotMatch(html, /It updates as we go/, "terminal: nothing more is coming");
    assert.doesNotMatch(html, /http-equiv="refresh"/i, "and it must not poll forever");
    assert.doesNotMatch(html, /a person is reading it/, "nobody is still reading it");
    assert.match(html, /not to publish/i, "it says what happened");
    assert.match(html, /nothing was charged/i);
  });

  test("a declined audit is not readable at its own address", async () => {
    // The serving check is an allowlist — PUBLISHED or AUTO_PUBLISHED — so this
    // should already hold. Asserted because "should already hold" is how a
    // cut finding reaches a stranger.
    const auditId = randomUUID();
    const store = new AuditStore(dbPath);
    store.create(auditId, "https://example.com/");
    for (const s of ["CAPTURING", "AUDITING", "ASSEMBLING", "REVIEW_PENDING"] as const) {
      store.transition(auditId, s);
    }
    store.transition(auditId, "DECLINED");
    store.close();

    assert.equal((await fetch(`${BASE}/a/${auditId}/`)).status, 404);
  });

  test("a capture that failed tells the visitor so — F1", async () => {
    const requestId = ask();
    const auditId = randomUUID();
    const asks = new AuditRequestStore(dbPath);
    asks.start(requestId, auditId);
    asks.close();

    const store = new AuditStore(dbPath);
    store.create(auditId, "https://example.com/");
    store.transition(auditId, "CAPTURING");
    store.transition(auditId, "CAPTURE_FAILED");
    store.close();

    const html = await (await fetch(`${BASE}/r/${requestId}`)).text();
    assert.match(html, /could not load that page/);
    assert.match(html, /Nothing was published/);
  });

  /**
   * Whether the page comes back on its own.
   *
   * A visitor watched this page say "In the queue" for fourteen minutes and
   * then submitted the same URL again, because nothing about it ever changed.
   * That is the failure being fixed: not an unfinished feeling, a duplicate
   * request and a second audit we would have paid for.
   */
  /**
   * How to reach each state from `REQUESTED`, walking only legal edges.
   *
   * Spelled out rather than jumped to, because `transition` enforces `LEGAL`
   * and a test that could not reach a state is a test asserting about a state
   * the pipeline cannot produce.
   */
  const PATH_TO = {
    CAPTURING: ["CAPTURING"],
    AUDITING: ["CAPTURING", "AUDITING"],
    REVIEW_PENDING: ["CAPTURING", "AUDITING", "ASSEMBLING", "REVIEW_PENDING"],
    PUBLISHED: ["CAPTURING", "AUDITING", "ASSEMBLING", "REVIEW_PENDING", "PUBLISHED"],
    CAPTURE_FAILED: ["CAPTURING", "CAPTURE_FAILED"],
    FAILED: ["CAPTURING", "FAILED"],
  } satisfies Record<string, AuditStatus[]>;

  type AuditAtRest = keyof typeof PATH_TO;

  /**
   * A request parked at `status`, and the status page it renders.
   *
   * `null` means never claimed — still in the queue, which is the state the
   * visitor above was looking at.
   */
  async function statusAt(status: AuditAtRest | null, done: string[] = []): Promise<Response> {
    const requestId = ask();
    const auditId = randomUUID();

    const asks = new AuditRequestStore(dbPath);
    if (status !== null) asks.start(requestId, auditId);
    asks.close();

    if (status !== null) {
      const store = new AuditStore(dbPath);
      store.create(auditId, "https://example.com/");
      // Walked through the transitions the pipeline actually makes, so this
      // can never assert about a status the store itself would refuse.
      for (const step of PATH_TO[status]) store.transition(auditId, step);
      store.close();
    }

    // `done` is the steps that have *finished* — `timed()` records after the
    // work, not before, which is the whole reason the page can name what is
    // running rather than what ran.
    if (done.length > 0) {
      const log = new EventLog(dbPath);
      for (const step of done) {
        log.record({ audit_id: auditId, type: `step.${step}`, data: { ms: 1, ok: true } });
      }
      log.close();
    }
    return fetch(`${BASE}/r/${requestId}`);
  }

  const LIVE = [null, "CAPTURING", "AUDITING", "REVIEW_PENDING"] as const;
  const DONE = ["PUBLISHED", "CAPTURE_FAILED", "FAILED"] as const;

  test("a page that is still moving comes back on its own; a finished one stops", async () => {
    for (const status of LIVE) {
      const refresh = (await statusAt(status)).headers.get("refresh");
      assert.ok(
        Number(refresh) > 0,
        `${status ?? "queued"} must refresh — a visitor should not have to reload to learn anything`,
      );
    }

    for (const status of DONE) {
      assert.equal(
        (await statusAt(status)).headers.get("refresh"),
        null,
        `${status} is the end — a page that reloads itself forever after the answer arrives is worse than the bug`,
      );
    }
  });

  test("the page claims to update itself only when it actually does", async () => {
    /**
     * The bug, restated as a rule that holds in both directions.
     *
     * The hint read "It updates as we go" while the page was a single static
     * render with no refresh of any kind — true of the design, false of the
     * code. Asserting the sentence and the header *together* is the only thing
     * that stops them drifting apart again: this fails if the copy appears
     * without the behaviour, and equally if the behaviour is dropped while the
     * promise stays on the page.
     */
    // The wording changed 2026-08-24 (it now describes the page rather than
    // the work). The regex follows the copy; the assertion below is the part
    // that matters and is unchanged.
    const CLAIM = /It updates on its own/;

    for (const status of [...LIVE, ...DONE]) {
      const res = await statusAt(status);
      const refreshes = res.headers.get("refresh") !== null;
      const promises = CLAIM.test(await res.text());
      assert.equal(
        promises,
        refreshes,
        refreshes
          ? `${status ?? "queued"} refreshes but does not say so`
          : `${status} promises to update itself and never will`,
      );
    }
  });

  test("a running audit names the step working now, not the one that just finished", async () => {
    /**
     * `timed()` records `step.<name>` *after* the work completes, so the last
     * event is what finished and the sentence must be about what follows it.
     * Getting this backwards would tell someone we were capturing their page
     * at the moment we stopped capturing it.
     */
    const during = async (done: string[]) => (await statusAt("AUDITING", done)).text();

    assert.match(
      await during(["capture"]),
      /reviewers your page needs/i,
      "capture is finished, so the choosing is what is happening",
    );
    assert.match(
      await during(["capture", "orchestrate"]),
      /Reviewers are reading/i,
      "orchestrate is finished, so the reviewers are the ones working",
    );
    assert.match(await during(["capture", "orchestrate", "review", "synthesize"]), /research/i);
  });

  test("before a reviewer exists, the page does not say reviewers are reading", async () => {
    /**
     * The lie that was already here. Every live state rendered "Reviewers are
     * on the page now", including the seconds when the only thing running was
     * a headless browser opening the URL — nobody had been spawned yet.
     */
    const html = await (await statusAt("CAPTURING", [])).text();
    assert.doesNotMatch(html, /Reviewers are (on|reading)/i);
    assert.match(html, /browser/i, "say the true thing instead: we are opening the page");
  });

  test("every step the pipeline emits has something to say about it", async () => {
    /**
     * The drift guard. The sentences are keyed on step names owned by
     * index.ts, so a rename there would silently downgrade this page to its
     * generic fallback and nothing would fail. Reading the names out of the
     * source is the only thing that notices.
     */
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const emitted = new Set([
      ...[...source.matchAll(/timed\(\s*"(\w+)"/g)].map((m) => m[1]!),
      // `lint` records its own event rather than going through `timed`.
      ...[...source.matchAll(/"step\.(\w+)"/g)].map((m) => m[1]!),
    ]);
    assert.ok(emitted.size >= 8, `expected the pipeline's steps, found ${[...emitted].join()}`);

    /**
     * Measured against the fallback rather than against a literal.
     *
     * Asserting "does not say <the generic sentence>" passes trivially before
     * the generic sentence exists, which is a test that agrees with whatever
     * it finds. A step name the code has never heard of renders the fallback
     * by construction, so anything rendering the *same page* as that is
     * unnamed — true before the fix and after it.
     */
    const fallback = await (await statusAt("AUDITING", ["nosuchstepexists"])).text();
    for (const step of emitted) {
      const html = await (await statusAt("AUDITING", [step])).text();
      assert.notEqual(
        html,
        fallback,
        `"${step}" renders exactly what an unknown step renders — it is emitted but unnamed`,
      );
    }
  });

  test("the queue says how many are ahead, and the number is real", async () => {
    /**
     * Asserted by watching it move rather than by matching a fixed position:
     * every other test in this file leaves queued rows behind, so any absolute
     * number would be a fact about the test file. Claiming the request at the
     * front must move everything behind it up by exactly one — which a printed
     * constant cannot do.
     */
    const mine = ask();
    const ahead = async () => {
      const html = await (await fetch(`${BASE}/r/${mine}`)).text();
      const m = html.match(/(\d+) ahead/);
      if (m) return Number(m[1]);
      return /yours is next/i.test(html) ? 0 : NaN;
    };

    const before = await ahead();
    assert.ok(Number.isFinite(before), "a queued page must say where in the line it is");

    const asks = new AuditRequestStore(dbPath);
    const front = asks.queue()[0]!;
    assert.notEqual(front.request_id, mine, "something must be in front, or this proves nothing");
    asks.start(front.request_id, randomUUID());
    asks.close();

    assert.equal(await ahead(), before - 1, "a claimed request has to leave the line");
  });

  /**
   * The road ahead, added 2026-08-24 after the first visitor to see this page
   * without knowing the answer asked whether it had stalled.
   *
   * Every state named what was happening and none named the *sequence*, so "In
   * the queue" read as either one step from done or one of six. The stages are
   * information rather than decoration, which is why they are asserted for
   * content and not for looks.
   */
  test("the page shows the whole road, and marks where this request is", async () => {
    const html = await (await fetch(`${BASE}/r/${ask()}`)).text();

    for (const stage of ["In the queue", "Auditing your page", "Published"]) {
      assert.ok(html.includes(stage), `the road has to name "${stage}"`);
    }
    assert.match(
      html,
      /<li class="now">In the queue<\/li>/,
      "and mark the one this request is actually in",
    );
  });

  test("a road with no human stage does not advertise one", async () => {
    // Changed 2026-08-24: an audit publishes itself unless claims.ts disputes a
    // finding, so most requests never reach a person. Listing a review stage
    // for all of them would describe something ~96% of them skip.
    const html = await (await fetch(`${BASE}/r/${ask()}`)).text();
    assert.doesNotMatch(html, /A person checks it/, "not on the ordinary road");
  });

  test("an audit that IS held says a person is in its road", async () => {
    const html = await (await statusAt("REVIEW_PENDING")).text();
    assert.match(html, /<li class="now">A person checks it<\/li>/);
  });

  test("a finished audit shows the road behind it, not ahead of it", async () => {
    const html = await (await statusAt("PUBLISHED")).text();
    assert.match(html, /<li class="now">Published<\/li>/);
    assert.match(html, /<li class="done">In the queue<\/li>/, "the earlier stages read as done");
  });

  test("a road that ended does not list a stage it will never reach", async () => {
    // The stage list is a claim about what happens next. On an audit that failed
    // or was declined, "Published" is not a later stage — it is a thing that will
    // not happen, and greying it out would be a decorated untruth of exactly the
    // kind this page keeps being rewritten to remove.
    for (const status of ["CAPTURE_FAILED", "FAILED"] as const) {
      const html = await (await statusAt(status)).text();
      assert.match(html, /class="stopped"/, `${status} marks where it stopped`);
      assert.doesNotMatch(
        html,
        /<li[^>]*>Published<\/li>/,
        `${status} must not list a publish that will never come`,
      );
    }
  });

  test("the queue does not promise a turnaround nobody is on the hook for", async () => {
    /**
     * The drain is manual — `npm run audit -- --queue` is a person deciding to
     * spend. A page that said "about eight minutes" would be describing the
     * audit's runtime as though it were the wait, which is the same class of
     * untruth as the refresh promise this page already carried once.
     */
    const html = await (await fetch(`${BASE}/r/${ask()}`)).text();
    assert.match(html, /by hand|a person/i, "say who starts it, since it is not a machine");
    assert.doesNotMatch(
      html,
      /\b\d+\s*(second|minute|hour)/i,
      "no duration while nothing guarantees one",
    );
  });

  test("the live dot shows only while something is actually running", async () => {
    /**
     * The comment above `statusPage` has always said it: "a spinner that never
     * resolves is the version of this page that lies." So the dot is not a
     * decoration for every non-final state — it marks machine work in flight.
     *
     * Queued means nothing is happening yet, and the founder gate means a
     * person is reading and might be tomorrow. A dot breathing away for a day
     * is precisely the spinner that comment refuses.
     */
    const dot = /class="pulse"/;

    for (const status of ["CAPTURING", "AUDITING"] as const) {
      assert.match(
        await (await statusAt(status, ["capture"])).text(),
        dot,
        `${status} is work in flight and should show it`,
      );
    }

    for (const status of [null, "REVIEW_PENDING", "PUBLISHED", "FAILED"] as const) {
      assert.doesNotMatch(
        await (await statusAt(status)).text(),
        dot,
        `${status ?? "queued"} has nothing running — a dot here would be the spinner that lies`,
      );
    }
  });

  test("nothing animates without a way to switch it off", async () => {
    const working = await (await statusAt("AUDITING", ["capture"])).text();
    assert.match(working, /@keyframes/, "an indicator that does not move is just a bullet");
    assert.match(working, /prefers-reduced-motion/, "motion needs an escape");
    assert.match(working, /animation\s*:\s*none/, "and the escape has to actually stop it");

    // The rules ship only where they are used, so a finished page carries no
    // animation it will never play.
    assert.doesNotMatch(await (await statusAt("PUBLISHED")).text(), /@keyframes/);
  });

  /**
   * Submitting a URL and keeping whatever cookie came back.
   *
   * Returns the request id the server sent us to, so a caller can tell a fresh
   * request from a redirect to an existing one.
   */
  async function submit(
    url: string,
    { jar = "", client = "10.0.0.1" }: { jar?: string; client?: string } = {},
  ): Promise<{ id: string; jar: string; status: number }> {
    const res = await fetch(`${BASE}/request`, {
      method: "POST",
      redirect: "manual",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-test-client": client,
        ...(jar ? { cookie: jar } : {}),
      },
      body: new URLSearchParams({ url, q0: "A shop" }).toString(),
    });
    const next = (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "";
    return {
      status: res.status,
      id: (res.headers.get("location") ?? "").replace("/r/", ""),
      jar: next.startsWith("ul_mine=") ? next : jar,
    };
  }

  /**
   * Literal addresses, because `checkUrl` resolves hostnames for real and a
   * made-up `.example` name is refused as unresolvable — which is correct, and
   * is what the visitor hit when they mistyped a URL this afternoon.
   */
  const IP = (n: number) => `http://93.184.216.${n}/`;

  /** A submission that was accepted, with the redirect the visitor follows. */
  async function accepted(url: string, opts?: { jar?: string; client?: string }) {
    const r = await submit(url, opts);
    assert.equal(r.status, 303, `expected a redirect, got ${r.status} for ${url}`);
    assert.ok(r.id.length > 0, "the redirect must name a request");
    return r;
  }

  test("asking twice for a URL already in flight returns the same audit", async () => {
    /**
     * Four times in one afternoon a visitor watched a status page, could not
     * tell anything was happening, went back and submitted the same URL again.
     * Each resubmit minted a new request and orphaned the previous one — and
     * would have spent a second $0.55 on an identical audit.
     */
    const url = IP(34);
    const first = await accepted(url, { client: "10.1.0.1" });
    const again = await accepted(url, { jar: first.jar, client: "10.1.0.1" });
    assert.equal(again.id, first.id, "the second ask should land on the audit already running");

    const asks = new AuditRequestStore(dbPath);
    const rows = asks.queue().filter((r) => r.url === url);
    asks.close();
    assert.equal(rows.length, 1, "and must not have written a second row");
  });

  test("a request in flight is only ever offered back to the browser that made it", async () => {
    /**
     * The security property, and the reason this is not keyed on the URL alone.
     *
     * `request_id` is the only credential guarding an audit — there is no login
     * before the email gate. Matching on URL across visitors would hand the
     * second person to ask about a popular site the first person's audit, whose
     * findings were shaped by their answers about their own business.
     */
    const url = IP(35);
    const mine = await accepted(url, { client: "10.2.0.1" });
    // No jar and a different address: a different browser entirely.
    const stranger = await accepted(url, { client: "10.2.0.2" });

    assert.notEqual(stranger.id, mine.id, "a stranger must never be handed someone else's request");

    const asks = new AuditRequestStore(dbPath);
    assert.equal(asks.queue().filter((r) => r.url === url).length, 2);
    asks.close();
  });

  test("the founder gate still counts as in flight", async () => {
    /**
     * The state the resubmit actually happened in: the audit was finished and
     * waiting to be read. Spending again there is the most wasteful case of
     * all, because the work is already done.
     */
    const url = IP(36);
    const first = await accepted(url, { client: "10.3.0.1" });

    const auditId = randomUUID();
    const asks = new AuditRequestStore(dbPath);
    asks.start(first.id, auditId);
    asks.close();
    const store = new AuditStore(dbPath);
    store.create(auditId, url);
    for (const s of PATH_TO.REVIEW_PENDING) store.transition(auditId, s);
    store.close();

    assert.equal((await accepted(url, { jar: first.jar, client: "10.3.0.1" })).id, first.id);
  });

  test("once it is published, asking again is a genuine new audit", async () => {
    // Someone who fixed what we found and wants to see if it worked is asking
    // a new question, not repeating an old one — that is what the subscription
    // sells, and refusing it would be the wrong kind of thrift.
    const url = IP(37);
    const first = await accepted(url, { client: "10.4.0.1" });

    const auditId = randomUUID();
    const asks = new AuditRequestStore(dbPath);
    asks.start(first.id, auditId);
    asks.close();
    const store = new AuditStore(dbPath);
    store.create(auditId, url);
    for (const s of PATH_TO.PUBLISHED) store.transition(auditId, s);
    store.close();

    assert.notEqual((await accepted(url, { jar: first.jar, client: "10.4.0.1" })).id, first.id);
  });

  test("a page whose whole job is to change is never cached", async () => {
    // Not what bit the visitor above, but a status page with no cache
    // directives at all is one heuristic away from being served stale.
    const res = await fetch(`${BASE}/r/${ask()}`);
    assert.match(res.headers.get("cache-control") ?? "", /no-store/);
  });
});

/**
 * Stripe, on a second server.
 *
 * The main server above runs unconfigured, because that is today's real state
 * and the honest copy on the results page is worth testing. Checkout needs the
 * opposite, so it gets its own process on its own port, sharing the same temp
 * database — which is also how the webhook's writes become visible to a page
 * the first server renders.
 *
 * The Stripe API itself is a stub in this file. That is deliberate and it buys
 * something real: `liveStripe` is exercised for its **request shape** — the
 * endpoint, the form encoding, the auth header, the `ul_email` metadata the
 * whole authorization model hangs on. What stays unverified is one thing, and
 * it is named in B21: whether Stripe accepts that shape.
 */
describe("Stripe, when it is configured", () => {
  const STRIPE_PORT = PORT + 2;
  const APP_PORT = PORT + 3;
  const APP = `http://127.0.0.1:${APP_PORT}`;
  const WHSEC = "whsec_test_only";
  const PAID = "ffffffff-7777-4777-8777-ffffffffffff";

  let stripeStub: import("node:http").Server;
  let paidChild: ChildProcess;
  /** Every request the stub was sent, so the tests can read what we asked for. */
  const seen: { path: string; auth: string; version: string; body: string }[] = [];

  before(async () => {
    seed(PAID, 5, true);

    const { createServer } = await import("node:http");
    stripeStub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("utf8");
        seen.push({
          path: req.url ?? "",
          auth: String(req.headers.authorization ?? ""),
          version: String(req.headers["stripe-version"] ?? ""),
          body,
        });
        res.writeHead(200, { "content-type": "application/json" });
        if ((req.url ?? "").startsWith("/checkout/sessions")) {
          res.end(JSON.stringify({ id: "cs_test_1", url: "https://checkout.stripe.test/pay/cs_test_1" }));
        } else {
          res.end(JSON.stringify({ data: [], has_more: false }));
        }
      });
    });
    await new Promise<void>((r) => stripeStub.listen(STRIPE_PORT, "127.0.0.1", r));

    paidChild = spawn(process.execPath, ["--import", "tsx", path.resolve("src/server.ts")], {
      env: {
        ...process.env,
        PORT: String(APP_PORT),
        USABILITY_LAB_DB: dbPath,
        USABILITY_LAB_OUT: outRoot,
        USABILITY_LAB_SECRET: SECRET,
        STRIPE_SECRET_KEY: "sk_test_only",
        STRIPE_PRICE_ID: "price_test_only",
        STRIPE_WEBHOOK_SECRET: WHSEC,
        STRIPE_API_BASE: `http://127.0.0.1:${STRIPE_PORT}`,
        USABILITY_LAB_BASE_URL: APP,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    paidChild.stdout?.setEncoding("utf8");
    for (let i = 0; i < 100; i++) {
      try {
        await fetch(`${APP}/`);
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("stripe-configured server did not start");
  });

  after(() => {
    paidChild?.kill();
    stripeStub?.close();
  });

  /** A session on the *configured* server, whose stdout prints its own links. */
  async function paidSession(auditId: string, email = freshEmail()) {
    const printed = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no link printed")), 5000);
      const onData = (chunk: string) => {
        const match = chunk.match(/(http:\/\/\S+\/full\?t=\S+)/);
        if (match) {
          clearTimeout(timer);
          paidChild.stdout?.off("data", onData);
          resolve(match[1]!);
        }
      };
      paidChild.stdout?.on("data", onData);
    });
    await fetch(`${APP}/a/${auditId}/email`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email }).toString(),
    });
    const link = (await printed).replace("localhost", "127.0.0.1");
    const first = await fetch(link, { redirect: "manual" });
    const jar = (first.headers.get("set-cookie") ?? "").split(";")[0]!;
    const clean = new URL(first.headers.get("location")!, APP).toString();
    const html = await (await fetch(clean, { headers: { cookie: jar } })).text();
    return { email, jar, html, clean };
  }

  function webhook(body: string, signature: string) {
    return fetch(`${APP}/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature },
      body,
    });
  }

  const subscriptionEvent = (email: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: "evt_x",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_x",
          customer: "cus_x",
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
          metadata: { ul_email: email },
          ...over,
        },
      },
    });

  /**
   * Until 2026-08-22 this link was built from `http://localhost:${PORT}`, with
   * the configured base URL read by nobody. On a laptop that is invisible — the
   * link works, because localhost *is* the server. It only becomes wrong when
   * the site is reachable somewhere else, which is the day it starts mattering:
   * a bearer credential addressed to a machine the recipient does not have.
   *
   * `paidSession` already fetches this link, and would have kept passing with
   * the bug, because `localhost` and `127.0.0.1` reach the same server from
   * here. So the assertion has to be on the text of the link, not on whether
   * following it works.
   */
  test("the magic link is built from the configured base URL, not localhost", async () => {
    const printed = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("no link printed")), 5000);
      const onData = (chunk: string) => {
        const match = chunk.match(/(https?:\/\/\S+\/full\?t=\S+)/);
        if (match) {
          clearTimeout(timer);
          paidChild.stdout?.off("data", onData);
          resolve(match[1]!);
        }
      };
      paidChild.stdout?.on("data", onData);
    });
    await fetch(`${APP}/a/${PAID}/email`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ email: freshEmail() }).toString(),
    });
    const link = await printed;
    assert.ok(
      link.startsWith(`${APP}/`),
      `the link should start with the configured ${APP}, got ${link}`,
    );
  });

  test("the page offers a real button instead of an apology", async () => {
    const { html } = await paidSession(PAID);
    assert.match(html, /Subscribe &mdash; \$29 a month/);
    assert.match(html, /name="csrf"/);
    assert.doesNotMatch(html, /Checkout is not connected yet/);
  });

  test("pressing it sends the customer to Stripe, and asks Stripe for the right thing", async () => {
    const { jar, html, email } = await paidSession(PAID);
    const before = seen.length;
    const res = await fetch(`${APP}/a/${PAID}/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar },
      body: new URLSearchParams({ csrf: csrfIn(html) }).toString(),
      redirect: "manual",
    });
    assert.equal(res.status, 303);
    assert.equal(res.headers.get("location"), "https://checkout.stripe.test/pay/cs_test_1");

    assert.equal(seen.length, before + 1);
    const call = seen[seen.length - 1]!;
    assert.match(call.path, /^\/checkout\/sessions/);
    assert.equal(call.auth, "Bearer sk_test_only");
    // Pinned, so the field names verified against that version's docs are the
    // field names Stripe applies — see STRIPE_API_VERSION.
    assert.equal(call.version, STRIPE_API_VERSION);
    const form = new URLSearchParams(call.body);
    assert.equal(form.get("mode"), "subscription");
    assert.equal(form.get("line_items[0][price]"), "price_test_only");
    /**
     * The field the whole authorization model hangs on. Stripe's form lets the
     * payer type any address; this is the one we will believe, set server-side
     * from a signed session.
     */
    assert.equal(form.get("metadata[ul_email]"), email);
    assert.equal(form.get("subscription_data[metadata][ul_email]"), email);
    assert.equal(form.get("success_url"), `${APP}/a/${PAID}/full?paid=1`);
  });

  test("a forged subscribe post buys nothing", async () => {
    const { jar } = await paidSession(PAID);
    const before = seen.length;
    const res = await fetch(`${APP}/a/${PAID}/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar },
      body: new URLSearchParams({ csrf: "nope" }).toString(),
      redirect: "manual",
    });
    assert.equal(res.status, 403);
    assert.equal(seen.length, before, "Stripe was never called");
  });

  test("a signed webhook grants access; the same body unsigned grants nothing", async () => {
    const email = freshEmail();
    const body = subscriptionEvent(email);

    const forged = await webhook(body, `t=${Math.floor(Date.now() / 1000)},v1=${"0".repeat(64)}`);
    assert.equal(forged.status, 400);
    const subs = new SubscriptionStore(dbPath);
    assert.equal(subs.isActive(email), false, "a forged webhook must grant nothing");

    const real = await webhook(body, signWebhook(body, WHSEC));
    assert.equal(real.status, 200);
    assert.equal(subs.isActive(email), true);
    subs.close();
  });

  test("the subscription belongs to the address we signed, not one Stripe was given", async () => {
    /**
     * The attack this closes: pay for a subscription, tell Stripe your email is
     * the victim's, and have us grant them — or, more usefully, tell Stripe an
     * address you control while paying, and have us grant *that*. Only
     * `metadata.ul_email` — written by this server from a signed session — is
     * ever read.
     */
    const victim = freshEmail();
    const body = JSON.stringify({
      id: "evt_y",
      type: "customer.subscription.updated",
      data: {
        object: {
          id: "sub_y",
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 86_400,
          customer_email: victim,
          customer_details: { email: victim },
          // no ul_email
        },
      },
    });
    const res = await webhook(body, signWebhook(body, WHSEC));
    assert.equal(res.status, 200, "acknowledged so Stripe stops retrying");
    const subs = new SubscriptionStore(dbPath);
    assert.equal(subs.isActive(victim), false);
    assert.equal(subs.get(victim), null, "no row at all");
    subs.close();
  });

  test("a cancellation takes access away", async () => {
    const email = freshEmail();
    const granted = subscriptionEvent(email);
    await webhook(granted, signWebhook(granted, WHSEC));

    const subs = new SubscriptionStore(dbPath);
    assert.equal(subs.isActive(email), true);

    const cancelled = JSON.stringify({
      id: "evt_z",
      type: "customer.subscription.deleted",
      data: { object: { id: "sub_x", status: "canceled", metadata: { ul_email: email } } },
    });
    await webhook(cancelled, signWebhook(cancelled, WHSEC));
    assert.equal(subs.isActive(email), false);
    subs.close();
  });

  /**
   * B22, over the wire rather than at the store.
   *
   * Stripe retries and reorders delivery. An `updated` delayed behind a
   * `deleted` arrives after it, and the write used to be last-writer-wins — so
   * a cancelled customer got their access back until reconciliation noticed,
   * up to 24 hours later. Nobody reports being given something for free.
   */
  test("a cancellation is not undone by a renewal Stripe delivers late", async () => {
    const email = freshEmail();
    const at = Math.floor(Date.now() / 1000);

    const cancelled = JSON.stringify({
      id: "evt_cancel",
      type: "customer.subscription.deleted",
      created: at,
      data: { object: { id: "sub_x", status: "canceled", metadata: { ul_email: email } } },
    });
    await webhook(cancelled, signWebhook(cancelled, WHSEC));

    const subs = new SubscriptionStore(dbPath);
    assert.equal(subs.isActive(email), false);

    // Made a minute earlier, delivered now.
    const late = JSON.stringify({
      id: "evt_renew",
      type: "customer.subscription.updated",
      created: at - 60,
      data: {
        object: {
          id: "sub_x",
          customer: "cus_x",
          status: "active",
          current_period_end: Math.floor(Date.now() / 1000) + 30 * 86_400,
          metadata: { ul_email: email },
        },
      },
    });
    const res = await webhook(late, signWebhook(late, WHSEC));

    // 200, because delivery succeeded. A non-200 would have Stripe redeliver
    // this same stale event forever.
    assert.equal(res.status, 200);
    assert.equal(await res.text(), "stale");
    assert.equal(subs.isActive(email), false, "the cancelled customer stays cancelled");
    subs.close();

    const log = new EventLog(dbPath);
    const stale = log.all().filter((e) => e.type === "webhook.stale");
    log.close();
    assert.equal(stale.length >= 1, true, "refusing a write silently is the bug next door");
  });

  test("an event with no timestamp is applied, exactly as before", async () => {
    // `created` is Stripe's field, not ours to require. Every event this suite
    // built before today omits it, and they must keep working.
    const email = freshEmail();
    const body = subscriptionEvent(email);
    await webhook(body, signWebhook(body, WHSEC));
    const subs = new SubscriptionStore(dbPath);
    assert.equal(subs.isActive(email), true);
    subs.close();
  });

  test("a status Stripe invents tomorrow grants nothing", async () => {
    const email = freshEmail();
    const body = subscriptionEvent(email, { status: "quantum_superposition" });
    await webhook(body, signWebhook(body, WHSEC));
    const subs = new SubscriptionStore(dbPath);
    assert.equal(subs.isActive(email), false);
    subs.close();
  });

  test("a replayed webhook is refused once it is old enough", async () => {
    const email = freshEmail();
    const body = subscriptionEvent(email);
    const old = signWebhook(body, WHSEC, Date.now() - 10 * 60 * 1000);
    assert.equal((await webhook(body, old)).status, 400);
    const subs = new SubscriptionStore(dbPath);
    assert.equal(subs.isActive(email), false);
    subs.close();
  });

  test("coming back from Stripe says the payment landed, not 'subscribe'", async () => {
    const { jar, clean } = await paidSession(PAID);
    const html = await (await fetch(`${clean}?paid=1`, { headers: { cookie: jar } })).text();
    assert.match(html, /Payment received/);
    assert.doesNotMatch(html, /Subscribe &mdash;/);
  });

  test("an already-paying customer is not sent to checkout again", async () => {
    const email = freshEmail();
    const body = subscriptionEvent(email);
    await webhook(body, signWebhook(body, WHSEC));

    const { jar, html } = await paidSession(PAID, email);
    // They see the re-audit button, not a subscribe button.
    assert.match(html, /Ask for a re-audit<\/button>/);
    const before = seen.length;
    const res = await fetch(`${APP}/a/${PAID}/subscribe`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", cookie: jar },
      body: new URLSearchParams({ csrf: csrfIn(html) }).toString(),
      redirect: "manual",
    });
    assert.equal(res.status, 200);
    assert.equal(seen.length, before, "Stripe was not asked to sell a second subscription");
  });
});

describe("the webhook when Stripe is not configured", () => {
  test("does not exist", async () => {
    // A 404 rather than a 400: an unconfigured deployment must not advertise an
    // endpoint it has no secret to check.
    const res = await fetch(`${BASE}/stripe/webhook`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 404);
  });
});

describe("the question flow under pressure", () => {
  /**
   * Driven over IPv6 so this suite has its own client key.
   *
   * The per-client limit keys on the connecting socket's address, and every
   * other test here arrives from `127.0.0.1`. Exhausting that key would starve
   * them — the same problem the BOMB fixture solves for the per-audit
   * allowance, and the same solution: give the test that spends an allowance
   * its own.
   */
  const V6 = `http://[::1]:${PORT}`;

  test("one client cannot queue audits without limit", async () => {
    const submit = () =>
      fetch(`${V6}/request`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ url: "http://93.184.216.34/" }).toString(),
        redirect: "manual",
      });

    let throttled = 0;
    for (let i = 0; i < 8; i++) {
      const res = await submit();
      if (res.status === 429) throttled += 1;
      await res.text();
    }
    assert.ok(throttled >= 2, `expected the limit to bite; ${throttled} of 8 were refused`);
  });

  test("and a throttled attempt is recorded", async () => {
    const events = new EventLog(dbPath);
    const throttles = events.all().filter((e) => e.type === "request.throttled");
    events.close();
    assert.ok(throttles.length > 0);
    assert.equal(throttles[0]!.data.key, "client");
  });
});

/**
 * One host, one site.
 *
 * The tunnel routes `www.theusabilitylab.com` to the same process as the apex,
 * so without a redirect the app answers on both. That is not cosmetic: `ul_full`
 * is scoped to the host that set it, and magic links are built from `BASE_URL`,
 * which is always the apex. A visitor who signs in on `www` and then follows
 * their link arrives at a different host without the cookie they just earned —
 * and the page tells them to sign in again, for ever.
 */
describe("one host, one site", () => {
  const HOST_PORT = PORT + 5;
  const CANON = "https://theusabilitylab.test";
  let hostChild: ChildProcess;

  /**
   * Raw `http.request`, not `fetch`. Undici treats `Host` as forbidden and drops
   * it silently, and the Host header is the entire subject of this suite — a
   * test that cannot set it would pass no matter what the server did.
   */
  function ask(
    host: string,
    pathname = "/",
    method = "GET",
    port = HOST_PORT,
  ): Promise<{ status: number; location: string | undefined; hsts: string | undefined }> {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port, path: pathname, method, headers: { host } },
        (res) => {
          res.resume();
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              location: res.headers.location,
              hsts: res.headers["strict-transport-security"] as string | undefined,
            }),
          );
        },
      );
      req.on("error", reject);
      req.end();
    });
  }

  before(async () => {
    hostChild = spawn(process.execPath, ["--import", "tsx", path.resolve("src/server.ts")], {
      env: {
        ...process.env,
        PORT: String(HOST_PORT),
        USABILITY_LAB_DB: dbPath,
        USABILITY_LAB_OUT: outRoot,
        USABILITY_LAB_SECRET: SECRET,
        // The claim that makes canonicalisation apply, per preflight.ts. The
        // host never resolves and never needs to: nothing here dials it.
        USABILITY_LAB_BASE_URL: CANON,
        USABILITY_LAB_SECURE_COOKIES: "1",
        USABILITY_LAB_CLIENT_IP_HEADER: "cf-connecting-ip",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    for (let i = 0; i < 100; i++) {
      try {
        await ask("theusabilitylab.test");
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    throw new Error("host-canonical server did not start");
  });

  after(() => hostChild?.kill());

  test("the canonical host is served, not redirected", async () => {
    const { status } = await ask("theusabilitylab.test");
    assert.equal(status, 200);
  });

  test("www is redirected to the apex, with the path and query intact", async () => {
    const { status, location } = await ask("www.theusabilitylab.test", "/start?ref=twitter");
    assert.equal(status, 308);
    assert.equal(location, `${CANON}/start?ref=twitter`);
  });

  test("the comparison ignores case, as hostnames do", async () => {
    const { status } = await ask("TheUsabilityLab.test");
    assert.equal(status, 200, "an uppercase Host is the same host, not a stranger");
  });

  /**
   * The open-redirect guard. `Host` is attacker-controlled, so a redirect that
   * echoed it back would hand anyone a link on our domain that lands on theirs —
   * which is worth more to a phisher than the site is to us, because the magic
   * link has trained the customer to click.
   */
  test("the Location is never the host the client asked for", async () => {
    const { status, location } = await ask("evil.example", "/a/x/full?t=stolen");
    assert.equal(status, 308);
    assert.ok(
      location?.startsWith(`${CANON}/`),
      `Location must be our own base URL, got ${location}`,
    );
    assert.doesNotMatch(location ?? "", /evil\.example/);
  });

  /**
   * A 301 permits a client to rewrite the method to GET. For a webhook that is
   * not a redirect, it is a silent drop — F21 arriving by status code. 308 says
   * the same thing about permanence and forbids the rewrite, so it is used for
   * every method rather than only the ones that carry a body.
   */
  test("a request with a body is redirected with 308, which preserves the method", async () => {
    const { status } = await ask("www.theusabilitylab.test", "/stripe/webhook", "POST");
    assert.equal(status, 308);
  });

  /**
   * The local run must be untouched. Developers reach the server by localhost,
   * 127.0.0.1, a LAN address and occasionally a hostname, and a canonicalisation
   * that fired without a public base URL would break all but one of them.
   */
  test("with no public base URL, any host is served and nothing is redirected", async () => {
    const { status } = await ask("anything.at.all", "/", "GET", PORT);
    assert.equal(status, 200);
  });

  /**
   * HSTS, on a server that has claimed a public address.
   *
   * A year and `includeSubDomains`, because `www` is the only subdomain and it
   * comes through the same tunnel. No `preload` — that is a submission to a list
   * compiled into browser binaries, and getting off it takes months.
   */
  test("a public server promises https for a year", async () => {
    const { hsts } = await ask("theusabilitylab.test");
    assert.equal(hsts, "max-age=31536000; includeSubDomains");
  });

  /**
   * The reason it is set at the top of `handle` rather than inside `send`: the
   * responses most likely to be a visitor's *first* are the ones that never
   * reach a page helper. A 404 from a mistyped link and the www redirect both
   * skip `send()` entirely, and the first request is the only one HSTS protects.
   */
  test("and makes it on the responses that never reach a page helper", async () => {
    const missing = await ask("theusabilitylab.test", "/no-such-page");
    assert.equal(missing.status, 404);
    assert.match(missing.hsts ?? "", /max-age=31536000/, "a 404 is somebody's first request");

    const redirected = await ask("www.theusabilitylab.test", "/");
    assert.equal(redirected.status, 308);
    assert.match(redirected.hsts ?? "", /max-age=31536000/, "so is the www redirect");
  });
});


/**
 * The dashboard, and the rule it is one mistake away from breaking.
 *
 * `server.ts` refused to index audits for its whole life — "an index would be
 * a cross-customer surface, which §8 says a customer must never reach". This
 * builds that index, so the tests worth having are the ones where it leaks:
 * a token for one address must never list another's audits, and a token that
 * was edited must list nothing at all.
 */
describe("your audits, and only yours", () => {
  const MINE = "mine@example.com";
  const THEIRS = "theirs@example.com";

  before(() => {
    const captures = new EmailCaptureStore(dbPath);
    captures.capture(A, MINE);
    captures.capture(B, THEIRS);
    captures.close();
  });

  const account = (token: string) => fetch(`${BASE}/account?t=${token}`, { redirect: "manual" });

  test("an account token lists that address's audits", async () => {
    const res = await account(signAccount(MINE));
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Your audits/);
    assert.ok(html.includes(A), "the audit this address captured");
  });

  test("and nobody else's", async () => {
    // The one that matters. B belongs to another address and must not appear,
    // by id or by link.
    const html = await (await account(signAccount(MINE))).text();
    assert.ok(!html.includes(B), "another customer's audit must not be on this page");
  });

  test("an edited token lists nothing", async () => {
    // Swap the address in the payload and re-encode. The signature no longer
    // matches, and the failure has to be total rather than partial.
    const token = signAccount(MINE);
    const [payload, sig] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString("utf8"));
    claims.email = THEIRS;
    const forged = `${Buffer.from(JSON.stringify(claims)).toString("base64url")}.${sig}`;

    const res = await account(forged);
    assert.equal(res.status, 401);
    const html = await res.text();
    assert.ok(!html.includes(B), "a forged token must reveal nothing");
    assert.ok(!html.includes(A));
  });

  test("an account token cannot open an audit", async () => {
    /**
     * The blast radius, pinned. An account token opens an index; the audits
     * themselves are still per-audit tokens, which is why a leaked sign-in link
     * discloses which pages someone audited and not what they say.
     */
    const token = signAccount(MINE);
    assert.equal(verify(token, A).ok, false, "the audit verifier must refuse it");

    const res = await fetch(`${BASE}/a/${A}/full?t=${token}`, { redirect: "manual" });
    assert.notEqual(res.status, 200);
  });

  test("the schedule teaser shows the idea without pretending it works", async () => {
    /**
     * §0 lists scheduled monitoring as designed-and-not-built, and this is that
     * said on the page where it would live. The assertion that matters is the
     * negative one: it must not be a link or a button, because a control that
     * looks live and does nothing is the failure this repo keeps correcting —
     * most recently a footer claiming a person had read an audit nobody read.
     */
    const html = await (await account(signAccount(MINE))).text();
    assert.match(html, /Schedule audits/);
    assert.match(html, /Not built yet/, "and says so where a reader will see it");

    const block = html.slice(html.indexOf('class="soon"'));
    const teaser = block.slice(0, block.indexOf("</div>", block.indexOf("<p")));
    assert.doesNotMatch(teaser, /<a\s|<button|href=/, "nothing here may be clickable");
  });

  test("no token at all is refused", async () => {
    assert.equal((await fetch(`${BASE}/account`, { redirect: "manual" })).status, 401);
  });

  test("signing in says the same thing to a stranger as to a customer", async () => {
    /**
     * Otherwise the form is a customer list: submit an address, read the
     * difference, learn who pays for this. The rate limiter is spent before the
     * lookup for the same reason — throttling only known addresses would leak
     * the same fact more slowly.
     */
    const post = (email: string) =>
      fetch(`${BASE}/signin`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ email }).toString(),
        redirect: "manual",
      });

    const known = await post(MINE);
    const stranger = await post("nobody-at-all@example.com");

    assert.equal(known.status, stranger.status);
    const [a, b] = [await known.text(), await stranger.text()];
    assert.match(a, /a sign-in link is on its way/);
    // Identical but for the address echoed back, which the sender already knew.
    assert.equal(
      a.replace(MINE, "X"),
      b.replace("nobody-at-all@example.com", "X"),
      "the two responses must not be distinguishable",
    );
  });
});
