import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditStore, EventLog, type AuditStatus } from "./db.js";
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

/**
 * Thinking about it should be free.
 *
 * `review.json` survived "not yet" from the day the gate shipped, and nothing
 * could read it back — publishing meant answering every finding again. On five
 * findings that is a nuisance; on the fifteen-finding audits in the queue it
 * makes hesitation the expensive answer, at the one gate built for unhurried
 * judgment.
 *
 * The second cost was quieter. Each sitting recorded its own `review.decided`,
 * so one review that paused once left two rows saying it kept eleven findings.
 * `funnelStages()` counts distinct audit ids and reads that correctly — its own
 * comment describes finding the 200%-of-requested version of this bug — but
 * §8's founder-review reject rate sums these rows, and would have inherited a
 * doubled numerator from a founder who thought twice.
 */
describe("a review you already did", () => {
  function decidedRows(fx: Fixture) {
    const log = new EventLog(fx.dbPath);
    const rows = log.all(AUDIT_ID).filter((e) => e.type === "review.decided");
    log.close();
    return rows;
  }

  test("publishes from one keystroke, without asking again", () => {
    const fx = seed(5);
    review(fx, [...Array(5).fill("k"), "n"]);
    assert.equal(statusOf(fx), "REVIEW_PENDING", "the first sitting published nothing");

    const { output } = review(fx, ["p"]);

    assert.match(output, /already reviewed this/);
    assert.doesNotMatch(output, /\[1\/5\]/, "no finding is put to the reviewer a second time");
    assert.match(output, /PUBLISHED/);
    assert.equal(statusOf(fx), "PUBLISHED");
    assert.equal(reviewJson(fx)!.decisions.length, 5, "and the labels are the ones it saved");
  });

  test("one review is one review.decided, however many sittings it took", () => {
    const fx = seed(5);
    review(fx, [...Array(5).fill("k"), "n"]);
    review(fx, ["p"]);

    // Both halves, and the second one is why this test is worth having: with no
    // resume path the `p` is eaten as the answer to finding 1, the queue runs
    // dry, and the run aborts saving nothing. That leaves exactly one row too —
    // the right count for the wrong reason, and a test that proves nothing.
    assert.equal(statusOf(fx), "PUBLISHED", "the second sitting has to actually publish");
    assert.equal(decidedRows(fx).length, 1, "pausing must not double the reject-rate numerator");
  });

  test("redoing asks every question again, and is a second decision", () => {
    const fx = seed(4);
    review(fx, [...Array(4).fill("k"), "n"]);

    const { output } = review(fx, ["r", "c", "k", "k", "k", "y"]);

    assert.match(output, /\[4\/4\]/, "every finding is put again");
    assert.equal(reviewJson(fx)!.decisions.filter((d) => !d.keep).length, 1, "the new cut sticks");
    assert.equal(statusOf(fx), "PUBLISHED");
    // A redo is a genuinely different judgment, so it says so. Only republishing
    // what was already recorded stays silent.
    assert.equal(decidedRows(fx).length, 2);
  });

  test("quitting the offer changes nothing at all", () => {
    const fx = seed(3);
    review(fx, [...Array(3).fill("k"), "n"]);

    const { output } = review(fx, ["q"]);

    assert.match(output, /Nothing changed/);
    assert.equal(statusOf(fx), "REVIEW_PENDING");
    assert.equal(reviewJson(fx)!.decisions.length, 3, "the saved review is still there to publish");
    assert.equal(decidedRows(fx).length, 1);
  });

  test("labels about findings that no longer exist are refused, out loud", () => {
    const fx = seed(3);
    writeFileSync(
      path.join(fx.dir, "review.json"),
      JSON.stringify({
        audit_id: AUDIT_ID,
        reviewed_at: "2026-01-01T00:00:00.000Z",
        decisions: [
          { finding_id: "from-an-older-run", keep: true, severity_before: 2, severity_after: 2, note: null },
        ],
      }),
    );

    const { output } = review(fx, ["k", "k", "k", "y"]);

    assert.match(output, /does not describe these findings/);
    assert.match(output, /\[1\/3\]/, "so it asks, rather than publishing decisions about ghosts");
    assert.equal(statusOf(fx), "PUBLISHED");
    assert.equal(reviewJson(fx)!.decisions.length, 3);
  });
});
