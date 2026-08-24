import { z } from "zod";

/**
 * Canonical Finding contract — docs/design.md §3.
 *
 * Split deliberately into two schemas:
 *   RawFinding  — what a sub-agent is allowed to produce.
 *   Finding     — what the pipeline assembles from it.
 *
 * `confidence` exists only on Finding. A sub-agent has no field to write it
 * into, so §9.1 ("confidence is derived, not declared") is enforced by the
 * schema rather than by asking the model nicely.
 */

export const BBox = z.object({
  x: z.number().describe("Left edge in CSS pixels, relative to the full-page screenshot."),
  y: z.number().describe("Top edge in CSS pixels, relative to the full-page screenshot."),
  width: z.number(),
  height: z.number(),
});
export type BBox = z.infer<typeof BBox>;

/** One interactive/structural element the capture step extracted, with its measured box. */
export const CapturedElement = z.object({
  ref: z.string().describe("Stable handle, e.g. 'el_12'. Sub-agents cite this."),
  tag: z.string(),
  role: z.string().nullable(),
  text: z.string().describe("Visible text, truncated to 200 chars per §8 redaction."),
  bbox: BBox,
  above_fold: z.boolean(),
  /**
   * The `type` attribute of an <input>, null for everything else.
   * Without it a search box and an email field are the same row, and spawn rule
   * R1 ("capture contains form") fires on every site on the web.
   */
  input_type: z.string().nullable(),
  /**
   * Accessible name from aria-label, aria-labelledby, an associated <label>,
   * title, or alt. Null means the element has no programmatic name — which for
   * an interactive element with no visible text is itself the a11y signal R3
   * reads.
   */
  accessible_name: z.string().nullable(),
  /**
   * Where accessible_name came from. Provenance matters more than presence: a
   * field named only by its placeholder is the classic "looks labelled, isn't"
   * defect — the name vanishes the moment the visitor types. Without this, that
   * page scores identically to a properly labelled one.
   */
  name_source: z
    .enum(["aria-label", "aria-labelledby", "label", "title", "alt", "placeholder"])
    .nullable(),
  /** Computed font-size in px. Hierarchy is a claim about relative size (R5). */
  font_size: z.number(),
  /**
   * `fixed` or `sticky`, and null for everything else — B13.
   *
   * A fixed header paints once at the top of a full-page screenshot, so a
   * reviewer looking at the slices sees it in the first one and nowhere else.
   * One read that as "no sticky version of it reappears" and filed a severity 2
   * at high confidence; duolingo's header is `position: fixed`, 1440x72 at
   * top:0. The screenshot cannot show this and the element list did not carry
   * it, so the reviewer had nothing to be right with.
   *
   * Optional so that captures frozen before 2026-08-17 still parse. Null here
   * means "static, or taken before we recorded it" — which is why the renderer
   * says nothing at all rather than saying "not sticky".
   */
  position: z.enum(["fixed", "sticky"]).nullish(),
  /**
   * The browser's own accessible name, recorded only when it carries text that
   * `text` and `accessible_name` do not — B30.
   *
   * basecamp.com renders a live counter as `<number-flow>`, a custom element
   * with **zero light-DOM children and a closed shadow root**. `textContent`,
   * `innerText` and `shadowRoot` traversal are all blind to the digits, so
   * `el_10.text` is "people are working in Basecamp right now!" and every check
   * we had said the number was not on the page. It is:
   *
   *     link  "112,942 people are working in Basecamp right now!"
   *     image "112,942"        <- the closed-shadow element, exposed
   *
   * A true positive was one keystroke from being cut at the gate for quoting
   * it. The accessibility tree is computed from the *rendering* rather than the
   * DOM, which is why it sees what nothing else here can.
   *
   * **Deliberately not a quote source.** `pageSources` does not read this, and
   * `confidence.test.ts` pins that. The AX tree also carries screen-reader-only
   * text — linear.app's clipped duplicate h1, which `claims.test.ts` holds as a
   * *correct* contradiction — so feeding it to the quote check would re-open
   * exactly the false finding that made us assemble text by hand. This is B6's
   * trade-off and B6's answer: the narrow one.
   *
   * Null means "nothing extra, or captured before 2026-08-24". Never "the
   * rendering agrees" — silence has to keep meaning unknown.
   */
  rendered_name: z.string().nullish(),
});
export type CapturedElement = z.infer<typeof CapturedElement>;

export const Capture = z.object({
  audit_id: z.string(),
  url: z.string(),
  final_url: z.string().describe("After redirects. Differs from url on a parked/cookie wall (F2)."),
  title: z.string(),
  screenshot_id: z.string(),
  screenshot_path: z.string(),
  viewport: z.object({ width: z.number(), height: z.number() }),
  full_height: z.number(),
  elements: z.array(CapturedElement),
  elements_total: z
    .number()
    .describe(
      "Visible elements matching the selector before the extraction cap. " +
        "If this exceeds elements.length the capture is truncated — §9.7 says " +
        "say so rather than papering over it.",
    ),
  text_excerpt: z.string().describe("First 4000 chars of visible page text. Untrusted input."),
  text_total_chars: z
    .number()
    .describe(
      "Length of the page's full visible text before the excerpt cap. " +
        "text_excerpt saturates at 4000 chars, so copy density measured from it " +
        "would read every long page as identical.",
    ),
  captured_at: z.string(),
});
export type Capture = z.infer<typeof Capture>;

/** The 1–4 scale the pipeline guarantees. Only assembled Findings carry it. */
export const Severity = z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]);
export type Severity = z.infer<typeof Severity>;

export const RawFinding = z.object({
  heuristic: z
    .string()
    .describe("Nielsen heuristic or named UX principle this finding rests on."),
  /**
   * Declared as a plain number on purpose.
   *
   * Structured outputs cannot express a numeric `const`/range: a Zod union of
   * literals is converted to {"type":"number","description":"{const: 1}"}, so
   * the constraint survives only as prose and the API is free to return 0, 5 or
   * 2.5 — which it did, failing a live run. Rather than pretend the schema
   * enforces the scale, we accept a number and clamp it deterministically in
   * normalizeSeverity(). Same principle as confidence: the pipeline owns the
   * invariant, the model does not.
   */
  severity: z
    .number()
    .describe("1 = cosmetic, 2 = minor, 3 = major, 4 = catastrophic. Use only 1, 2, 3 or 4."),
  element_ref: z
    .string()
    .nullable()
    .describe(
      "The `ref` of the captured element this is about, e.g. 'el_12'. " +
        "Null ONLY if the finding is about the page as a whole and no single element carries it. " +
        "A null ref caps the finding at medium confidence and it may be dropped.",
    ),
  observation: z
    .string()
    .describe("What is literally visible on the page. No interpretation, no advice."),
  impact_note: z
    .string()
    .describe("Why this costs the visitor or the business something. One or two sentences."),
  positive: z
    .boolean()
    .describe("True if this is a genuine thing the page does well (§9.4 requires >=1)."),
});
export type RawFinding = z.infer<typeof RawFinding>;

/** What every sub-agent returns. Identical across all six rubrics (§2). */
export const SubAgentOutput = z.object({
  findings: z.array(RawFinding),
});
export type SubAgentOutput = z.infer<typeof SubAgentOutput>;

export const Citation = z.object({
  source_type: z.enum(["paper", "competitor", "none"]),
  url: z.string().nullable(),
});
export type Citation = z.infer<typeof Citation>;

/**
 * Rounds and clamps a model-supplied severity onto the 1–4 scale.
 * Pure and total: every real number maps to a valid severity.
 * `adjusted` is true when the model handed us something off-scale, so drift is
 * visible in the run output instead of being silently corrected.
 */
export function normalizeSeverity(raw: number): { value: Severity; adjusted: boolean } {
  const rounded = Math.round(raw);
  // Non-finite input (NaN, Infinity) is garbage, not an opinion about severity.
  // It falls back to 2 rather than clamping up to 4: a nonsense value must never
  // become a severity-4 claim, which is the only level allowed to use words like
  // "critical" or "broken" (§9.4).
  const clamped = Number.isFinite(rounded) ? Math.min(4, Math.max(1, rounded)) : 2;
  return { value: clamped as Severity, adjusted: clamped !== raw };
}

/** The assembled Finding. Only the pipeline constructs these. */
export const Finding = RawFinding.extend({
  id: z.string(),
  agent: z.string(),
  screen_ref: z.string(),
  // Narrowed from RawFinding's plain number — guaranteed by normalizeSeverity().
  severity: Severity,
  confidence: z.enum(["high", "medium"]),
  citation: Citation,
  evidence: z.object({
    screenshot_id: z.string(),
    bbox: BBox.nullable(),
  }),
});
export type Finding = z.infer<typeof Finding>;

/**
 * The founder gate's record — docs/design.md §6, REVIEW_PENDING -> PUBLISHED.
 *
 * Lives here rather than in review.ts so `corpus.ts` can read the shape without
 * importing a script that runs on import.
 */
export interface ReviewDecision {
  finding_id: string;
  keep: boolean;
  severity_before: number;
  severity_after: number;
  /**
   * Why it was cut, or why severity moved. Required for both of those since
   * B29 — a cut or an adjustment cannot be recorded without one.
   */
  note: string | null;
  /**
   * B29. The reviewer was asked for a reason and chose not to give one.
   *
   * Without this, a null note means two different things — "never asked" and
   * "would rather not say" — and the corpus cannot tell them apart. Every
   * decision recorded before 2026-08-24 is the first kind, indistinguishably.
   * Optional because those 165 do not carry the field at all.
   */
  reason_declined?: boolean;
  /**
   * Milliseconds from the prompt appearing to the keystroke that answered it.
   *
   * B29's real complaint is that a 94% keep rate is equally consistent with a
   * careful pipeline and a rubber stamp, and nothing in the record can separate
   * them. Reasons only exist on the ~7% of decisions that cut or adjust; this
   * covers all of them. It is a proxy and a noisy one — an interrupted review
   * inflates it and an obvious finding is genuinely quick — so it is worth
   * reading as a session median and not as a score.
   */
  ms?: number | null;
}

export interface ReviewRecord {
  audit_id: string;
  reviewed_at: string;
  decisions: ReviewDecision[];
  /**
   * Who made these decisions.
   *
   * Absent on every record written before 2026-08-24, all of which were a
   * person at `npm run review`, so absent reads as "founder". `auto` means no
   * mechanical check objected and the audit published itself — which is a
   * claim about `claims.ts`, not a judgment about usefulness.
   *
   * The distinction is load-bearing rather than decorative: `npm run corpus`
   * trains on these as usefulness labels, and an auto record is a unanimous
   * keep. Counted alongside the 165 human decisions they would read as perfect
   * agreement and bury the only signal B29 has.
   */
  decided_by?: "founder" | "auto";
}
