import { checkClaim } from "./claims.js";
import type { Capture, Finding } from "./types.js";

/**
 * Whether an audit needs a person before a customer sees it.
 *
 * ## What changed, and what the number behind it is
 *
 * Until 2026-08-24 every first audit stopped at REVIEW_PENDING and waited for
 * the founder gate. That gate was not ceremonial: across 165 decisions it cut
 * 10 findings, and the reasons written beside them were not matters of taste.
 * They were counts stated as fact and wrong —
 *
 *     "the count is wrong: 50 identical 'Help' tooltips, not roughly 40"
 *     "the page has two join CTAs, not three (y=584 and y=5177)"
 *
 * — a true observation wrapped in a false quantity, which is the failure worth
 * a human. `claims.ts` catches that class mechanically, so the gate narrows to
 * where the capture can actually dispute what a finding says.
 *
 * ## Why only `contradicted`
 *
 * A `contradicted` verdict means a check the capture can disprove failed: the
 * element is absent, the tag is wrong, the measurement is invented, the quote
 * is not on the page. Inconclusive checks are deliberately not enough to hold
 * an audit — the count check has no precision record yet (B32) and the quote
 * check spent its first five flags being wrong all five times (B11). Neither
 * has earned the right to make a customer wait.
 *
 * ## What this is not
 *
 * It is not a quality score, and a clean result does not mean the findings are
 * good. It means nothing mechanical can show they are wrong about the page.
 * Usefulness is still a judgment and still nobody's but a person's — which is
 * why an auto-written `review.json` is marked `decided_by: "auto"` and kept out
 * of the corpus that measures it.
 */
export function disputedFindings(findings: Finding[], capture: Capture): Finding[] {
  return findings.filter((f) => checkClaim(f, capture).status === "contradicted");
}
