import { z } from "zod";

/**
 * The context profile — docs/design.md §2, produced by the Context Profiler from
 * the visitor's question-flow answers and nothing else.
 *
 * Its whole job is to turn free text into the handful of enumerated facts the
 * spawn rules in §3 actually read. Keeping it this small is deliberate: a rule
 * can only fire on something in here, so anything added here is a new thing the
 * Orchestrator is allowed to reason about.
 */

export const Concern = z.enum([
  "conversion",
  "abandonment",
  "messaging",
  "comprehension",
  "compliance",
  "first_impressions",
  "bounce",
]);
export type Concern = z.infer<typeof Concern>;

export const Goal = z.enum(["signup", "purchase", "book", "contact", "learn", "unknown"]);
export type Goal = z.infer<typeof Goal>;

export const SiteKind = z.enum(["ecommerce", "saas", "marketing", "content", "other"]);
export type SiteKind = z.infer<typeof SiteKind>;

export const DropPoint = z.enum(["landing", "mid_funnel", "final_step", "unknown"]);
export type DropPoint = z.infer<typeof DropPoint>;

export const ContextProfile = z.object({
  site_kind: SiteKind.describe("What kind of site the visitor says this is."),
  /**
   * Ordered by emphasis: the thing they led with sits first. That order is load
   * bearing — when more rules fire than the spawn cap allows, it is what decides
   * which specialist gets dropped (§3).
   */
  concerns: z
    .array(Concern)
    .describe(
      "The visitor's stated concerns, most-emphasised first. Only what they " +
        "actually said — do not add concerns you think a site like theirs should have.",
    ),
  goal: Goal.describe("The action they said a visitor should take."),
  drop_point: DropPoint.describe("Where they said visitors seem to drop, if they said."),
  summary: z
    .string()
    .describe(
      "One or two sentences in the visitor's own framing, for the audit header. " +
        "No advice, no diagnosis — you have not seen their site.",
    ),
});
export type ContextProfile = z.infer<typeof ContextProfile>;

/** The five questions. The CLI asks these; the web flow will ask the same ones. */
export const QUESTIONS = [
  "What kind of site is it?",
  "What's your biggest concern right now?",
  "What should a visitor do on your site?",
  "Where do they seem to drop off?",
  "Anything else we should know?",
] as const;

export type Answers = Record<string, string>;
