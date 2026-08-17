import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditStore, type AuditStatus } from "./db.js";
import type { ReviewRecord } from "./types.js";

/**
 * The publish path, end to end — docs/backlog.md B4.
 *
 * `review.ts` decides what a paying visitor sees, and until this file existed it
 * was the only untested code in the repo. Its first real run silently discarded
 * sixteen of seventeen answers, because readline hands a non-TTY stream every
 * buffered line at once. No unit test of the pieces could have caught that: the
 * bug lived in the seam between the script and its input.
 *
 * So this drives the real script as a subprocess with real piped answers and
 * asserts on the files and the status it leaves behind. `USABILITY_LAB_DB` and
 * `USABILITY_LAB_OUT` (src/paths.ts) exist for exactly this.
 */

const AUDIT_ID = "aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa";
const roots: string[] = [];

after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

function finding(n: number) {
  return {
    id: `f${n}`,
    heuristic: `Heuristic ${n}`,
    severity: 2,
    element_ref: null,
    observation: `Observation ${n}`,
    impact_note: `Impact ${n}`,
    positive: false,
    agent: "heuristics",
    screen_ref: "s",
    confidence: "high",
    citation: { source_type: "none", url: null },
    evidence: { screenshot_id: "s", bbox: { x: 1, y: 1, width: 9, height: 9 } },
  };
}

const CAPTURE = {
  audit_id: AUDIT_ID,
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

interface Fixture {
  outRoot: string;
  dbPath: string;
  dir: string;
}

/**
 * An audit sitting where a finished run leaves one. A fresh root per test, so
 * no test can see another's rows and nothing needs deleting mid-suite.
 *
 * Status is reached by walking the real state machine rather than by writing
 * the column, so a fixture cannot reach a state the pipeline could not.
 */
function seed(count: number, status: AuditStatus = "REVIEW_PENDING"): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "ulab-review-"));
  roots.push(root);
  const outRoot = path.join(root, "out");
  const dbPath = path.join(root, "db", "usability-lab.db");
  const dir = path.join(outRoot, AUDIT_ID);

  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "capture.json"), JSON.stringify(CAPTURE));
  writeFileSync(
    path.join(dir, "findings.json"),
    JSON.stringify(Array.from({ length: count }, (_, i) => finding(i + 1))),
  );

  const store = new AuditStore(dbPath);
  store.create(AUDIT_ID, "https://example.com");
  store.transition(AUDIT_ID, "CAPTURING");
  store.transition(AUDIT_ID, "AUDITING");
  store.transition(AUDIT_ID, "ASSEMBLING");
  store.transition(AUDIT_ID, "REVIEW_PENDING", {
    findings_total: count,
    profile_summary: "A shop that sells things.",
  });
  if (status === "PUBLISHED") store.transition(AUDIT_ID, "PUBLISHED");
  store.close();

  return { outRoot, dbPath, dir };
}

/** Runs the gate with answers piped in, the way a person's keystrokes arrive. */
function review(fx: Fixture, answers: string[]): { output: string; status: number } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["--import", "tsx", path.resolve("src/review.ts"), AUDIT_ID.slice(0, 8)],
      {
        input: answers.join("\n") + "\n",
        encoding: "utf8",
        env: { ...process.env, USABILITY_LAB_DB: fx.dbPath, USABILITY_LAB_OUT: fx.outRoot },
      },
    );
    return { output: stdout, status: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; status?: number };
    return { output: (e.stdout ?? "") + (e.stderr ?? ""), status: e.status ?? 1 };
  }
}

function statusOf(fx: Fixture): string {
  const store = new AuditStore(fx.dbPath);
  const row = store.get(AUDIT_ID);
  store.close();
  return row?.status ?? "MISSING";
}

function reviewJson(fx: Fixture): ReviewRecord | null {
  const file = path.join(fx.dir, "review.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")) as ReviewRecord) : null;
}

describe("the founder gate, end to end", () => {
  test("every piped answer is recorded — the bug that shipped", () => {
    const fx = seed(17);
    const answers = Array.from({ length: 17 }, (_, i) => (i % 5 === 0 ? "c" : "k"));
    const { output } = review(fx, [...answers, "y"]);

    const record = reviewJson(fx);
    assert.ok(record, "review.json must exist");
    assert.equal(record.decisions.length, 17, "all 17 recorded, not just the first");
    assert.equal(record.decisions.filter((d) => !d.keep).length, 4, "the four cuts are cuts");
    assert.match(output, /PUBLISHED/);
    assert.equal(statusOf(fx), "PUBLISHED");
  });

  test("publishing writes the visitor's page and counts what it withheld", () => {
    const fx = seed(7);
    review(fx, [...Array(7).fill("k"), "y"]);

    const html = readFileSync(path.join(fx.dir, "results.html"), "utf8");
    assert.match(html, /4 more findings/);
    assert.match(html, /found 7 issues on this page/);
    assert.doesNotMatch(html, /Observation 5</, "the fourth-ranked finding stays behind the gate");
  });

  test("the cards carry the pin numbers of the screenshot they point at", () => {
    // Findings 1 and 2 cut, so the free three are ranks 3, 4, 5 — which were
    // drawn on the image as pins 3, 4 and 5, and must not be renumbered 1-3.
    const fx = seed(6);
    review(fx, ["c", "c", "k", "k", "k", "k", "y"]);

    const html = readFileSync(path.join(fx.dir, "results.html"), "utf8");
    for (const pin of [3, 4, 5]) {
      assert.match(html, new RegExp(`class="sev sev-2">${pin}<`), `pin ${pin} on the card`);
    }
    assert.doesNotMatch(html, /class="sev sev-2">1</, "renumbering would point at the wrong box");
  });

  test("declining to publish keeps the labels and leaves the audit alone", () => {
    const fx = seed(5);
    const { output } = review(fx, [...Array(5).fill("k"), "n"]);

    // The whole reason the gate was built before Research: these are the
    // usefulness labels. Losing them on "not yet" threw away the judgment.
    const record = reviewJson(fx);
    assert.ok(record, "decisions survive a decision not to publish");
    assert.equal(record.decisions.length, 5);
    assert.equal(statusOf(fx), "REVIEW_PENDING");
    assert.match(output, /Not published/);
    assert.ok(!existsSync(path.join(fx.dir, "results.html")), "and nothing is published");
  });

  test("quitting part-way publishes nothing and saves nothing", () => {
    const fx = seed(6);
    const { output } = review(fx, ["k", "k", "q"]);

    assert.equal(reviewJson(fx), null, "a partial review is not a label set");
    assert.equal(statusOf(fx), "REVIEW_PENDING");
    assert.match(output, /Stopped after 2 of 6/);
  });

  test("severity can be corrected at the gate, and the page shows the correction", () => {
    const fx = seed(4);
    review(fx, ["4 the reviewers undersold this", "k", "k", "k", "y"]);

    const first = reviewJson(fx)!.decisions[0]!;
    assert.equal(first.severity_before, 2);
    assert.equal(first.severity_after, 4);
    assert.equal(first.note, "the reviewers undersold this");
    assert.match(readFileSync(path.join(fx.dir, "results.html"), "utf8"), /severity 4/);
  });

  test("an already-published audit refuses a second review", () => {
    const fx = seed(3, "PUBLISHED");
    const { output, status } = review(fx, ["k", "k", "k", "y"]);

    assert.notEqual(status, 0, "refusing must be a failure exit, not a quiet no-op");
    assert.match(output, /already been published/);
    assert.equal(reviewJson(fx), null);
  });
});
