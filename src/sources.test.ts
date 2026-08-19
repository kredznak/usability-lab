import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { SOURCES, sourceById, sourcesFor, resolveCitation } from "./sources.js";
import Anthropic from "@anthropic-ai/sdk";
import { applyResearch, RESEARCH_MAX_TOKENS } from "./agents/researcher.js";
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
 * The output budget, which has now failed a live audit twice.
 *
 * `max_tokens: 4000` fit 12 findings (3581 output tokens) and 13 (3372), then a
 * 14-finding audit was cut mid-string. The replacement scaled with finding
 * count — and an *8*-finding audit truncated against its 8400, on twice the
 * budget and half the findings. Measured on that request with the ceiling
 * opened: 2308 / 4615 / 2468 tokens for identical input, where run 2 billed
 * 4615 for roughly 670 tokens of returned JSON. What this budget mostly buys is
 * invisible and varies 2x, so it is a flat number, and these assert the two
 * things that are actually true of it.
 */
describe("the research output ceiling", () => {
  test("it clears every usage we have ever recorded, with room over the worst", () => {
    // 12 and 13 from model_calls; 4615 is the measured high on 8 findings.
    for (const recorded of [3581, 3372, 4615]) {
      assert.ok(
        RESEARCH_MAX_TOKENS > recorded * 3,
        `${recorded} tokens were produced and the ceiling is ${RESEARCH_MAX_TOKENS}`,
      );
    }
  });

  /**
   * The upper bound is the SDK's, so the SDK is what gets asked.
   *
   * `calculateNonstreamingTimeout` throws for any non-streaming request whose
   * max_tokens implies over ten minutes. The previous ceiling of 32,000 was
   * past it: a 25-finding audit would have thrown client-side, before a request
   * was sent, and lost the step to the guard meant to protect it. Copying the
   * threshold into this file would leave us pinned to arithmetic that can
   * change under us on an SDK bump.
   */
  test("the ceiling is one the SDK will actually send without streaming", () => {
    const client = new Anthropic({ apiKey: "test-key-not-used" });
    assert.doesNotThrow(() => client.calculateNonstreamingTimeout(RESEARCH_MAX_TOKENS));
  });

  test("and that check has teeth — the ceiling we replaced does throw", () => {
    const client = new Anthropic({ apiKey: "test-key-not-used" });
    assert.throws(
      () => client.calculateNonstreamingTimeout(32_000),
      /Streaming is required/,
      "if this stops throwing, the limit moved and the comment above is stale",
    );
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

/**
 * The seven rows added 2026-08-19, and the gaps they were chosen against.
 *
 * These are not "more sources is better". Each one answers a cluster counted in
 * the 45 uncited findings that Research actually saw — read individually, not
 * sampled. This suite is where that reasoning survives: delete a row and the
 * test names the gap that reopens, instead of a coverage number quietly
 * dropping somewhere nobody looks.
 *
 * It deliberately asserts **reachability from the lane the gap appeared in**,
 * not mere presence in the table. A source the Research agent is never shown is
 * a source that does not exist — `sourcesFor` filters the shortlist by lens, so
 * a row with the wrong `topics` is invisible however good its claim is.
 */
describe("the gaps these sources were added against", () => {
  const reachableFrom = (lane: string, id: string) =>
    sourcesFor([lane]).some((s) => s.id === id);

  const GAPS: { gap: string; lane: string; source: string; findings: number }[] = [
    // ~16 findings: "Jargon on First Use", "Plain language", "Acronym on first
    // use", "Copy - Clarity/Specificity", "Value proposition clarity"...
    { gap: "plain language and jargon", lane: "copy", source: "nng-plain-language", findings: 16 },
    { gap: "marketing language and internal jargon", lane: "copy", source: "nng-user-centric-language", findings: 16 },
    // ~9 findings on pricing pages: "Cost transparency", "Cost disclosure
    // timing", "Trust before commitment", "Commitment revealed late".
    { gap: "cost transparency outside checkout", lane: "conversion-cta", source: "nng-show-price", findings: 9 },
    // ~4: "Specific vs. vague CTA label", "Clarity of link text",
    // "Consistent call to action", "Clarity of next step".
    { gap: "CTA and link label specificity", lane: "conversion-cta", source: "nng-better-link-labels", findings: 4 },
    // ~3 WCAG criteria the table did not hold.
    { gap: "heading structure as programmatic structure", lane: "visual-hierarchy", source: "wcag-info-and-relationships", findings: 3 },
    { gap: "minimum target size", lane: "a11y", source: "wcag-target-size-minimum", findings: 3 },
  ];

  for (const { gap, lane, source, findings } of GAPS) {
    test(`${gap} (~${findings} uncited) is reachable from the ${lane} lens`, () => {
      assert.ok(
        reachableFrom(lane, source),
        `${source} exists but the ${lane} shortlist cannot see it — check its topics`,
      );
    });
  }

  test("the corpus does not only say jargon is bad", () => {
    /**
     * The one row here that is not filling a gap. Two plain-language sources on
     * their own read as a rule — "avoid jargon" — and that rule is wrong for a
     * specialist audience, which is most of the B2B sites we audit. Nielsen's
     * "Use Specialized Language for Specialized Audiences" says so directly, so
     * a reviewer stretching plain-language guidance onto an expert page can be
     * answered from the same table rather than from nobody.
     *
     * Asserted as a pair because either alone is a corpus with an opinion.
     */
    const copy = sourcesFor(["copy"]).map((s) => s.id);
    assert.ok(copy.includes("nng-plain-language"), "the plain-language side");
    assert.ok(copy.includes("nng-specialized-language"), "and the side that says when jargon is right");
  });

  test("every claim added carries at least one quotation from its page", () => {
    /**
     * **What this does not do**, stated because the first version of it implied
     * otherwise and a revert proved the point: it cannot tell a quoted claim
     * from a mostly-paraphrased one. Replacing a quoted sentence with a
     * paraphrase left the other quotations in place and the test stayed green.
     *
     * What it does catch is a claim written entirely from memory, which is the
     * failure mode with a history here — a guessed growth.design URL 404'd when
     * this table was built, and a guessed pricing URL 404'd while adding these
     * rows. Reading the page is a rule kept by people; this is the floor under
     * it, and the floor is low.
     */
    for (const id of [...GAPS.map((g) => g.source), "nng-specialized-language"]) {
      const source = sourceById(id);
      assert.ok(source, `${id} is missing from the table`);
      assert.match(
        source!.claim,
        /["“]/,
        `${id}'s claim carries no quotation at all — it may be a recollection rather than a reading`,
      );
    }
  });
});
