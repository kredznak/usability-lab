import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { AuditStore, CallLog, IllegalTransition, type AuditStatus } from "./db.js";

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
