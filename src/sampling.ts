import { createHash } from "node:crypto";

/**
 * 1-in-5 sampled review — docs/design.md §6, CLAUDE.md.
 *
 * Deterministic, and derived from the audit id rather than drawn at random, for
 * two reasons. A random draw cannot be tested: a suite that asserts "about a
 * fifth" either flakes or passes on a generator that has quietly become
 * 0-in-5, and 0-in-5 is the failure that matters — it looks exactly like
 * working software right up until nobody has read anything for a month.
 *
 * The second reason is that a re-run of the same audit must make the same
 * decision. Otherwise re-running is a way to shop for the answer where nobody
 * has to read it.
 */
export const SAMPLE_RATE = 5;

export function sampledForReview(auditId: string, rate = SAMPLE_RATE): boolean {
  // A hash, not `charCodeAt` — UUIDs share structure (version and variant
  // nibbles are fixed), so cheap arithmetic over their characters bunches up
  // in ways that are hard to see and easy to ship.
  const digest = createHash("sha256").update(auditId).digest();
  return digest.readUInt32BE(0) % rate === 0;
}
