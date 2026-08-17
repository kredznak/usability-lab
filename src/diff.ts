import type { Capture, Finding } from "./types.js";

/**
 * What changed since last time — docs/design.md §1, the thing a subscription buys.
 *
 * "3 fixed, 1 new" is only worth printing if the matching underneath it is
 * trustworthy, and matching is the whole problem. This is deterministic code,
 * not an agent: six sub-agents only (CLAUDE.md), and a diff that reasons is a
 * diff that can hallucinate a fix.
 *
 * ## Why element refs cannot be part of the key
 *
 * `el_7` is positional. The capture selector re-runs against a page that has
 * changed, elements are ranked and truncated to a budget, and the seventh
 * element of Tuesday's capture is not the seventh of Friday's. Keying on refs
 * would report every finding as fixed-and-new the moment a nav item appeared.
 *
 * So a finding is identified by what it is *about*: the lane that raised it,
 * the principle it rests on, and the text of the thing it points at.
 */

/** Case, spacing and punctuation are noise; the words are the signal. */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/**
 * The subject of a finding: the visible text of the element it cites.
 *
 * Falls back to the accessible name, because a finding about an unnamed icon
 * button has no visible text and would otherwise key on the empty string —
 * collapsing every unlabelled-control finding on the page into one.
 */
export function subject(f: Finding, capture: Capture): string {
  if (!f.element_ref) return "";
  const el = capture.elements.find((e) => e.ref === f.element_ref);
  if (!el) return "";
  return normalize(el.text || el.accessible_name || "");
}

/**
 * A page-level finding has no element to point at, so its key is thinner and
 * it will match more loosely. That is stated here rather than hidden: two
 * different page-level observations under one heuristic look identical to this.
 */
export function findingKey(f: Finding, capture: Capture): string {
  return [f.agent, normalize(f.heuristic), subject(f, capture)].join("|");
}

export interface Side {
  findings: Finding[];
  capture: Capture;
}

export interface Diff {
  /** In the baseline, absent now. The page changed, or the reviewer did. */
  fixed: Finding[];
  /** Raised now, absent from the baseline. */
  added: Finding[];
  /** Matched on both sides. Carries the current wording, not the old. */
  unchanged: Finding[];
}

export function diffFindings(before: Side, after: Side): Diff {
  const beforeKeys = new Map<string, Finding>();
  for (const f of before.findings) {
    const key = findingKey(f, before.capture);
    // First wins. A duplicate key inside one audit means the key is too coarse
    // for that pair, not that the second finding is new.
    if (!beforeKeys.has(key)) beforeKeys.set(key, f);
  }

  const matched = new Set<string>();
  const added: Finding[] = [];
  const unchanged: Finding[] = [];

  for (const f of after.findings) {
    const key = findingKey(f, after.capture);
    if (beforeKeys.has(key) && !matched.has(key)) {
      matched.add(key);
      unchanged.push(f);
    } else if (beforeKeys.has(key)) {
      // Same key twice in the new set: the first took the match, so this one is
      // not evidence of a second surviving issue.
      unchanged.push(f);
    } else {
      added.push(f);
    }
  }

  const fixed = [...beforeKeys.entries()]
    .filter(([key]) => !matched.has(key))
    .map(([, f]) => f);

  return { fixed, added, unchanged };
}
