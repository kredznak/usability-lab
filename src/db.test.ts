import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditStore, IllegalTransition, type AuditStatus } from "./db.js";

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
