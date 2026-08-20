import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { EventLog } from "./db.js";
import { countsByType, funnelStages, percentile, stepStats } from "./funnel.js";

/**
 * §0's last unbuilt clause: "every step's events visible in the funnel
 * dashboard". The tests that matter are about not lying — a step that failed
 * must still appear, and a percentile at small n must be a real measurement.
 */

function tempLog(): { log: EventLog; dir: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "ulab-events-"));
  return { log: new EventLog(path.join(dir, "events.db")), dir };
}

describe("the event log is append-only and never breaks a run", () => {
  test("events come back in the order they happened", () => {
    const { log, dir } = tempLog();
    for (const type of ["audit.requested", "step.capture", "audit.completed"]) {
      log.record({ audit_id: "a1", type, data: {} });
    }
    const types = log.all("a1").map((e) => e.type);
    log.close();
    rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(types, ["audit.requested", "step.capture", "audit.completed"]);
  });

  test("a broken log never takes the audit down with it", () => {
    // A $0.65 run lost to a telemetry bug would be the worst possible trade.
    const { log, dir } = tempLog();
    const db = new Database(path.join(dir, "events.db"));
    db.exec("DROP TABLE events");
    db.close();
    assert.doesNotThrow(() => log.record({ audit_id: "a1", type: "step.capture", data: {} }));
    log.close();
    rmSync(dir, { recursive: true, force: true });
  });

  test("events for one audit do not leak into another", () => {
    const { log, dir } = tempLog();
    log.record({ audit_id: "a1", type: "step.capture", data: {} });
    log.record({ audit_id: "a2", type: "step.capture", data: {} });
    const n = log.all("a1").length;
    log.close();
    rmSync(dir, { recursive: true, force: true });
    assert.equal(n, 1);
  });
});

describe("step durations describe the runs that happened", () => {
  const events = [
    { type: "step.synthesize", data: { ms: 8_226, ok: true } },
    { type: "step.synthesize", data: { ms: 40_489, ok: true } },
    { type: "step.synthesize", data: { ms: 1_618_602, ok: true } },
    { type: "step.capture", data: { ms: 3_100, ok: true } },
    { type: "audit.completed", data: { findings: 12 } },
  ];

  test("a step that hung is visible rather than averaged away", () => {
    // The real numbers from 2026-08-17. The mean of those three synthesizer
    // runs is ~9 minutes, which describes none of them — and B14 was found by
    // a person reading a log line, not by a dashboard.
    const [slowest] = stepStats(events);
    assert.equal(slowest!.step, "synthesize");
    assert.equal(slowest!.max, 1_618_602);
    assert.ok(slowest!.p50 < 60_000, "the median stays honest about the healthy runs");
  });

  test("steps are ordered worst-first, so the problem is the first thing read", () => {
    assert.deepEqual(stepStats(events).map((s) => s.step), ["synthesize", "capture"]);
  });

  test("non-step events are not counted as steps", () => {
    assert.equal(stepStats(events).some((s) => s.step === "completed"), false);
  });

  test("a failed step still appears, and is counted as a failure", () => {
    // The steps most worth seeing are the ones that went wrong; a dashboard
    // built only from successes would have shown nothing on the day research
    // died mid-string.
    const stats = stepStats([
      { type: "step.research", data: { ms: 95_100, ok: false, error: "unterminated string" } },
    ]);
    assert.equal(stats[0]!.n, 1);
    assert.equal(stats[0]!.failures, 1);
  });
});

describe("percentiles at the sample sizes we actually have", () => {
  test("p95 of three runs is the slowest of them, not an invented number", () => {
    // Nearest-rank. Interpolating would report a duration no run ever took,
    // and every number on this page should be a run we can go and look at.
    assert.equal(percentile([100, 200, 1_618_602], 95), 1_618_602);
  });

  test("p50 of an even count does not average two runs together", () => {
    assert.equal(percentile([10, 20, 30, 40], 50), 20);
  });

  test("no runs is zero, not a crash", () => {
    assert.equal(percentile([], 95), 0);
  });
});

/**
 * The funnel counts audits, not actions.
 *
 * It shipped reading `reviewed at the gate 4 — 200% of requested`: two true
 * numbers over each other. `review.decided` fires once per sitting, and both
 * audits were gated twice — once answering "not yet", once publishing. A
 * percentage over 100 on the dashboard built to catch wrong numbers is the
 * same class of error this project spent a week finding in findings.
 */
describe("funnel stages count audits that got somewhere", () => {
  const requested = (id: string) => ({ type: "audit.requested", audit_id: id });
  const reviewed = (id: string) => ({ type: "review.decided", audit_id: id });
  const published = (id: string) => ({ type: "audit.published", audit_id: id });

  test("two sittings on one audit are one audit reviewed", () => {
    const { stages } = funnelStages([requested("a"), reviewed("a"), reviewed("a")]);
    const gate = stages.find((s) => s.label === "reviewed at the gate")!;
    assert.equal(gate.n, 1);
    assert.equal(gate.pct, 100);
  });

  test("no stage can exceed the audits that started", () => {
    // The property that failed. Whatever the events say, a funnel that reports
    // more arrivals than departures is describing two populations at once.
    const { stages } = funnelStages([
      requested("a"),
      reviewed("a"), reviewed("a"), reviewed("b"), reviewed("c"),
      published("a"), published("b"),
    ]);
    for (const s of stages) assert.ok((s.pct ?? 0) <= 100, `${s.label} reported ${s.pct}%`);
  });

  test("audits that predate the log are disclosed, not counted or hidden", () => {
    // Events are not backfilled, so an audit started last week can be reviewed
    // today and arrive at a later stage without ever entering the first.
    // Counting it breaks the percentage; dropping it silently hides real work.
    const { stages, outside } = funnelStages([requested("new"), reviewed("new"), reviewed("old")]);
    assert.equal(outside, 1);
    assert.equal(stages.find((s) => s.label === "reviewed at the gate")!.n, 1);
  });

  test("the first stage has no percentage of itself", () => {
    const { stages } = funnelStages([requested("a")]);
    assert.equal(stages[0]!.pct, null);
  });

  test("an empty log is zero stages, not a division by zero", () => {
    const { stages } = funnelStages([]);
    assert.equal(stages[0]!.n, 0);
    for (const s of stages.slice(1)) assert.equal(s.pct, null);
  });
});

/**
 * The two rows above the audit funnel, and why they had to be split.
 *
 * `funnel.ts` prints `question.started` as **"form opened"**, which was true for
 * as long as `/` was the form. On 2026-08-20 `/` became a marketing page and the
 * questions moved to `/start`. Had the event stayed on `/`, that row would have
 * counted homepage views under a label saying otherwise, and the ratio between
 * it and "questions answered" — the form's completion rate, the one number this
 * block exists to show — would silently have become a whole-site conversion
 * rate. Printed to the same precision as before, and wrong.
 *
 * That is the shape of the 85%-uncited bug: an honest-looking figure computed
 * over a population that changed underneath it.
 *
 * So `/start` kept the name, because it kept the meaning, and `/` got a new one.
 * Keeping the name is what lets rows recorded before the redesign stay
 * comparable to rows recorded after it.
 */
describe("a homepage view and a form open are counted apart", () => {
  test("each event lands under its own label", () => {
    const counts = countsByType([
      { type: "home.viewed" },
      { type: "home.viewed" },
      { type: "home.viewed" },
      { type: "question.started" },
      { type: "question.completed" },
    ]);
    assert.equal(counts.get("home.viewed"), 3, "three people saw the homepage");
    assert.equal(counts.get("question.started"), 1, "one of them opened the form");
    assert.equal(counts.get("question.completed"), 1);
  });

  test("a homepage view does not count as a form open", () => {
    // The regression this whole split exists to prevent. If somebody later
    // records `question.started` on `/` again for convenience, the count moves
    // and this fails.
    const counts = countsByType([{ type: "home.viewed" }, { type: "home.viewed" }]);
    assert.equal(counts.get("question.started"), undefined);
  });

  test("a type nobody recorded is absent, not zero", () => {
    // The distinction the `subscribed NOT BUILT` line already depends on: a zero
    // means people arrived and did not convert, which is a claim about a stage
    // that may not exist.
    assert.equal(countsByType([]).get("home.viewed"), undefined);
  });
});
