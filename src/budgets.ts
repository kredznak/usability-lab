/**
 * Wall-clock budgets — docs/design.md §6, and F9.
 *
 * §6 sets per-step budgets and nothing in the code enforced any of them. On
 * 2026-08-17 a single synthesizer call ran 1618s and reported success; three
 * more ran 1144s, 1479s and 280s. Audits that are supposed to finish in eight
 * minutes took thirty, and the only symptom was a step timing nobody was
 * watching.
 *
 * ## Why these are SDK options and not a race against a timer
 *
 * A `Promise.race` leaves the losing request running: the tokens are still
 * generated and still billed, and the process holds the socket. `timeout` makes
 * the SDK abort the request, and `maxRetries` bounds how many times it may try
 * again — which together are the only way to bound what a step can cost.
 *
 * **Both matter.** The SDK's default is a 600s timeout with two retries, so a
 * step that keeps timing out spends ~1800s before failing. That is the shape of
 * B14 and 1618s is very close to 3 x 540s.
 *
 * ## Why a failure here is not a lost audit
 *
 * Every one of these agents already degrades: the Synthesizer falls through to
 * pass-through, Research to `none` citations, a sub-agent to DEGRADED. So an
 * overrun costs the step and not the run, which is a better answer than §6's
 * PARK for the same reason §7 prefers a partial audit to no audit.
 *
 * Numbers are set from measured behaviour, with headroom, not from the spec's
 * round figures:
 *
 *     synthesizer   8-43s observed on healthy runs   ->  120s, 1 retry
 *     researcher    25-95s observed                  ->  120s, 1 retry
 *     sub-agent     50-60s observed                  ->  120s, 1 retry
 *
 * Worst case per step is therefore ~240s rather than ~1800s.
 */
export interface Budget {
  timeout: number;
  maxRetries: number;
}

export const BUDGETS: Record<"synthesizer" | "researcher" | "subAgent", Budget> = {
  synthesizer: { timeout: 120_000, maxRetries: 1 },
  researcher: { timeout: 120_000, maxRetries: 1 },
  subAgent: { timeout: 120_000, maxRetries: 1 },
};
