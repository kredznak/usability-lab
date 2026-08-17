import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditStore } from "./db.js";
import type { Corpus } from "./corpus.js";

/**
 * Which audits the corpus is allowed to score.
 *
 * On 2026-08-16 four audits were retired to FAILED — one timeout and three
 * Cotopaxi runs superseded because the capture underneath them was wrong. The
 * database was clean and `npm run corpus` went on scoring all of them: 38
 * findings, including the four built on the off-canvas capture, all reading
 * **0 false**. `claims.ts` cannot see a visibility problem, so a broken audit
 * scores as a clean one and quietly raises precision. Removing them moved
 * precision 94.1% -> 93.2%, which is the honest number.
 *
 * The rule is narrow and easy to get backwards: skip what the state machine
 * explicitly calls FAILED, and *nothing else*. Our six oldest audits predate
 * the `audits` table and have no row at all. Treating unknown as failed would
 * silently delete the most valuable rows in the corpus — the ones holding
 * known-false findings with known root causes.
 *
 * Run as a subprocess because the path constants are read at import.
 */

interface Fixture {
  root: string;
  outRoot: string;
  corpusRoot: string;
  dbPath: string;
}

function capture(url: string) {
  return {
    audit_id: "x",
    url,
    final_url: url,
    title: "T",
    screenshot_id: "s",
    screenshot_path: "s.png",
    viewport: { width: 1440, height: 900 },
    full_height: 900,
    elements: [
      {
        ref: "el_1",
        tag: "button",
        role: null,
        text: "Continue",
        bbox: { x: 10, y: 10, width: 100, height: 40 },
        above_fold: true,
        input_type: null,
        accessible_name: "Continue",
        name_source: "label",
        font_size: 16,
      },
    ],
    elements_total: 1,
    text_excerpt: "Continue",
    text_total_chars: 8,
    captured_at: "2026-01-01T00:00:00.000Z",
  };
}

function finding(id: string) {
  return {
    id,
    agent: "heuristics",
    heuristic: "Visibility of system status",
    severity: 2,
    element_ref: "el_1",
    observation: "The button reads Continue and gives no hint of what follows.",
    impact_note: "A visitor cannot anticipate the next step.",
    positive: false,
    screen_ref: "s",
    confidence: "high",
    citation: { source_type: "none", url: null },
    evidence: { screenshot_id: "s", bbox: null },
  };
}

/** An audit on disk, optionally with a row in the database. */
function seedAudit(
  fx: Fixture,
  id: string,
  url: string,
  status: string | null,
  baseline: string | null = null,
) {
  const dir = path.join(fx.outRoot, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "capture.json"), JSON.stringify(capture(url)));
  writeFileSync(path.join(dir, "findings.json"), JSON.stringify([finding(`${id}-f1`)]));
  if (status === null) return; // predates the audits table

  const store = new AuditStore(fx.dbPath);
  store.create(id, url, baseline);
  store.transition(id, "CAPTURING");
  store.transition(id, "AUDITING");
  if (status === "FAILED") {
    store.transition(id, "FAILED");
  } else {
    store.transition(id, "ASSEMBLING");
    store.transition(id, "REVIEW_PENDING", { findings_total: 1 });
  }
  store.close();
}

function build(fx: Fixture): Corpus {
  execFileSync(process.execPath, ["--import", "tsx", path.resolve("src/corpus-build.ts")], {
    encoding: "utf8",
    env: {
      ...process.env,
      USABILITY_LAB_DB: fx.dbPath,
      USABILITY_LAB_OUT: fx.outRoot,
      USABILITY_LAB_CORPUS: fx.corpusRoot,
    },
  });
  return JSON.parse(
    readFileSync(path.join(fx.corpusRoot, "findings.json"), "utf8"),
  ) as Corpus;
}

function fixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "ulab-corpus-"));
  const fx = {
    root,
    outRoot: path.join(root, "out"),
    corpusRoot: path.join(root, "labelled"),
    dbPath: path.join(root, "lab.db"),
  };
  mkdirSync(fx.outRoot, { recursive: true });
  mkdirSync(fx.corpusRoot, { recursive: true });
  return fx;
}

describe("a retired audit is not scored", () => {
  test("FAILED is skipped, and skipped loudly rather than dropped", () => {
    const fx = fixture();
    try {
      seedAudit(fx, "aaaaaaaa-0000-4000-8000-000000000001", "https://kept.example", "REVIEW_PENDING");
      seedAudit(fx, "bbbbbbbb-0000-4000-8000-000000000002", "https://dead.example", "FAILED");

      const corpus = build(fx);
      const scored = corpus.built_from.map((a) => a.url);

      assert.deepEqual(scored, ["https://kept.example"], "the FAILED audit was scored");
      assert.equal(corpus.findings.length, 1);
      assert.equal(
        corpus.skipped.filter((s) => /FAILED/.test(s.reason)).length,
        1,
        "a skipped audit must say so — a corpus that silently ignores evidence reads cleaner than it is",
      );
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("an audit the database has never heard of is still scored", () => {
    // The six oldest audits have no row. Treating unknown as failed would
    // delete the known-false findings the harness exists to rediscover.
    const fx = fixture();
    try {
      seedAudit(fx, "cccccccc-0000-4000-8000-000000000003", "https://ancient.example", null);

      const corpus = build(fx);
      assert.deepEqual(
        corpus.built_from.map((a) => a.url),
        ["https://ancient.example"],
        "an audit with no database row was dropped; unknown is not failed",
      );
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("no database at all still builds — the corpus predates the audits table", () => {
    const fx = fixture();
    try {
      seedAudit(fx, "dddddddd-0000-4000-8000-000000000004", "https://nodb.example", null);
      const corpus = build(fx);
      assert.equal(corpus.built_from.length, 1);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

/**
 * Re-audits are monitoring artifacts, not eval data — Kelly's call, 2026-08-17.
 *
 * A re-audit exists because a customer is watching a page, not because that
 * page is a good test of the pipeline. Counting them drifts every metric
 * toward whichever site gets monitored most: basecamp was 3 of 9 published
 * audits and 40% of all published findings before this rule existed.
 */
describe("a re-audit is monitoring, not eval data", () => {
  test("it is skipped, and the skip names the audit it followed", () => {
    const fx = fixture();
    try {
      seedAudit(fx, "first", "https://example.com", "REVIEW_PENDING");
      seedAudit(fx, "again", "https://example.com", "REVIEW_PENDING", "first");
      const corpus = build(fx);

      assert.deepEqual(corpus.built_from.map((b) => b.audit_id).sort(), ["first"]);
      const skip = corpus.skipped.find((s) => s.audit_id === "again");
      assert.match(skip!.reason, /re-audit of first/);
      assert.match(skip!.reason, /monitoring, not eval data/);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("its findings do not reach the metrics", () => {
    // The number that matters. A skip that still contributed findings would
    // look like a policy while changing nothing.
    const fx = fixture();
    try {
      seedAudit(fx, "first", "https://example.com", "REVIEW_PENDING");
      seedAudit(fx, "again", "https://example.com", "REVIEW_PENDING", "first");
      const corpus = build(fx);
      assert.equal(corpus.findings.length, 1);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("a first audit of the same page is untouched", () => {
    // The rule is about provenance, not about duplicate URLs. Two independent
    // first audits of one page are both legitimate eval data.
    const fx = fixture();
    try {
      seedAudit(fx, "one", "https://example.com", "REVIEW_PENDING");
      seedAudit(fx, "two", "https://example.com", "REVIEW_PENDING");
      const corpus = build(fx);
      assert.equal(corpus.built_from.length, 2);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});
