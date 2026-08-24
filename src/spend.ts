/**
 * F11 — the daily cost ceiling, and what happens at it.
 *
 * §12 names five failures handled for real in v0: F1, F7, F9, F11, F21. Four
 * were. This is the fifth, and until now `docs/backlog.md` carried the honest
 * admission that "five failures handled for real" was being claimed with four.
 *
 * ## What the numbers are, and what they are worth
 *
 * §11 sets a $25 daily hard ceiling and an $3 per-audit ceiling, both chosen on
 * paper before anything ran. Measured on 2026-08-21, against every model call
 * this project has ever made:
 *
 *     lifetime            $21.93   294 calls over 13 days
 *     worst day            $8.04   2026-08-17, 87 calls, 15 audits
 *     worst single audit   $1.16
 *
 * So the whole project has spent less in its life than the ceiling allows in a
 * day, and the busiest day reached 32% of it. **This guard has never been close
 * to firing, and nothing in the real log can demonstrate it working** — which is
 * exactly why the tests below drive it with numbers rather than with history.
 *
 * The paper figures are kept rather than tightened. A ceiling exists to stop a
 * runaway, not to describe a typical day, and $25 is roughly three times the
 * worst day we have had — which is the right shape for a backstop. It is now a
 * number that can be checked against real data instead of one that could not.
 *
 * ## Why the ceiling is not enforced in the HTTP server
 *
 * Because no HTTP request may spend money. The form writes a row; a person runs
 * `npm run audit -- --queue` or `npm run reaudit -- --queue`. Those are the only
 * two things that can fill the bill, so those are the only two things that can
 * be stopped by a bill. Putting a spend check on `/request` would guard a route
 * that costs nothing and leave both routes that cost something unguarded.
 *
 * ## Why intake pauses rather than quality dropping
 *
 * §11: "Nothing silently degrades quality to save money — deferral over
 * dilution." An audit that is refused today is queued for tomorrow and the
 * requester's status page already says it has not started. An audit that is run
 * cheaply is a worse audit sold at the same price.
 */

/** §11's hard ceiling. Overridable so an operator can lower it, and so tests do not hunt for $25. */
export const DEFAULT_DAILY_CEILING_USD = 25;

/**
 * §11's per-audit ceiling — "≈2× expected", against a measured worst case of
 * $1.16 across every audit this project has run.
 *
 * It bounds *further* spend inside one audit rather than aborting it: see
 * `verdict` below for why nothing is ever killed mid-run. Unenforced until
 * 2026-08-24, when the queue stopped waiting for a person to decide to spend.
 */
export const DEFAULT_PER_AUDIT_CEILING_USD = 3;

export function perAuditCeilingFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.USABILITY_LAB_AUDIT_CEILING_USD;
  if (raw === undefined || raw.trim() === "") return DEFAULT_PER_AUDIT_CEILING_USD;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_PER_AUDIT_CEILING_USD;
  return n;
}

/** §11: "At 80%: alert". Below the stop, and it does not stop anything. */
const WARN_AT = 0.8;

export function ceilingFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.USABILITY_LAB_DAILY_CEILING_USD;
  if (raw === undefined || raw.trim() === "") return DEFAULT_DAILY_CEILING_USD;
  const n = Number(raw);
  // A ceiling that cannot be read is not a reason to run without one. Nor is it
  // a reason to refuse everything: an unreadable value is an operator's typo,
  // and silently switching to "spend nothing, ever" would look like a hang.
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_DAILY_CEILING_USD;
  return n;
}

/**
 * The UTC day a spend total is counted against.
 *
 * UTC and not local time, because `created_at` on every `model_calls` row is an
 * ISO string in UTC. Comparing a local day against UTC timestamps would move the
 * ceiling's reset by the operator's offset, and would move it twice a year.
 */
export function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export interface Verdict {
  /** True once the day's spend has reached the ceiling. New audits do not start. */
  stop: boolean;
  /** True from 80% of the ceiling. Says so and keeps going. */
  warn: boolean;
  spent: number;
  ceiling: number;
}

/**
 * Whether the next audit may start.
 *
 * Checked *before* an audit rather than during one: §11 lets in-flight audits
 * complete, and a run killed halfway costs its tokens and produces nothing —
 * the most expensive possible outcome.
 */
export function verdict(spentToday: number, ceiling: number): Verdict {
  return {
    stop: spentToday >= ceiling,
    warn: spentToday >= ceiling * WARN_AT,
    spent: spentToday,
    ceiling,
  };
}

/** The line a queue runner prints when it stops, and the line it prints when it is close. */
export function spendLine(v: Verdict): string {
  const money = (n: number) => `$${n.toFixed(2)}`;
  if (v.stop) {
    return (
      `Today's spend is ${money(v.spent)}, at the ${money(v.ceiling)} ceiling.\n` +
      `  Nothing further starts today. Queued requests keep their place and run tomorrow.\n` +
      `  Raise it for this run with USABILITY_LAB_DAILY_CEILING_USD.`
    );
  }
  return `Today's spend is ${money(v.spent)} of ${money(v.ceiling)}.`;
}
