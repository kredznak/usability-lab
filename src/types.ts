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
  captured_at: z.string(),
});
export type Capture = z.infer<typeof Capture>;

/**
 * What the Heuristics sub-agent returns. No confidence. No citation.
 * Severity is an enum, not a ranged int — JSON Schema numeric constraints
 * (minimum/maximum) are not supported by structured outputs, but enums are.
 */
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

export const HeuristicsOutput = z.object({
  findings: z.array(RawFinding),
});
export type HeuristicsOutput = z.infer<typeof HeuristicsOutput>;

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
