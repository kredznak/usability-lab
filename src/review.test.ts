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
    // A cut now costs two lines, not one — the second is the reason B29 made
    // mandatory. Keeps are still a single keystroke.
    const answers = Array.from({ length: 17 }, (_, i) =>
      i % 5 === 0 ? ["c", "not worth acting on"] : ["k"],
    ).flat();
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
    review(fx, ["c", "duplicate", "c", "already fixed", "k", "k", "k", "k", "y"]);

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

    const { output } = review(fx, ["r", "c", "wrong on a second read", "k", "k", "k", "y"]);

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

/**
 * The gate could say "publish" and could not say "no".
 *
 * `2ae5a280` is an audit of myschools.nyc — a New York City public-school
 * enrolment service. It ran clean and Kelly declined it: we do not want a
 * critique of a public service published under our name. Before this there was
 * nowhere to put that decision. Leaving it REVIEW_PENDING recorded nothing and
 * left it in the queue forever; FAILED was the only terminal state reachable
 * and would have filed a working audit among the fifteen that genuinely broke.
 *
 * A flag rather than a prompt, because the decision is about the audit and not
 * about its findings. Walking eleven keep/cut questions to reach a publish
 * prompt you already intend to refuse is the same friction the resume path was
 * built to remove.
 */
describe("an audit the founder will not publish", () => {
  function decline(fx: Fixture, arg: string): { output: string; status: number } {
    try {
      const stdout = execFileSync(
        process.execPath,
        ["--import", "tsx", path.resolve("src/review.ts"), AUDIT_ID.slice(0, 8), arg],
        {
          input: "",
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

  function events(fx: Fixture, type: string) {
    const log = new EventLog(fx.dbPath);
    const rows = log.all(AUDIT_ID).filter((e) => e.type === type);
    log.close();
    return rows;
  }

  test("declining sets the status and records the reason in the founder's words", () => {
    const fx = seed(11);
    const { status } = decline(fx, '--decline=dont want to publish a gov website');

    assert.equal(status, 0);
    assert.equal(statusOf(fx), "DECLINED");

    const rows = events(fx, "review.declined");
    assert.equal(rows.length, 1, "one decision, one row");
    assert.equal(
      (rows[0]!.data as { reason: string }).reason,
      "dont want to publish a gov website",
      "recorded verbatim — a paraphrase would be my judgment wearing Kelly's label",
    );
  });

  test("declining does not walk the findings or invent decisions about them", () => {
    // The refusal is about the audit. Writing eleven keep/cut labels nobody
    // made would feed the corpus judgments that were never formed — the exact
    // contamination B29 already found four of.
    const fx = seed(11);
    decline(fx, "--decline=a public service, not a customer");

    assert.equal(reviewJson(fx), null, "no review.json");
    assert.equal(events(fx, "review.decided").length, 0, "no decisions recorded");
  });

  test("a decline with no reason declines nothing", () => {
    // B29: the reason field has been offered on every cut for the life of the
    // project and used zero times in 115 decisions. An optional reason here
    // would go the same way, and then DECLINED would mean no more than
    // REVIEW_PENDING did.
    const fx = seed(11);
    const { output, status } = decline(fx, "--decline=");

    assert.notEqual(status, 0, "it must refuse, not shrug");
    assert.equal(statusOf(fx), "REVIEW_PENDING", "nothing changed");
    assert.match(output, /reason/i, "and it says what was missing");
  });

  test("a declined audit cannot be reviewed back into existence", () => {
    const fx = seed(11);
    decline(fx, "--decline=a public service, not a customer");
    const { output, status } = review(fx, ["k", "y"]);

    assert.notEqual(status, 0);
    assert.match(output, /DECLINED/, "the refusal names the state it is refusing from");
    assert.equal(statusOf(fx), "DECLINED");
  });
});

/**
 * B29. The gate's own docstring called a cut reason "the only record of why",
 * and across the first 165 decisions that record held 7 lines — all of them
 * typed on one day, after the entry was written. Nothing was stopping a cut
 * from being unexplained, so most were.
 *
 * These pin the two informative actions to a reason, and pin the common one to
 * a single keystroke. A gate that asked about every keep would be a gate that
 * gets answered with whatever ends the prompt fastest.
 */
describe("a cut has to say why", () => {
  const decisionsOf = (fx: Fixture) => reviewJson(fx)!.decisions;

  test("a cut with no reason typed is asked, and the answer becomes the record", () => {
    const fx = seed(3);
    const { output } = review(fx, ["c", "the count is wrong: 50 tooltips, not 40", "k", "k", "y"]);

    assert.match(output, /Why cut\?/, "the question is actually put");
    const first = decisionsOf(fx)[0]!;
    assert.equal(first.keep, false);
    assert.equal(first.note, "the count is wrong: 50 tooltips, not 40");
    assert.equal(first.reason_declined, undefined, "answering is not declining");
  });

  test("a dash records that the question was asked and declined", () => {
    const fx = seed(3);
    review(fx, ["c", "-", "k", "k", "y"]);

    const first = decisionsOf(fx)[0]!;
    assert.equal(first.note, null);
    assert.equal(first.reason_declined, true);
    // The distinction the corpus could never make: every decision before this
    // change has a null note because nothing ever asked.
    assert.equal(decisionsOf(fx)[1]!.reason_declined, undefined);
  });

  test("silence is not an answer — an empty line asks again", () => {
    const fx = seed(3);
    const { output } = review(fx, ["c", "", "duplicate of finding 2", "k", "k", "y"]);

    assert.match(output, /A reason, or - to decline/, "it says what it wants");
    assert.equal(decisionsOf(fx)[0]!.note, "duplicate of finding 2");
    assert.equal(statusOf(fx), "PUBLISHED", "and the run survives the extra prompt");
  });

  test("a keep is never asked — the common path stays one keystroke", () => {
    const fx = seed(3);
    // Exactly three keeps and a publish. If a keep asked anything the queue
    // would run dry, the review would abort part-way and nothing would publish.
    review(fx, ["k", "k", "k", "y"]);

    assert.equal(statusOf(fx), "PUBLISHED");
    assert.equal(decisionsOf(fx).length, 3);
    for (const d of decisionsOf(fx)) {
      assert.equal(d.note, null);
      assert.equal(d.reason_declined, undefined);
    }
  });

  test("moving a severity is asked about too", () => {
    const fx = seed(3);
    review(fx, ["4", "white on blue measures 2.25:1, below the 3:1 floor", "k", "k", "y"]);

    const first = decisionsOf(fx)[0]!;
    assert.equal(first.keep, true, "a severity change is still a keep");
    assert.equal(first.severity_before, 2);
    assert.equal(first.severity_after, 4);
    assert.equal(first.note, "white on blue measures 2.25:1, below the 3:1 floor");
  });

  test("typing the severity a finding already has is not a change, and is not questioned", () => {
    const fx = seed(3);
    // Every fixture finding is severity 2. Answering "2" agrees with the
    // reviewers; there is nothing to explain, so nothing is asked — and the
    // queue proves it, because an extra prompt would eat the publish.
    review(fx, ["2", "k", "k", "y"]);

    const first = decisionsOf(fx)[0]!;
    assert.equal(first.severity_before, 2);
    assert.equal(first.severity_after, 2);
    assert.equal(first.note, null);
    assert.equal(statusOf(fx), "PUBLISHED");
  });

  test("every decision carries how long it took", () => {
    const fx = seed(3);
    review(fx, ["k", "k", "k", "y"]);

    for (const d of decisionsOf(fx)) {
      assert.equal(typeof d.ms, "number", "a decision with no duration cannot be told from a fast one");
      assert.ok(d.ms! >= 0, "and it is not negative");
    }
  });

  test("the event counts reasons and declines, without carrying the text", () => {
    const fx = seed(4);
    review(fx, ["c", "miscounted the CTAs", "c", "-", "k", "k", "y"]);

    const log = new EventLog(fx.dbPath);
    const row = log.all(AUDIT_ID).filter((e) => e.type === "review.decided").at(-1)!;
    log.close();

    const data = row.data as unknown as Record<string, number>;
    assert.equal(data.cut, 2);
    assert.equal(data.reasons, 1, "one written reason");
    assert.equal(data.declined, 1, "and one deliberate silence");
    assert.ok(!JSON.stringify(data).includes("miscounted"), "the funnel gets counts, not quotes");
  });
});

/**
 * B32. `checkClaim` has existed since the first false positives reached a
 * results page, and was imported by exactly one file — `corpus.ts`, an offline
 * builder. It had never run during an audit or at this gate.
 *
 * So the four numeric errors a founder has ever caught here were caught by
 * counting by hand, while the capture holding the answer sat on disk.
 */
describe("what the capture says, while the decision is being made", () => {
  /** Replaces the seeded fixture with one finding and the elements it counts. */
  function withCount(fx: Fixture, observation: string, labels: string[]) {
    writeFileSync(
      path.join(fx.dir, "findings.json"),
      JSON.stringify([{ ...finding(1), observation, element_ref: null }]),
    );
    writeFileSync(
      path.join(fx.dir, "capture.json"),
      JSON.stringify({
        ...CAPTURE,
        elements: labels.map((text, i) => ({
          ref: `el_${i}`,
          tag: "a",
          role: null,
          text,
          bbox: { x: 0, y: 0, width: 60, height: 20 },
          above_fold: true,
          input_type: null,
          accessible_name: null,
          name_source: null,
          font_size: 19,
        })),
        elements_total: labels.length,
      }),
    );
  }

  test("a miscount is put in front of the reviewer, in the capture's words", () => {
    const fx = seed(1);
    withCount(fx, 'The "Get started" button appears three times on the page.', [
      "Get started",
      "Get started",
    ]);

    const { output } = review(fx, ["k", "y"]);
    assert.match(output, /Checked against the capture/);
    assert.match(output, /says 3 of "Get started", but the capture holds 2/);
  });

  test("it is shown as data, and the finding can still be kept", () => {
    const fx = seed(1);
    withCount(fx, 'The "Get started" button appears three times on the page.', [
      "Get started",
      "Get started",
    ]);

    const { output } = review(fx, ["k", "y"]);
    // The wording matters as much as the number. A gate line that reads as a
    // verdict would make a keep feel like overruling the machine, and one of
    // these lines is a known false alarm — the closed-shadow-root counter in
    // B30, contradicted for quoting digits the capture could not read.
    assert.match(output, /not a verdict/);
    assert.equal(statusOf(fx), "PUBLISHED", "the reviewer is still the one deciding");
    assert.equal(reviewJson(fx)!.decisions[0]!.keep, true);
  });

  test("a finding the capture agrees with says nothing at all", () => {
    const fx = seed(1);
    withCount(fx, 'The "Get started" button appears two times on the page.', [
      "Get started",
      "Get started",
    ]);

    const { output } = review(fx, ["k", "y"]);
    assert.doesNotMatch(output, /Checked against the capture/, "silence when there is no news");
  });
});
