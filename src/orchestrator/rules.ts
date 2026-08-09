import type { CaptureSignals } from "../signals.js";
import type { Concern, ContextProfile } from "../profile.js";

/**
 * Spawn rules R0–R5 and the cap — docs/design.md §3.
 *
 * Pure functions of (profile, signals). This is what the trajectory suite
 * asserts against, so it must stay free of model calls, clocks and randomness:
 * a spawn set you cannot predict is a spawn set you cannot test.
 *
 * The Orchestrator (index.ts, one Sonnet call) may override the result of this
 * file, but only by narrowing it and only with a logged rationale. The rules are
 * "inputs to a judgment call, not a lookup table" — but they are also the floor
 * the judgment is measured against.
 */

export type RuleId = "R0" | "R1" | "R2" | "R3" | "R4" | "R5";

export interface RuleFiring {
  rule: RuleId;
  agent: string;
  /** Human-readable, logged with the decision. Names the branch that fired. */
  because: string;
  /**
   * Lower is more relevant to what the visitor actually asked about. This is
   * what the cap displaces on — see relevance() below.
   */
  relevance: number;
}

export interface SpawnDecision {
  spawn: string[];
  fired: RuleFiring[];
  dropped: { agent: string; rule: RuleId; because: string; reason: string }[];
}

/** §3: "Max 4 sub-agents per audit." */
export const SPAWN_CAP = 4;

/**
 * Tie-break when two rules fire for equally-relevant reasons. Ordered by how
 * directly the lane bears on a visitor completing a goal action, which is what
 * every build use case (UC-1, UC-4, UC-5) is about.
 */
const LANE_ORDER = [
  "heuristics",
  "forms",
  "conversion-cta",
  "a11y",
  "copy",
  "visual-hierarchy",
];

/**
 * Relevance of a firing to the *stated* concern.
 *
 * A rule that fired because the visitor raised the issue outranks one that fired
 * because we noticed something on the page — they are the customer, and §3 says
 * the cap keeps "the 4 most relevant to the stated concern". Within the stated
 * concerns, earlier means more emphasised: the profile's `concerns` array is
 * ordered by what they led with.
 */
function concernRelevance(profile: ContextProfile, concerns: readonly Concern[]): number | null {
  let best: number | null = null;
  for (const c of concerns) {
    const idx = profile.concerns.indexOf(c);
    if (idx !== -1 && (best === null || idx < best)) best = idx;
  }
  return best;
}

/** Fired only by something we measured on the page. Always yields to a stated concern. */
const SIGNAL_ONLY = 100;
/** The goal action is a statement of intent, but a weaker one than the lead concern. */
const GOAL_DRIVEN = 0.5;

export function evaluateRules(
  profile: ContextProfile,
  signals: CaptureSignals,
): RuleFiring[] {
  const fired: RuleFiring[] = [];

  const add = (
    rule: RuleId,
    agent: string,
    concerns: readonly Concern[],
    signalFired: boolean,
    signalBecause: string,
  ) => {
    const stated = concernRelevance(profile, concerns);
    if (stated !== null) {
      fired.push({
        rule,
        agent,
        because: `stated concern '${profile.concerns[stated]}'`,
        relevance: stated,
      });
    } else if (signalFired) {
      fired.push({ rule, agent, because: signalBecause, relevance: SIGNAL_ONLY });
    }
  };

  // R0 — always. Negative relevance so no cap can ever displace it.
  fired.push({ rule: "R0", agent: "heuristics", because: "always", relevance: -1 });

  // R1 — concern ∈ {conversion, abandonment} OR capture contains form
  add(
    "R1",
    "forms",
    ["conversion", "abandonment"],
    signals.has_substantive_form,
    `page has a ${signals.form_fields}-field form`,
  );

  // R2 — concern ∈ {messaging, comprehension} OR copy-density > threshold
  add(
    "R2",
    "copy",
    ["messaging", "comprehension"],
    signals.copy_dense,
    `copy density ${signals.copy_density} chars/screen`,
  );

  // R3 — profile mentions compliance/a11y OR a11y-signal in capture
  add(
    "R3",
    "a11y",
    ["compliance"],
    signals.a11y_signal,
    signals.unlabelled_fields > 0
      ? `${signals.unlabelled_fields} field(s) named only by placeholder`
      : `${signals.unnamed_interactives} interactive element(s) with no accessible name`,
  );

  // R4 — goal ∈ {signup, purchase, book} AND capture is a landing, pricing or
  // checkout page. Both halves required: a goal with no page to act on, or a
  // checkout page for someone who never named a goal, is not this lane's work.
  if (
    ["signup", "purchase", "book"].includes(profile.goal) &&
    (signals.is_goal_page || signals.page_kind === "landing")
  ) {
    fired.push({
      rule: "R4",
      agent: "conversion-cta",
      because: `goal '${profile.goal}' on a ${signals.page_kind} page`,
      relevance: GOAL_DRIVEN,
    });
  }

  // R5 — concern ∈ {first impressions, bounce} OR hierarchy-signal in capture
  add(
    "R5",
    "visual-hierarchy",
    ["first_impressions", "bounce"],
    signals.hierarchy_signal,
    signals.h1_count !== 1
      ? `${signals.h1_count} h1 element(s) on the page`
      : `${signals.competing_emphases} elements competing at the largest type size`,
  );

  return fired;
}

/**
 * Applies the cap. Deterministic on purpose — the trajectory suite asserts
 * displacement cases exactly, which is only possible if displacement is not a
 * judgment call.
 */
export function resolveSpawnSet(fired: RuleFiring[]): SpawnDecision {
  const ranked = fired.slice().sort(
    (a, b) =>
      a.relevance - b.relevance ||
      LANE_ORDER.indexOf(a.agent) - LANE_ORDER.indexOf(b.agent),
  );

  const kept = ranked.slice(0, SPAWN_CAP);
  const dropped = ranked.slice(SPAWN_CAP).map((f) => ({
    agent: f.agent,
    rule: f.rule,
    because: f.because,
    reason: `spawn cap of ${SPAWN_CAP} reached; ${kept.length} rules ranked more relevant to the stated concern`,
  }));

  return { spawn: kept.map((f) => f.agent), fired: ranked, dropped };
}

export function decideSpawnSet(
  profile: ContextProfile,
  signals: CaptureSignals,
): SpawnDecision {
  return resolveSpawnSet(evaluateRules(profile, signals));
}
