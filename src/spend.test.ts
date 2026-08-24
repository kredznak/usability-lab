import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DEFAULT_DAILY_CEILING_USD, ceilingFromEnv, spendLine, utcDay, verdict, perAuditCeilingFromEnv, DEFAULT_PER_AUDIT_CEILING_USD } from "./spend.js";

/**
 * F11's arithmetic, driven by numbers rather than by history.
 *
 * The real log cannot exercise this: the worst day this project has ever had
 * was $8.04 against a $25 ceiling, so every row in `model_calls` says "keep
 * going". A guard whose only evidence is that it has never fired is not
 * evidenced at all.
 */
describe("the daily ceiling decides before an audit, not during one", () => {
  const C = 25;

  test("an ordinary day keeps going and says nothing alarming", () => {
    const v = verdict(8.04, C); // the real worst day, 2026-08-17
    assert.equal(v.stop, false);
    assert.equal(v.warn, false);
  });

  test("80% warns and still runs", () => {
    // §11: "At 80%: alert + new audits queue". The alert is not the stop.
    const v = verdict(20, C);
    assert.equal(v.warn, true);
    assert.equal(v.stop, false);
  });

  test("exactly at the ceiling stops", () => {
    // The boundary is the whole point of the guard, so it is asserted rather
    // than left to whichever way `>` happened to be written.
    assert.equal(verdict(25, C).stop, true);
    assert.equal(verdict(24.99, C).stop, false);
  });

  test("over the ceiling stops, and a big overshoot is not a wraparound", () => {
    assert.equal(verdict(400, C).stop, true);
  });

  test("a day that spent nothing is not treated as a day that spent everything", () => {
    const v = verdict(0, C);
    assert.equal(v.stop, false);
    assert.equal(v.warn, false);
  });
});

describe("the ceiling can be lowered, and cannot be removed by a typo", () => {
  test("an operator's number wins", () => {
    assert.equal(ceilingFromEnv({ USABILITY_LAB_DAILY_CEILING_USD: "5" }), 5);
  });

  test("unset means the design's figure", () => {
    assert.equal(ceilingFromEnv({}), DEFAULT_DAILY_CEILING_USD);
  });

  test("nonsense falls back rather than disabling the guard", () => {
    // The failure that matters: `USABILITY_LAB_DAILY_CEILING_USD=` in a .env
    // file parsing to NaN, `NaN >= NaN` being false, and the ceiling quietly
    // never firing again. A guard that a typo can remove is not a guard.
    for (const raw of ["", "  ", "twenty", "NaN", "0", "-5", "Infinity"]) {
      const c = ceilingFromEnv({ USABILITY_LAB_DAILY_CEILING_USD: raw });
      assert.ok(Number.isFinite(c) && c > 0, `${JSON.stringify(raw)} gave ${c}`);
      assert.equal(verdict(1e6, c).stop, true, `${JSON.stringify(raw)} never stops`);
    }
  });
});

describe("the day boundary is UTC, because the timestamps are", () => {
  test("a UTC date, not a local one", () => {
    // 23:30 UTC on the 21st is already the 22nd in Sydney and still the 21st in
    // New York. `created_at` is UTC, so the counter must be too, or the ceiling
    // resets at an hour that depends on where the operator is sitting.
    assert.equal(utcDay(new Date("2026-08-21T23:30:00.000Z")), "2026-08-21");
    assert.equal(utcDay(new Date("2026-08-22T00:30:00.000Z")), "2026-08-22");
  });
});

describe("the message says what happened to the queue", () => {
  test("stopping explains that nothing was lost", () => {
    const line = spendLine(verdict(25, 25));
    // The fear on seeing a queue runner stop early is that the requests were
    // dropped. They were not, and the line has to say so.
    assert.match(line, /keep their place/);
    assert.match(line, /\$25\.00/);
  });

  test("running says the number without the alarm", () => {
    const line = spendLine(verdict(3, 25));
    assert.match(line, /\$3\.00 of \$25\.00/);
    assert.doesNotMatch(line, /ceiling\./);
  });
});

/**
 * §11's per-audit ceiling, unenforced from the day it was written until
 * 2026-08-24. It was survivable while a person typed the command that spent the
 * money; the worker removed that person, and the daily ceiling alone would let
 * one pathological page spend a whole day's budget by itself.
 */
describe("the ceiling on a single audit", () => {
  test("defaults to §11's figure", () => {
    assert.equal(perAuditCeilingFromEnv({}), 3);
    assert.equal(DEFAULT_PER_AUDIT_CEILING_USD, 3);
  });

  test("an operator can lower it", () => {
    assert.equal(perAuditCeilingFromEnv({ USABILITY_LAB_AUDIT_CEILING_USD: "1.5" }), 1.5);
  });

  test("a typo falls back rather than spending nothing or everything", () => {
    // Same rule as the daily ceiling: an unreadable value is an operator's
    // mistake, and switching to "spend nothing, ever" would look like a hang.
    for (const raw of ["", "   ", "abc", "0", "-4"]) {
      assert.equal(perAuditCeilingFromEnv({ USABILITY_LAB_AUDIT_CEILING_USD: raw }), 3, raw);
    }
  });

  test("it is well above anything this project has ever spent on one audit", () => {
    // Worst observed is $1.16 across every audit run. A ceiling below that
    // would degrade ordinary work; this one is a backstop, not a budget.
    assert.ok(DEFAULT_PER_AUDIT_CEILING_USD > 1.16 * 2);
  });
});
