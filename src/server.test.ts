import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditStore, EmailCaptureStore, EventLog } from "./db.js";
import { sign, verify, looksLikeEmail, TOKEN_TTL_MS } from "./tokens.js";

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
    const link = await askForLink(A, "kelly@example.com");
    const res = await fetch(link);
    assert.equal(res.status, 200);
    const html = await res.text();
    assert.match(html, /Observation number 9/, "every kept finding is shown");
    assert.doesNotMatch(html, /more findings/, "nothing is withheld any more");
  });

  test("a link for audit A does not open audit B", async () => {
    // The test this file exists for.
    const link = await askForLink(A, "kelly@example.com");
    const token = new URL(link).searchParams.get("t")!;
    const res = await fetch(`${BASE}/a/${B}/full?t=${encodeURIComponent(token)}`);
    assert.equal(res.status, 403);
    const html = await res.text();
    assert.match(html, /different audit/);
    assert.doesNotMatch(html, /Observation number/, "no finding leaks into the refusal");
  });

  test("a tampered token is refused", async () => {
    const link = await askForLink(A, "kelly@example.com");
    const token = new URL(link).searchParams.get("t")!;
    const bent = token.slice(0, -2) + (token.endsWith("aa") ? "bb" : "aa");
    const res = await fetch(`${BASE}/a/${A}/full?t=${encodeURIComponent(bent)}`);
    assert.equal(res.status, 403);
  });

  test("do not show what the founder cut", async () => {
    // The full page is the public renderer with everything revealed, not
    // results-full.html. The founder's page carries cut findings and the
    // Synthesizer's set-aside reasoning; a customer must never see either.
    const link = await askForLink(A, "kelly@example.com");
    const html = await (await fetch(link)).text();
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
    const link = await askForLink(B, "verifier@example.com");
    await fetch(link);
    const captures = new EmailCaptureStore(dbPath);
    const row = captures.get(B, "verifier@example.com");
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

describe("the root", () => {
  test("does not list audits", async () => {
    const html = await (await fetch(`${BASE}/`)).text();
    assert.doesNotMatch(html, new RegExp(A));
    assert.doesNotMatch(html, /example\.com/);
  });
});
