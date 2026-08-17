import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import type { Finding } from "../types.js";
import { CallLog, estimateCost } from "../db.js";
import { SOURCES, sourcesFor, resolveCitation, type Source } from "../sources.js";
import { counted, attemptsHere } from "../http.js";
import { BUDGETS } from "../budgets.js";

/**
 * Research — docs/design.md §2, §5. Sonnet.
 *
 * Reach: findings plus the curated corpus. It may attach a citation and nothing
 * else. §2 says it "may raise confidence"; it does not here — confidence is
 * derived from evidence by a pure function (§9.1), and a citation is not
 * evidence that the page says what we claim. Deferred deliberately: changing it
 * would silently redefine every confidence label we have already measured.
 *
 * ## Why this returns ids and not URLs
 *
 * quality-bar.md: a fabricated citation "is the worst single output this
 * product can produce, worse than no audit." F5 answers that by linting URLs
 * after the fact. This answers it earlier: **the schema has no URL field at
 * all.** The model names a source; `resolveCitation` reads the URL out of the
 * table. There is no argument through which a URL could be passed in, so a
 * fabricated URL is not something this step can emit.
 *
 * Be precise about what the enum does and does not do. Measured 2026-08-13:
 * this SDK compiles `z.enum([...])` to `{"type":"string","description":"{enum:
 * [...]}"}` — a *description*, not a JSON Schema `enum`. Nothing stops the model
 * returning an id we have never heard of. That is why `applyResearch` checks
 * every id against the shortlist rather than trusting the schema, and why
 * `sources.test.ts` pins the SDK behaviour: the day it starts emitting a real
 * enum, we should find out from a failing test rather than from a citation.
 *
 * The rule this project keeps relearning — a constraint in a prompt or a schema
 * description is a request; a constraint in a lookup is a fact.
 *
 * ## Why `none` is the easy answer
 *
 * The prompt makes declining cheap and explicit. A citation that does not
 * genuinely support the finding is worse than no citation, and the page renders
 * `none` as "based on our evaluation" — honest, and not an authority we made up.
 */

const MODEL = "claude-sonnet-5";
const AGENT = "researcher";
export const PROMPT_VERSION = "researcher-v1";

const SYSTEM_PROMPT = `You are the Research step on a UX audit team. Findings have already been written and ranked by reviewers who looked at a captured page. Your only job is to decide, for each finding, whether the published research we hold supports it — and if so, which source.

## What you do

For each finding, pick the ONE source that most directly supports the specific claim it makes, or decline.

A source supports a finding when the finding's claim is an instance of what the source actually says. "This checkout has 14 fields" is supported by research on average checkout field counts. "This button is hard to read" is not supported by research about decision time, however adjacent the two feel.

## Declining is a real answer, and often the right one

Return no source when nothing in the list genuinely fits. A finding with no citation displays as "based on our evaluation", which is honest and costs us nothing. A finding carrying a citation that does not actually support it is the single worst thing this product can publish — worse than publishing no audit at all. When you are between "this roughly relates" and "nothing fits", choose nothing fits.

Do not stretch a source to cover a finding because the finding has no other candidate. Do not cite a source for the topic area it belongs to rather than for what it says.

## What you cannot do

You cannot edit, rank, add or remove findings. You cannot write a URL — sources are chosen by id from the list you are given, and the id is all you return. You cannot cite a source that is not in the list.

For each finding also give a short \`why\`: the sentence in the source's claim that does the work. If you cannot write that sentence, you do not have a citation.`;

/**
 * The id list is built from the table so the model is *shown* exactly what it
 * may cite. It is a strong hint, not a guarantee — see the note above — so
 * `applyResearch` validates the answer regardless.
 */
function outputSchema(sources: Source[]) {
  const ids = sources.map((s) => s.id);
  return z.object({
    citations: z.array(
      z.object({
        finding_id: z.string().describe("The finding this citation is for."),
        source_id: ids.length
          ? z.enum(ids as [string, ...string[]]).nullable()
          : z.null(),
        why: z
          .string()
          .describe("What in the source supports this specific finding, or why nothing does."),
      }),
    ),
  });
}

/**
 * Output budget — a flat ceiling, because the thing it has to cover does not
 * scale with anything we can see.
 *
 * This was `max_tokens: 4000`, which broke a 14-finding audit on 2026-08-16. It
 * then became `2000 + 800 * findings`, indexed on the idea that output grows
 * with the number of citations to write. On 2026-08-17 an *8*-finding audit
 * (duolingo) truncated against that formula's 8400 — half the findings of the
 * original failure, twice the budget, same death.
 *
 * Measured, four calls on that exact request with the ceiling opened to 32k:
 *
 *     2308 / 4615 / 2468 output tokens, identical input, 2x spread
 *     run 2 billed 4615 tokens for an answer of ~670 tokens of JSON
 *
 * So ~85% of what this call costs is produced and never returned — adaptive
 * thinking, charged to the same budget and invisible in `content`. It varies
 * 2x between identical requests and does not move with finding count. A formula
 * over findings is a formula over the wrong variable, so there is no formula.
 *
 * The number is bounded by the SDK, not by us. `calculateNonstreamingTimeout`
 * refuses any non-streaming request whose `max_tokens` implies over ten minutes
 * — the cutoff is 21,334 — and the old ceiling of 32,000 was above it. At 25
 * findings the runaway guard would have thrown client-side and killed the step
 * before a request was sent. `sources.test.ts` asks the SDK itself rather than
 * copying its arithmetic.
 *
 * Headroom is free: billing is on tokens produced, not tokens allowed.
 */
export const RESEARCH_MAX_TOKENS = 20_000;

export interface ResearchResult {
  /** Findings with citations attached. Same objects, same order, same text. */
  findings: Finding[];
  cited: number;
  /** What the model said, kept for the run log and for reading later. */
  notes: { finding_id: string; source_id: string | null; why: string }[];
  /** Set when the step fell back to leaving every citation as `none`. */
  degraded: string | null;
  latencyMs: number;
  costUsd: number;
}

function render(findings: Finding[], sources: Source[]): string {
  return [
    `SOURCES AVAILABLE (${sources.length}) — cite by id, or cite nothing`,
    ...sources.map(
      (s) => `\n[${s.id}] ${s.title} — ${s.publisher}\n  What it says: ${s.claim}`,
    ),
    ``,
    `FINDINGS (${findings.length})`,
    ...findings.map(
      (f, i) =>
        `\n${i + 1}. id: ${f.id}\n   lens: ${f.agent}\n   ${f.observation}\n   Why it matters: ${f.impact_note}`,
    ),
  ].join("\n");
}

/** Every citation `none`, honestly. The state a failed research step leaves. */
function uncited(findings: Finding[], reason: string | null, started: number, costUsd: number): ResearchResult {
  return {
    findings: findings.map((f) => ({ ...f, citation: resolveCitation(null) })),
    cited: 0,
    notes: [],
    degraded: reason,
    latencyMs: Date.now() - started,
    costUsd,
  };
}

export async function runResearcher(
  client: Anthropic,
  findings: Finding[],
  auditId: string,
  log: CallLog,
): Promise<ResearchResult> {
  const started = Date.now();
  let costUsd = 0;

  if (findings.length === 0) return uncited(findings, null, started, 0);

  // Only the sources whose topics match a lens that actually reviewed this page.
  // A WCAG criterion should not be on the shortlist for a copy-only audit.
  const lenses = [...new Set(findings.flatMap((f) => f.agent.split("+")))];
  const shortlist = sourcesFor(lenses);
  if (shortlist.length === 0) return uncited(findings, "no sources match this audit's lenses", started, 0);

  const schema = outputSchema(shortlist);

  try {
    /**
     * `create`, not `parse`, and the difference is diagnosis.
     *
     * `messages.parse()` is `create().then(parseMessage)`, and `parseMessage`
     * throws on malformed JSON. The usage figures are on the response object
     * that throw discards — so when duolingo's research died mid-string, the
     * row it wrote to `model_calls` read 0 input, 0 output. The one call we
     * most needed to read recorded nothing about itself.
     *
     * Parsing here instead means the response is logged before anything can go
     * wrong with its contents, and `stop_reason` — which says outright whether
     * we hit the ceiling — is read rather than inferred from a JSON error.
     */
    const { result: response, attempts } = await counted(() =>
      client.messages.create(
        {
          model: MODEL,
          max_tokens: RESEARCH_MAX_TOKENS,
          thinking: { type: "adaptive" },
          output_config: { effort: "high", format: zodOutputFormat(schema) },
          system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: render(findings, shortlist) }],
        },
        BUDGETS.researcher,
      ),
    );

    const usage = {
      input_tokens: response.usage.input_tokens,
      output_tokens: response.usage.output_tokens,
      cache_read_tokens: response.usage.cache_read_input_tokens ?? 0,
      cache_write_tokens: response.usage.cache_creation_input_tokens ?? 0,
    };
    costUsd = estimateCost(MODEL, usage);

    log.record({
      audit_id: auditId,
      agent: AGENT,
      model: MODEL,
      prompt_version: PROMPT_VERSION,
      ...usage,
      latency_ms: Date.now() - started,
      cost_usd: costUsd,
      ok: true,
      error: null,
      attempts,
    });

    if (response.stop_reason === "refusal") {
      return uncited(findings, `model refused: ${response.stop_details?.category}`, started, costUsd);
    }
    // Named, not inferred. Truncation used to reach us as "Unterminated string
    // in JSON at position 1616", which describes the symptom and hides the
    // cause; the API says plainly that it ran out of room.
    if (response.stop_reason === "max_tokens") {
      return uncited(
        findings,
        `output hit the ${RESEARCH_MAX_TOKENS}-token ceiling (${response.usage.output_tokens} produced)`,
        started,
        costUsd,
      );
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === "text")
      .map((b) => b.text)
      .join("");

    const parsed = ((): z.infer<typeof schema> | null => {
      try {
        return schema.parse(JSON.parse(text));
      } catch {
        return null;
      }
    })();

    if (!parsed) {
      return uncited(findings, "no schema-valid output", started, costUsd);
    }

    return {
      ...applyResearch(findings, parsed.citations, shortlist),
      latencyMs: Date.now() - started,
      costUsd,
    };
  } catch (err) {
    log.record({
      audit_id: auditId,
      agent: AGENT,
      model: MODEL,
      prompt_version: PROMPT_VERSION,
      input_tokens: 0,
      output_tokens: 0,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      latency_ms: Date.now() - started,
      cost_usd: costUsd,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      attempts: attemptsHere(),
    });
    // A research failure costs citations, not the audit. Every finding still
    // ships, honestly uncited — §9.3 makes `none` a legal, unpunished output.
    return uncited(
      findings,
      `research call failed: ${err instanceof Error ? err.message : String(err)}`,
      started,
      costUsd,
    );
  }
}

/**
 * Attaches citations, refusing anything it cannot substantiate.
 *
 * Pure and exported so tests can attack it with what a model actually produces
 * when it drifts: an id for a finding that does not exist, a source outside the
 * shortlist it was shown, the same finding cited twice, a URL smuggled into a
 * text field. The only path to a URL is `resolveCitation`, which reads the
 * table — so the worst a drifting model can achieve is `none`.
 */
export function applyResearch(
  findings: Finding[],
  citations: { finding_id: string; source_id: string | null; why: string }[],
  shortlist: Source[] = SOURCES,
): Omit<ResearchResult, "latencyMs" | "costUsd"> {
  const allowed = new Set(shortlist.map((s) => s.id));
  const chosen = new Map<string, { source_id: string | null; why: string }>();
  const known = new Set(findings.map((f) => f.id));

  for (const c of citations) {
    // A citation for a finding nobody wrote, or a second citation for one
    // already decided. Both are drift; first answer wins, rest are dropped.
    if (!known.has(c.finding_id) || chosen.has(c.finding_id)) continue;
    // A source outside the shortlist is not a citation, whatever it looks like.
    const id = c.source_id && allowed.has(c.source_id) ? c.source_id : null;
    chosen.set(c.finding_id, { source_id: id, why: c.why });
  }

  const notes: ResearchResult["notes"] = [];
  let cited = 0;

  const out = findings.map((f) => {
    const pick = chosen.get(f.id) ?? null;
    const citation = resolveCitation(pick?.source_id);
    if (citation.source_type !== "none") cited++;
    if (pick) notes.push({ finding_id: f.id, source_id: pick.source_id, why: pick.why });
    return { ...f, citation };
  });

  return { findings: out, cited, notes, degraded: null };
}
