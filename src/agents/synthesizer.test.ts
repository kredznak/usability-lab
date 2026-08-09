import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { applySynthesis, identify, type IdentifiedFinding } from "./synthesizer.js";
import type { RawFinding } from "../types.js";

/**
 * The Synthesizer's contract from design.md §2 is "cannot add findings", and
 * §9.1's is that it does not touch confidence. Neither is enforceable in a
 * prompt, so both are enforced in applySynthesis — and these tests attack it
 * with the specific shapes a drifting model produces, not with well-formed
 * input it was designed against.
 */

function raw(observation: string, over: Partial<RawFinding> = {}): RawFinding {
  return {
    heuristic: "Consistency and standards",
    severity: 2,
    element_ref: "el_1",
    observation,
    impact_note: "costs something",
    positive: false,
    ...over,
  };
}

const FINDINGS: IdentifiedFinding[] = identify([
  { agent: "heuristics", findings: [raw("h one"), raw("h two"), raw("h three")] },
  { agent: "forms", findings: [raw("f one"), raw("f two")] },
]);

const ids = FINDINGS.map((f) => f.id);

describe("synthesizer: provenance is enforced, not requested", () => {
  test("an invented id is rejected and cannot reach the audit", () => {
    const result = applySynthesis(FINDINGS, {
      groups: [
        { primary: "heuristics-1", duplicates: [], rank: 1 },
        { primary: "heuristics-99", duplicates: [], rank: 2 },
        { primary: "copy-1", duplicates: ["a11y-4"], rank: 3 },
      ],
      excluded: [],
    });

    for (const m of result.merged) {
      assert.ok(ids.includes(m.id), `published finding ${m.id} was never produced by a reviewer`);
    }
    assert.deepEqual(
      result.rejected.filter((r) => r.reason.includes("not produced")).map((r) => r.id).sort(),
      ["a11y-4", "copy-1", "heuristics-99"],
      "invented ids must be rejected individually and counted",
    );
  });

  test("every published finding keeps the reviewer's exact words", () => {
    const result = applySynthesis(FINDINGS, {
      groups: [{ primary: "forms-1", duplicates: ["heuristics-1"], rank: 1 }],
      excluded: [],
    });
    const published = result.merged.find((m) => m.id === "forms-1");
    assert.equal(published?.finding.observation, "f one");
    assert.deepEqual(published?.merged_from.sort(), ["forms", "heuristics"]);
  });

  test("nothing is silently lost when the synthesis ignores a finding", () => {
    const result = applySynthesis(FINDINGS, {
      groups: [{ primary: "heuristics-1", duplicates: [], rank: 1 }],
      excluded: [],
    });

    const accountedFor = new Set([
      ...result.merged.map((m) => m.id),
      ...result.merged.flatMap((m) => m.merged_from.map(() => "")),
      ...result.excluded.map((e) => e.id),
    ]);
    for (const f of FINDINGS) {
      assert.ok(
        accountedFor.has(f.id),
        `${f.id} vanished — silence from the Synthesizer must not delete a finding`,
      );
    }
    assert.equal(result.merged.length, FINDINGS.length);
    assert.equal(
      result.rejected.filter((r) => r.reason.includes("not mentioned")).length,
      4,
      "unmentioned findings are kept but the omission is recorded",
    );
  });
});

describe("synthesizer: contradictory output resolves safely", () => {
  test("the same id kept twice is kept once", () => {
    const result = applySynthesis(FINDINGS, {
      groups: [
        { primary: "heuristics-1", duplicates: [], rank: 1 },
        { primary: "heuristics-1", duplicates: [], rank: 2 },
      ],
      excluded: [],
    });
    assert.equal(result.merged.filter((m) => m.id === "heuristics-1").length, 1);
    assert.ok(result.rejected.some((r) => r.reason.includes("already kept")));
  });

  test("an id used as a duplicate in two groups is only merged once", () => {
    const result = applySynthesis(FINDINGS, {
      groups: [
        { primary: "heuristics-1", duplicates: ["forms-1"], rank: 1 },
        { primary: "heuristics-2", duplicates: ["forms-1"], rank: 2 },
      ],
      excluded: [],
    });
    const second = result.merged.find((m) => m.id === "heuristics-2");
    assert.deepEqual(second?.merged_from, ["heuristics"], "forms-1 was already claimed");
    assert.ok(result.rejected.some((r) => r.id === "forms-1"));
  });

  test("kept and excluded at once resolves to kept", () => {
    const result = applySynthesis(FINDINGS, {
      groups: [{ primary: "heuristics-1", duplicates: [], rank: 1 }],
      excluded: [{ id: "heuristics-1", reason: "vague" }],
    });
    assert.ok(result.merged.some((m) => m.id === "heuristics-1"));
    assert.ok(!result.excluded.some((e) => e.id === "heuristics-1"));
    assert.ok(result.rejected.some((r) => r.reason.includes("both kept and excluded")));
  });

  test("off-scale and duplicate ranks still produce a total order", () => {
    const result = applySynthesis(FINDINGS, {
      groups: [
        { primary: "forms-2", duplicates: [], rank: -3 },
        { primary: "heuristics-1", duplicates: [], rank: 0 },
        { primary: "heuristics-2", duplicates: [], rank: 0 },
        { primary: "forms-1", duplicates: [], rank: 999 },
      ],
      excluded: [],
    });
    // rank is model-supplied and unconstrained; it may only affect order, never
    // whether a finding survives.
    assert.equal(result.merged.length, FINDINGS.length);
    assert.deepEqual(
      result.merged.map((m) => m.id).slice(0, 3),
      ["forms-2", "heuristics-1", "heuristics-2"],
      "ties break deterministically by id",
    );
  });

  test("a synthesis that excludes everything still excludes nothing it cannot name", () => {
    const result = applySynthesis(FINDINGS, {
      groups: [],
      excluded: ids.map((id) => ({ id, reason: "not useful" })).concat({ id: "ghost-1", reason: "x" }),
    });
    assert.equal(result.excluded.length, FINDINGS.length);
    assert.equal(result.merged.length, 0);
    assert.ok(result.rejected.some((r) => r.id === "ghost-1"));
  });
});
