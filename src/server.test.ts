import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
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
} from "./db.js";
import { QUESTIONS } from "./profile.js";
import { sign, verify, looksLikeEmail, csrfFor, csrfMatches, TOKEN_TTL_MS } from "./tokens.js";
import { signWebhook, STRIPE_API_VERSION } from "./stripe.js";
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

  test("the homepage asks the same five questions the CLI does", async () => {
    const html = await (await fetch(`${BASE}/`)).text();
    for (const q of QUESTIONS) {
      assert.match(html, new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "&#39;")), q);
    }
    assert.match(html, /name="url"/);
  });

  test("and still lists no audits", async () => {
    const html = await (await fetch(`${BASE}/`)).text();
    assert.doesNotMatch(html, new RegExp(A));
    assert.doesNotMatch(html, /example\.com/);
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

  test("an over-long answer is refused, and what was typed comes back", async () => {
    const before = queued();
    const res = await submit({ url: OK_URL, q0: "x".repeat(1001), q1: "keep this" });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /longer than 1000 characters/);
    assert.match(html, /keep this/, "the other answers survive the mistake");
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
    assert.match(await at(), /Your team is assembling/);

    store.transition(auditId, "AUDITING");
    store.transition(auditId, "ASSEMBLING");
    store.transition(auditId, "REVIEW_PENDING");
    assert.match(await at(), /a person is reading it/);

    store.transition(auditId, "PUBLISHED");
    const done = await at();
    assert.match(done, new RegExp(`href="/a/${auditId}/"`));
    store.close();
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
