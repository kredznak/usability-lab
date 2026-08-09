import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SHARED_RULES, ALL_RUBRICS, RUBRICS, rubricFor } from "./rubrics.js";

describe("rubrics", () => {
  /**
   * Measured 2026-08-09 with messages.countTokens: 3525 chars = 1114 tokens on
   * Sonnet 5, i.e. 3.16 chars/token. The model's minimum cacheable prefix is
   * 1024 tokens, so the shared block needs ~3241 chars to cache at all. It
   * currently clears that by about 90 tokens.
   *
   * This is a cost test, not a style test. Below the minimum the cache_control
   * marker becomes a silent no-op: nothing errors, nothing warns, and every
   * sub-agent call starts paying full price for the same 1100-token prefix.
   * Trimming this prompt is allowed — you just have to notice you have done it.
   */
  const CACHE_MINIMUM_CHARS = 3300;

  test("the shared block is long enough to actually cache", () => {
    assert.ok(
      SHARED_RULES.length >= CACHE_MINIMUM_CHARS,
      `shared block is ${SHARED_RULES.length} chars, below the ~${CACHE_MINIMUM_CHARS} ` +
        `needed to reach Sonnet 5's 1024-token cache minimum. Caching would silently ` +
        `stop working for all six sub-agents. Re-measure with messages.countTokens ` +
        `before lowering this.`,
    );
  });

  test("all six agents in the roster exist and are distinct", () => {
    assert.equal(ALL_RUBRICS.length, 6, "design.md §2 specifies six sub-agents");
    assert.equal(new Set(ALL_RUBRICS.map((r) => r.id)).size, 6, "duplicate rubric id");
    assert.equal(
      new Set(ALL_RUBRICS.map((r) => r.prompt_version)).size,
      6,
      "two rubrics share a prompt_version, so model_calls cannot tell them apart",
    );
    assert.deepEqual(Object.keys(RUBRICS).sort(), ALL_RUBRICS.map((r) => r.id).sort());
  });

  test("every lane names itself and stays specific", () => {
    for (const r of ALL_RUBRICS) {
      assert.match(r.lane, /^## Your lane: /, `${r.id} lane does not open with its name`);
      assert.match(
        r.lane,
        /Leave to others:|you are also the safety net/,
        `${r.id} lane does not say what it leaves to other reviewers — §3 overlap discipline`,
      );
    }
  });

  test("rubricFor rejects an unknown agent instead of returning undefined", () => {
    assert.throws(() => rubricFor("nope"), /no rubric for agent/);
    assert.equal(rubricFor("a11y").id, "a11y");
  });
});
