import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SOURCES, sourceById, sourcesFor, resolveCitation } from "./sources.js";
import { applyResearch } from "./agents/researcher.js";
import { Finding } from "./types.js";
import { ALL_RUBRICS } from "./agents/rubrics.js";

/**
 * The citation path, attacked the way a drifting model would attack it.
 *
 * quality-bar.md calls a fabricated citation the worst single output this
 * product can produce — worse than no audit. The design answer is that the
 * model returns an id and code resolves the URL, so these tests exist to prove
 * there is no route from model output to a URL we did not put in the table.
 */

function finding(n: number, over: Partial<Finding> = {}): Finding {
  return Finding.parse({
    heuristic: `Heuristic ${n}`,
    severity: 2,
    element_ref: null,
    observation: `Observation ${n}`,
    impact_note: `Impact ${n}`,
    positive: false,
    id: `f${n}`,
    agent: "heuristics",
    screen_ref: "s",
    confidence: "high",
    citation: { source_type: "none", url: null },
    evidence: { screenshot_id: "s", bbox: null },
    ...over,
  });
}

describe("the source table is what it claims to be", () => {
  test("ids are unique — the whole lookup rests on it", () => {
    assert.equal(new Set(SOURCES.map((s) => s.id)).size, SOURCES.length);
  });

  test("every topic is a real rubric id", () => {
    const rubrics = new Set(ALL_RUBRICS.map((r) => r.id));
    for (const s of SOURCES) {
      for (const t of s.topics) {
        assert.ok(rubrics.has(t), `${s.id} claims topic "${t}", which is not a rubric`);
      }
    }
  });

  test("every rubric has at least one source it can cite", () => {
    // Not a style rule: a lens with no sources produces findings that can only
    // ever say "based on our evaluation", and we would not see why.
    for (const r of ALL_RUBRICS) {
      assert.ok(sourcesFor([r.id]).length > 0, `no source covers the ${r.id} rubric`);
    }
  });

  test("every source has an https URL and a non-empty claim", () => {
    for (const s of SOURCES) {
      assert.match(s.url, /^https:\/\//, `${s.id} url`);
      assert.ok(s.claim.length > 40, `${s.id} claim is too thin to check against`);
      assert.ok(s.publisher.length > 0, `${s.id} publisher`);
    }
  });

  test("sourcesFor narrows to the lens, and an unknown lens narrows to nothing", () => {
    const a11y = sourcesFor(["a11y"]);
    assert.ok(a11y.length > 0);
    assert.ok(a11y.every((s) => s.topics.includes("a11y")));
    assert.equal(sourcesFor(["astrology"]).length, 0);
  });
});

describe("resolveCitation: the only route to a URL", () => {
  test("a known id resolves to the table's URL", () => {
    const s = SOURCES[0]!;
    assert.deepEqual(resolveCitation(s.id), { source_type: s.source_type, url: s.url });
  });

  test("an unknown id is none, not a guess", () => {
    assert.deepEqual(resolveCitation("baymard-checkout-truth"), { source_type: "none", url: null });
  });

  test("null, undefined and empty string are all none", () => {
    for (const input of [null, undefined, ""]) {
      assert.deepEqual(resolveCitation(input), { source_type: "none", url: null });
    }
  });

  test("a URL passed where an id belongs resolves to none", () => {
    // The shape a fabrication would take if the schema ever loosened.
    assert.deepEqual(resolveCitation("https://baymard.com/blog/invented-study"), {
      source_type: "none",
      url: null,
    });
  });

  test("sourceById never invents a row", () => {
    assert.equal(sourceById("nope"), null);
  });
});

describe("applyResearch: what a drifting model cannot achieve", () => {
  const real = SOURCES[0]!;

  test("a real id attaches the table's URL, not anything the model said", () => {
    const { findings, cited } = applyResearch(
      [finding(1)],
      [{ finding_id: "f1", source_id: real.id, why: "it says so" }],
    );
    assert.equal(cited, 1);
    assert.equal(findings[0]!.citation.url, real.url);
  });

  test("a fabricated source id yields none, and the finding still ships", () => {
    const { findings, cited } = applyResearch(
      [finding(1)],
      [{ finding_id: "f1", source_id: "baymard-2027-checkout-study", why: "sounds right" }],
    );
    assert.equal(cited, 0);
    assert.deepEqual(findings[0]!.citation, { source_type: "none", url: null });
    assert.equal(findings[0]!.observation, "Observation 1", "the finding is untouched");
  });

  test("a source outside the shortlist it was shown is refused", () => {
    const shortlist = SOURCES.filter((s) => s.topics.includes("a11y"));
    const other = SOURCES.find((s) => !s.topics.includes("a11y"))!;
    const { findings } = applyResearch(
      [finding(1)],
      [{ finding_id: "f1", source_id: other.id, why: "adjacent enough" }],
      shortlist,
    );
    assert.equal(findings[0]!.citation.source_type, "none");
  });

  test("a citation for a finding nobody wrote is dropped", () => {
    const { findings, notes } = applyResearch(
      [finding(1)],
      [{ finding_id: "f99", source_id: real.id, why: "for a finding that does not exist" }],
    );
    assert.equal(findings[0]!.citation.source_type, "none");
    assert.equal(notes.length, 0);
  });

  test("a second citation for the same finding does not overwrite the first", () => {
    const second = SOURCES[1]!;
    const { findings } = applyResearch(
      [finding(1)],
      [
        { finding_id: "f1", source_id: real.id, why: "first" },
        { finding_id: "f1", source_id: second.id, why: "second" },
      ],
    );
    assert.equal(findings[0]!.citation.url, real.url);
  });

  test("findings with no citation come back in order, uncited, unedited", () => {
    const input = [finding(1), finding(2), finding(3)];
    const { findings, cited } = applyResearch(input, []);
    assert.equal(cited, 0);
    assert.deepEqual(
      findings.map((f) => f.id),
      ["f1", "f2", "f3"],
    );
    assert.ok(findings.every((f) => f.citation.source_type === "none"));
  });

  test("declining is recorded with its reason, so we can read why", () => {
    const { notes } = applyResearch(
      [finding(1)],
      [{ finding_id: "f1", source_id: null, why: "nothing here is about button colour" }],
    );
    assert.deepEqual(notes, [
      { finding_id: "f1", source_id: null, why: "nothing here is about button colour" },
    ]);
  });

  test("research never edits a finding — §2's hard limit", () => {
    const before = finding(1);
    const { findings } = applyResearch(
      [before],
      [{ finding_id: "f1", source_id: real.id, why: "supported" }],
    );
    const { citation: _a, ...restAfter } = findings[0]!;
    const { citation: _b, ...restBefore } = before;
    assert.deepEqual(restAfter, restBefore, "everything but the citation is identical");
  });
});

/**
 * Pins what the SDK actually does with a zod enum, because the whole defence
 * rests on knowing it.
 *
 * Measured 2026-08-13 on @anthropic-ai/sdk 0.116: `z.enum([...])` compiles to
 * `{"type":"string","description":"{enum: [...]}"}`. The allowed values are a
 * *description*. Nothing rejects an id we have never heard of, which is exactly
 * why `applyResearch` validates rather than trusts.
 *
 * If this test starts failing, that is good news — read the new shape and
 * decide what can be simplified. It failing silently would be the bad case, so
 * it is asserted rather than left as a comment.
 */
describe("what the SDK does with an enum, pinned", () => {
  test("a zod enum is a description, not a JSON Schema enum", async () => {
    const { z } = await import("zod");
    const { zodOutputFormat } = await import("@anthropic-ai/sdk/helpers/zod");

    const format = zodOutputFormat(
      z.object({ source_id: z.enum(["a-one", "b-two"]) }),
    ) as unknown as { schema: { properties: { source_id: Record<string, unknown> } } };
    const prop = format.schema.properties.source_id;

    assert.equal(prop.type, "string", "still a bare string");
    assert.equal(prop.enum, undefined, "no enum keyword — the model is not constrained");
    assert.match(String(prop.description), /a-one/, "the values survive only as prose");
  });

  test("every id the researcher can be shown resolves — the list and the table agree", () => {
    // The failure this guards: shortlisting from one place and resolving from
    // another, so the model is offered an id that resolves to nothing.
    for (const s of SOURCES) {
      assert.equal(resolveCitation(s.id).url, s.url, `${s.id} must resolve to itself`);
    }
  });
});
