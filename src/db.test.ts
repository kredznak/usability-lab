import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  AuditStore,
  CallLog,
  IllegalTransition,
  SubscriptionStore,
  ReauditRequestStore,
  type AuditStatus,
} from "./db.js";

/**
 * The state machine is the whole point of the review gate, so the test that
 * matters most is the one proving the gate cannot be walked around: there is no
 * edge from ASSEMBLING to PUBLISHED. If that edge ever appears, an audit can
 * reach a customer without a person having read it, and nothing else in the
 * system would notice.
 */

function store(): { s: AuditStore; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "ulab-db-"));
  return { s: new AuditStore(path.join(dir, "test.db")), dir };
}

function withStore(fn: (s: AuditStore) => void): void {
  const { s, dir } = store();
  try {
    fn(s);
  } finally {
    s.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The v0 happy path: no Research step, so AUDITING goes straight to ASSEMBLING. */
const HAPPY: AuditStatus[] = ["CAPTURING", "AUDITING", "ASSEMBLING", "REVIEW_PENDING", "PUBLISHED"];

describe("audits: the state machine", () => {
  test("an audit starts at REQUESTED and walks the v0 path to PUBLISHED", () => {
    withStore((s) => {
      s.create("a1", "https://example.com");
      assert.equal(s.get("a1")?.status, "REQUESTED");
      for (const next of HAPPY) {
        s.transition("a1", next);
        assert.equal(s.get("a1")?.status, next);
      }
    });
  });

  test("ASSEMBLING cannot reach PUBLISHED — the gate has no bypass", () => {
    withStore((s) => {
      s.create("a1", "https://example.com");
      for (const next of ["CAPTURING", "AUDITING", "ASSEMBLING"] as AuditStatus[]) {
        s.transition("a1", next);
      }
      assert.throws(() => s.transition("a1", "PUBLISHED"), IllegalTransition);
      assert.equal(s.get("a1")?.status, "ASSEMBLING", "a refused transition changes nothing");
    });
  });

  test("PUBLISHED is terminal, including for failure", () => {
    withStore((s) => {
      s.create("a1", "https://example.com");
      for (const next of HAPPY) s.transition("a1", next);
      assert.throws(() => s.transition("a1", "REVIEW_PENDING"), IllegalTransition);
      assert.throws(() => s.transition("a1", "FAILED"), IllegalTransition);
    });
  });

  /**
   * The gate could say "publish" and could not say "no".
   *
   * myschools.nyc (`2ae5a280`) was audited successfully and then declined —
   * we do not want a critique of a public school enrolment service published
   * under our name. Before this there was nowhere to put that: leaving it
   * REVIEW_PENDING forever recorded nothing, and FAILED would have filed a
   * working audit among the fifteen that genuinely broke.
   */
  test("a reviewed audit can be declined, and that is the end of it", () => {
    withStore((s) => {
      s.create("a1", "https://example.com");
      for (const next of HAPPY) {
        if (next === "PUBLISHED") break;
        s.transition("a1", next);
      }
      assert.equal(s.get("a1")?.status, "REVIEW_PENDING");
      s.transition("a1", "DECLINED");
      assert.equal(s.get("a1")?.status, "DECLINED");
    });
  });

  test("declining is not a detour to publishing", () => {
    // The whole value of the state is that it means the founder said no. A
    // DECLINED audit that could still be published would make the record a
    // suggestion rather than a decision.
    withStore((s) => {
      s.create("a1", "https://example.com");
      for (const next of HAPPY) {
        if (next === "PUBLISHED") break;
        s.transition("a1", next);
      }
      s.transition("a1", "DECLINED");
      assert.throws(() => s.transition("a1", "PUBLISHED"), IllegalTransition);
      assert.throws(() => s.transition("a1", "REVIEW_PENDING"), IllegalTransition);
      assert.throws(() => s.transition("a1", "FAILED"), IllegalTransition);
      assert.equal(s.get("a1")?.status, "DECLINED", "a refused transition changes nothing");
    });
  });

  test("declining does not stamp published_at", () => {
    // published_at is what the funnel and the corpus read to mean "a visitor
    // could see this". A declined audit was never visible to anyone.
    withStore((s) => {
      s.create("a1", "https://example.com");
      for (const next of HAPPY) {
        if (next === "PUBLISHED") break;
        s.transition("a1", next);
      }
      s.transition("a1", "DECLINED");
      assert.equal(s.get("a1")?.published_at, null);
    });
  });

  test("any live state can fail", () => {
    for (const from of ["CAPTURING", "AUDITING", "ASSEMBLING", "REVIEW_PENDING"] as AuditStatus[]) {
      withStore((s) => {
        s.create("a1", "https://example.com");
        for (const next of HAPPY) {
          s.transition("a1", next);
          if (next === from) break;
        }
        s.transition("a1", "FAILED");
        assert.equal(s.get("a1")?.status, "FAILED");
      });
    }
  });

  test("a capture failure can retry, and an auto-published audit can be pulled back for review", () => {
    withStore((s) => {
      s.create("a1", "https://example.com");
      s.transition("a1", "CAPTURING");
      s.transition("a1", "CAPTURE_FAILED");
      s.transition("a1", "CAPTURING"); // F1 retry queue
      assert.equal(s.get("a1")?.status, "CAPTURING");

      // A correction or a failed 1-in-5 sample flips the site back (§6).
      s.create("a2", "https://example.com");
      for (const next of ["CAPTURING", "AUDITING", "ASSEMBLING", "AUTO_PUBLISHED"] as AuditStatus[]) {
        s.transition("a2", next);
      }
      s.transition("a2", "REVIEW_PENDING");
      assert.equal(s.get("a2")?.status, "REVIEW_PENDING");
    });
  });

  test("publishing stamps published_at; earlier transitions do not", () => {
    withStore((s) => {
      s.create("a1", "https://example.com");
      s.transition("a1", "CAPTURING");
      s.transition("a1", "AUDITING");
      s.transition("a1", "ASSEMBLING");
      s.transition("a1", "REVIEW_PENDING", { findings_total: 17 });
      assert.equal(s.get("a1")?.published_at, null);
      assert.equal(s.get("a1")?.findings_total, 17);

      s.transition("a1", "PUBLISHED", { findings_published: 3 });
      const row = s.get("a1");
      assert.ok(row?.published_at, "published_at is stamped on publish");
      assert.equal(row?.findings_published, 3);
      assert.equal(row?.findings_total, 17, "earlier fields survive a later transition");
    });
  });

  test("transitioning an audit that does not exist is an error, not a silent insert", () => {
    withStore((s) => {
      assert.throws(() => s.transition("nope", "CAPTURING"), /does not exist/);
    });
  });

  test("find matches on an id prefix, so the CLI can take eight characters", () => {
    withStore((s) => {
      s.create("1e6d5d13-638e-4d58", "https://allbirds.com");
      s.create("45567cab-13a0-43ee", "https://gov.uk");
      assert.equal(s.find("1e6d5d13").length, 1);
      assert.equal(s.find("1e6d5d13")[0]?.url, "https://allbirds.com");
      assert.equal(s.find("zzzz").length, 0);
    });
  });
});

/**
 * B14's column, and the migration that has to come with it.
 *
 * `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists, so
 * shipping a new column without an ALTER means every insert fails against the
 * database we have been writing to all week — the one holding every audit and
 * every cost row this project has produced.
 */
describe("model_calls records how many HTTP attempts a call took", () => {
  test("a database created before the column gains it, keeping its rows", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ulab-attempts-"));
    const file = path.join(dir, "old.db");

    const old = new Database(file);
    old.exec(`
      CREATE TABLE model_calls (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        audit_id TEXT NOT NULL, agent TEXT NOT NULL, model TEXT NOT NULL,
        prompt_version TEXT NOT NULL, input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL, cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0, latency_ms INTEGER NOT NULL,
        cost_usd REAL NOT NULL, ok INTEGER NOT NULL, error TEXT,
        created_at TEXT NOT NULL
      );
      INSERT INTO model_calls VALUES
        (1,'a1','synthesizer','claude-opus-5','synthesizer-v2',10,20,0,0,1618602,0.14,1,NULL,'2026-08-17');
    `);
    old.close();

    const log = new CallLog(file);
    log.record({
      audit_id: "a2", agent: "researcher", model: "claude-sonnet-5",
      prompt_version: "researcher-v1", input_tokens: 1, output_tokens: 2,
      cache_read_tokens: 0, cache_write_tokens: 0, latency_ms: 3, cost_usd: 0.01,
      ok: true, error: null, attempts: 3,
    });
    log.close();

    const check = new Database(file);
    const rows = check.prepare(`SELECT audit_id, attempts FROM model_calls ORDER BY id`).all() as
      { audit_id: string; attempts: number | null }[];
    check.close();
    rmSync(dir, { recursive: true, force: true });

    assert.equal(rows.length, 2, "the pre-existing row must survive the migration");
    assert.equal(rows[0]!.attempts, null, "a call made before we counted is unknown, not 1");
    assert.equal(rows[1]!.attempts, 3);
  });

  test("a call with no count recorded stores null rather than a guess", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ulab-attempts2-"));
    const log = new CallLog(path.join(dir, "new.db"));
    log.record({
      audit_id: "a3", agent: "profiler", model: "claude-haiku-4-5",
      prompt_version: "profiler-v1", input_tokens: 1, output_tokens: 2,
      cache_read_tokens: 0, cache_write_tokens: 0, latency_ms: 3, cost_usd: 0.01,
      ok: true, error: null,
    });
    log.close();
    const check = new Database(path.join(dir, "new.db"));
    const row = check.prepare(`SELECT attempts FROM model_calls`).get() as { attempts: number | null };
    check.close();
    rmSync(dir, { recursive: true, force: true });
    assert.equal(row.attempts, null);
  });

  /**
   * F11's counter. The ceiling is only as good as the number it compares
   * against, and that number is a `LIKE` against an ISO timestamp — a shape
   * that is easy to get subtly wrong and impossible to notice, because being
   * wrong makes it read *low* and a low number never stops anything.
   */
  test("a day's spend is that day's calls, failures included", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ulab-spend-"));
    const log = new CallLog(path.join(dir, "s.db"));
    const call = (cost: number, ok: boolean, at: string) =>
      log.record({
        audit_id: "a1", agent: "researcher", model: "claude-sonnet-5",
        prompt_version: "v1", input_tokens: 1, output_tokens: 2,
        cache_read_tokens: 0, cache_write_tokens: 0, latency_ms: 3,
        cost_usd: cost, ok, error: ok ? null : "timeout",
      }) ?? at;

    call(1, true, "");
    call(2, false, ""); // billed for its tokens whatever the outcome
    log.close();

    const check = new Database(path.join(dir, "s.db"));
    // Backdate one row: `record` stamps `now`, so a second day has to be made.
    check.prepare(`UPDATE model_calls SET created_at = '2026-08-01T09:00:00.000Z' WHERE id = 1`).run();
    check.close();

    const reopened = new CallLog(path.join(dir, "s.db"));
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(reopened.spentOn("2026-08-01"), 1, "the backdated call, alone on its day");
    assert.equal(reopened.spentOn(today), 2, "the failed call still counts against the ceiling");
    assert.equal(reopened.spentOn("2026-07-31"), 0, "a day with no calls is zero, not a crash");
    reopened.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * Re-audits have to be distinguishable from first audits.
 *
 * Before this column there was nothing anywhere that told them apart:
 * `reaudit.checked` is logged against the *baseline*, so the audit a re-audit
 * produces carried no link back. basecamp was 3 of 9 published audits and 40%
 * of all published findings, and no query could have said so.
 */
describe("audits record the baseline they were compared against", () => {
  test("a first audit has no baseline", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ulab-baseline-"));
    const store = new AuditStore(path.join(dir, "a.db"));
    store.create("a1", "https://example.com");
    const row = store.get("a1")!;
    store.close();
    rmSync(dir, { recursive: true, force: true });
    assert.equal(row.baseline_audit_id, null);
  });

  test("a re-audit records which audit it followed", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ulab-baseline2-"));
    const store = new AuditStore(path.join(dir, "a.db"));
    store.create("a2", "https://example.com", "a1");
    const row = store.get("a2")!;
    store.close();
    rmSync(dir, { recursive: true, force: true });
    assert.equal(row.baseline_audit_id, "a1");
  });

  test("a database written before the column gains it, keeping its rows", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "ulab-baseline3-"));
    const file = path.join(dir, "old.db");
    const old = new Database(file);
    old.exec(`
      CREATE TABLE audits (
        audit_id TEXT PRIMARY KEY, url TEXT NOT NULL, final_url TEXT, title TEXT,
        status TEXT NOT NULL, profile_summary TEXT, findings_total INTEGER NOT NULL DEFAULT 0,
        findings_published INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, published_at TEXT
      );
      INSERT INTO audits (audit_id, url, status, created_at, updated_at)
        VALUES ('old1', 'https://example.com', 'PUBLISHED', '2026-08-11', '2026-08-11');
    `);
    old.close();

    const store = new AuditStore(file);
    store.create("new1", "https://example.com", "old1");
    const before = store.get("old1")!;
    const after = store.get("new1")!;
    store.close();
    rmSync(dir, { recursive: true, force: true });

    assert.equal(before.status, "PUBLISHED", "the pre-existing row must survive");
    assert.equal(before.baseline_audit_id, null, "an old audit is a first audit, not unknown-shaped");
    assert.equal(after.baseline_audit_id, "old1");
  });
});

/**
 * Subscriptions and the re-audit queue.
 *
 * Two stores, one property between them: **nothing gets to spend money by
 * accident.** `isActive` decides who may ask, `pending` decides how often, and
 * `complete` decides that a request is never acted on twice.
 */
function tempPath(): { file: string; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "ulab-sub-"));
  return { file: path.join(dir, "test.db"), dir };
}

describe("subscriptions", () => {
  test("access hangs on the date, not on the word", () => {
    const { file, dir } = tempPath();
    const s = new SubscriptionStore(file);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    const past = new Date(Date.now() - 86_400_000).toISOString();

    assert.equal(s.isActive("nobody@example.com"), false, "no row, no access");

    s.upsert("a@example.com", { status: "active", currentPeriodEnd: future });
    assert.equal(s.isActive("a@example.com"), true);

    s.upsert("b@example.com", { status: "active", currentPeriodEnd: past });
    assert.equal(s.isActive("b@example.com"), false, "paid, but the period ran out");

    // The case that decides which way this store fails. A row that says
    // "active" with no end date grants nothing — see db.ts on F21.
    s.upsert("c@example.com", { status: "active", currentPeriodEnd: null });
    assert.equal(s.isActive("c@example.com"), false, "active with no end date is not access");

    s.upsert("d@example.com", { status: "past_due", currentPeriodEnd: future });
    assert.equal(s.isActive("d@example.com"), false);

    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("addresses are matched however they were typed", () => {
    const { file, dir } = tempPath();
    const s = new SubscriptionStore(file);
    const future = new Date(Date.now() + 86_400_000).toISOString();
    s.upsert("  Kelly@Example.COM ", { status: "active", currentPeriodEnd: future });
    assert.equal(s.isActive("kelly@example.com"), true);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a later write that omits the Stripe ids does not erase them", () => {
    // The reconciliation job knows the status and the period; the webhook knows
    // the ids. Both write this row, and neither should be able to blank what
    // the other put there.
    const { file, dir } = tempPath();
    const s = new SubscriptionStore(file);
    s.upsert("e@example.com", {
      status: "active",
      stripeCustomerId: "cus_123",
      stripeSubscriptionId: "sub_456",
      currentPeriodEnd: "2026-09-01T00:00:00.000Z",
    });
    s.upsert("e@example.com", { status: "canceled", currentPeriodEnd: null });

    const row = s.get("e@example.com")!;
    assert.equal(row.status, "canceled");
    assert.equal(row.stripe_customer_id, "cus_123");
    assert.equal(row.stripe_subscription_id, "sub_456");
    assert.equal(row.current_period_end, null, "the period is stated fresh every time, and can clear");
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * B22. Stripe retries and reorders delivery, so the sequence a subscription
 * actually moved through is the one in the event timestamps, not the one the
 * socket handed us. Before this, `upsert` was last-writer-wins and a delayed
 * `updated` landing after a `deleted` gave a cancelled customer their access
 * back until reconciliation noticed, up to 24 hours later.
 *
 * The failure direction is free access, which nobody reports.
 */
describe("subscriptions applied in Stripe's order, not the socket's", () => {
  const future = new Date(Date.now() + 86_400_000).toISOString();

  test("a cancel that arrives first is not undone by the renewal it followed", () => {
    const { file, dir } = tempPath();
    const s = new SubscriptionStore(file);

    s.upsert("e@example.com", { status: "canceled", currentPeriodEnd: null }, { eventAt: 200 });
    const applied = s.upsert(
      "e@example.com",
      { status: "active", currentPeriodEnd: future },
      { eventAt: 100 },
    );

    assert.equal(applied, false, "the caller is told, so it can record it");
    const row = s.get("e@example.com")!;
    assert.equal(row.status, "canceled");
    assert.equal(row.current_period_end, null);
    assert.equal(s.isActive("e@example.com"), false, "and no access is granted");
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a newer event still applies, which is the whole point of ordering", () => {
    const { file, dir } = tempPath();
    const s = new SubscriptionStore(file);

    s.upsert("e@example.com", { status: "active", currentPeriodEnd: future }, { eventAt: 100 });
    assert.equal(
      s.upsert("e@example.com", { status: "canceled", currentPeriodEnd: null }, { eventAt: 200 }),
      true,
    );
    assert.equal(s.get("e@example.com")!.status, "canceled");
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("two events in the same second both apply", () => {
    // Stripe stamps `created` in whole seconds and sends `created` and
    // `updated` inside one. Rejecting ties would drop a real update, which is
    // worse than briefly applying a same-second one.
    const { file, dir } = tempPath();
    const s = new SubscriptionStore(file);

    s.upsert("e@example.com", { status: "past_due", currentPeriodEnd: null }, { eventAt: 100 });
    assert.equal(
      s.upsert("e@example.com", { status: "active", currentPeriodEnd: future }, { eventAt: 100 }),
      true,
    );
    assert.equal(s.get("e@example.com")!.status, "active");
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("reconciliation is never blocked by the guard", () => {
    // It is the repair for everything this guard cannot see — a webhook Stripe
    // never delivered leaves no timestamp to compare against. A reconcile write
    // carries no event and must always land.
    const { file, dir } = tempPath();
    const s = new SubscriptionStore(file);

    s.upsert("e@example.com", { status: "canceled", currentPeriodEnd: null }, { eventAt: 500 });
    assert.equal(
      s.upsert("e@example.com", { status: "active", currentPeriodEnd: future }),
      true,
      "no eventAt, no ordering",
    );
    assert.equal(s.get("e@example.com")!.status, "active");
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a reconcile does not erase the order a webhook established", () => {
    // The subtle one. If a write without an event cleared `last_event_at`, a
    // stale webhook arriving after the nightly job would be applied again.
    const { file, dir } = tempPath();
    const s = new SubscriptionStore(file);

    s.upsert("e@example.com", { status: "canceled", currentPeriodEnd: null }, { eventAt: 500 });
    s.upsert("e@example.com", { status: "canceled", currentPeriodEnd: null }); // reconcile
    assert.equal(s.get("e@example.com")!.last_event_at, 500, "the timestamp survives");

    assert.equal(
      s.upsert("e@example.com", { status: "active", currentPeriodEnd: future }, { eventAt: 400 }),
      false,
      "and the stale event is still refused",
    );
    assert.equal(s.get("e@example.com")!.status, "canceled");
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a row that predates the column takes the first event it sees", () => {
    // Existing rows migrate to NULL, which means no ordered event has been
    // applied. Refusing writes against NULL would freeze every live row.
    const { file, dir } = tempPath();
    const s = new SubscriptionStore(file);

    s.upsert("e@example.com", { status: "active", currentPeriodEnd: future });
    assert.equal(s.get("e@example.com")!.last_event_at, null);
    assert.equal(
      s.upsert("e@example.com", { status: "canceled", currentPeriodEnd: null }, { eventAt: 1 }),
      true,
    );
    assert.equal(s.get("e@example.com")!.last_event_at, 1);
    s.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("the re-audit queue", () => {
  test("pending is per reader and per audit, and clears when acted on", () => {
    const { file, dir } = tempPath();
    const r = new ReauditRequestStore(file);

    r.request("audit-1", "kelly@example.com", "https://example.com/");
    assert.equal(r.pending("audit-1", "kelly@example.com"), true);
    assert.equal(r.pending("audit-2", "kelly@example.com"), false, "a different page is a different ask");
    assert.equal(r.pending("audit-1", "someone@example.com"), false, "a different reader is too");

    r.complete(r.queue()[0]!.id);
    assert.equal(r.pending("audit-1", "kelly@example.com"), false);
    assert.equal(r.queue().length, 0);
    // Still counted: the ask was spent, whatever came of it — see fairuse.ts.
    assert.equal(r.forEmail("kelly@example.com").length, 1);

    r.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("the queue is oldest first, and completing twice is not an error", () => {
    const { file, dir } = tempPath();
    const r = new ReauditRequestStore(file);
    r.request("a1", "k@example.com", "https://one.com/");
    r.request("a2", "k@example.com", "https://two.com/");

    assert.deepEqual(r.queue().map((x) => x.url), ["https://one.com/", "https://two.com/"]);

    // Two explicit clocks, a year apart. Called with the real one, both writes
    // land in the same millisecond and the assertion below cannot fail — which
    // is what happened when this was written without them.
    const first = r.queue()[0]!;
    r.complete(first.id, new Date("2026-01-01T00:00:00.000Z"));
    const at = r.forEmail("k@example.com")[0]!.completed_at;
    r.complete(first.id, new Date("2027-01-01T00:00:00.000Z"));
    assert.equal(r.forEmail("k@example.com")[0]!.completed_at, at, "the first completion stands");

    r.close();
    rmSync(dir, { recursive: true, force: true });
  });
});

/**
 * `researchOutcome` — the axis the uncited rate has to be read along.
 *
 * Written 2026-08-19 after `npm run outcome` was found reporting 85% uncited
 * from a filter that excluded nothing. The filter meant to keep only audits that
 * had been through Research and tested `source_type !== undefined`, but
 * `source_type` is written as `"none"` whenever a finding has no citation — so
 * every finding matched, including 106 from audits that predate the step.
 *
 * **A finding cannot answer this question**, which is the whole reason the
 * lookup lives here: `none` means "declined", "never ran" and "crashed" all at
 * once, and only the first says anything about the corpus.
 */
describe("whether an audit's findings ever had a chance at a citation", () => {
  const withCalls = (calls: { agent: string; ok: boolean }[]) => {
    const dir = mkdtempSync(path.join(tmpdir(), "ulab-research-"));
    const file = path.join(dir, "r.db");
    const log = new CallLog(file);
    for (const c of calls) {
      log.record({
        audit_id: "a1", agent: c.agent, model: "claude-sonnet-5",
        prompt_version: "researcher-v1", input_tokens: 1, output_tokens: 2,
        cache_read_tokens: 0, cache_write_tokens: 0, latency_ms: 3, cost_usd: 0.01,
        ok: c.ok, error: c.ok ? null : "Failed to parse structured output",
      });
    }
    log.close();
    const store = new AuditStore(file);
    const outcome = store.researchOutcome("a1");
    store.close();
    rmSync(dir, { recursive: true, force: true });
    return outcome;
  };

  test("an audit from before Research existed reports never, not a decline", () => {
    // The 106-finding case. These must leave the numerator AND the denominator.
    assert.equal(withCalls([{ agent: "heuristics", ok: true }]), "never");
  });

  test("a research step that ran and returned reports ok", () => {
    assert.equal(withCalls([{ agent: "researcher", ok: true }]), "ok");
  });

  test("a research step that crashed is failed, which is not the same as never", () => {
    /**
     * The duolingo case: the researcher died on `Unterminated string in JSON`
     * and eight findings published uncited. Folded into `never` it would look
     * like history; folded into `ok` it would look like the corpus is thin. It
     * is neither — it is a bug, and B23 exists because this told us so.
     */
    assert.equal(withCalls([{ agent: "researcher", ok: false }]), "failed");
  });

  test("a retry that succeeded is a research step that ran", () => {
    // The runner retries. One failed attempt followed by a good one is a
    // successful step, and counting it as failed would hide real declines.
    assert.equal(
      withCalls([
        { agent: "researcher", ok: false },
        { agent: "researcher", ok: true },
      ]),
      "ok",
    );
  });

  test("the lookup names one agent exactly, and does not match around it", () => {
    /**
     * The query is `agent = 'researcher'`, not `LIKE '%esearch%'` — and the
     * first version of this test could not tell the difference, because it used
     * `synthesizer` as the other agent and no loose pattern would have matched
     * that either. It passed under both, which is the failure this suite keeps
     * finding: **a test that supplies input the first guard rejects is testing
     * the first guard, not the one it names.**
     *
     * So the other agent is one a substring match *would* catch, and it appears
     * **alone** — the second version of this test paired it with a successful
     * `researcher` row, which made both queries answer "ok" and caught nothing
     * either. With no real research call present, equality says `never` and a
     * loose match says `ok`, which is the only arrangement that tells them
     * apart.
     *
     * There is no `co-researcher` today. The point is that the day someone adds
     * a second research-shaped step, a loose match would start counting its
     * calls as this one's and quietly move the citation rate.
     */
    assert.equal(withCalls([{ agent: "co-researcher", ok: true }]), "never");
  });
});
