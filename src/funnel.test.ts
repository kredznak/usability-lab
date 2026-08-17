import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { EventLog } from "./db.js";
import { percentile, stepStats } from "./funnel.js";

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
