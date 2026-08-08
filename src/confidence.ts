import type { BBox, Capture, CapturedElement, RawFinding } from "./types.js";

/**
 * docs/design.md §9.1 — confidence is derived, not declared.
 *
 *   high   = screenshot-verified: the finding names a captured element that has
 *            a real, non-degenerate box on the page we actually rendered.
 *   medium = inferred from page text: no element, but the observation quotes
 *            text that genuinely appears in the capture.
 *   drop   = anything weaker. Not hedged, not downgraded — excluded (§3 of
 *            quality-bar.md: "uncertainty is communicated by withholding").
 *
 * This is a pure function of (finding, capture). No model call, no I/O, no
 * randomness — so it is trivially testable and cannot drift with a prompt.
 */

export type ConfidenceVerdict =
  | { kind: "keep"; confidence: "high" | "medium"; bbox: BBox | null; reason: string }
  | { kind: "drop"; reason: string };

/** A box smaller than this in either dimension is a rendering artifact, not an element. */
const MIN_BOX_PX = 4;

/** Shortest quoted run we will accept as evidence that text came from the page. */
const MIN_QUOTE_LEN = 12;

function isRealBox(b: BBox): boolean {
  return b.width >= MIN_BOX_PX && b.height >= MIN_BOX_PX;
}

function normalize(s: string): string {
  return s.toLowerCase().replace(/[‘’“”]/g, "'").replace(/\s+/g, " ").trim();
}

/**
 * Does the observation quote something that is actually on the page?
 * We look for quoted spans first (the prompt asks the agent to quote), and
 * fall back to checking whether any long-enough sentence appears verbatim.
 */
function quotesPageText(observation: string, capture: Capture): boolean {
  const haystack = normalize(
    capture.text_excerpt + " " + capture.elements.map((e) => e.text).join(" "),
  );

  const quoted = observation.match(/["“']([^"”']{12,})["”']/g) ?? [];
  for (const q of quoted) {
    const inner = normalize(q.slice(1, -1));
    if (inner.length >= MIN_QUOTE_LEN && haystack.includes(inner)) return true;
  }
  return false;
}

export function deriveConfidence(finding: RawFinding, capture: Capture): ConfidenceVerdict {
  const byRef = new Map<string, CapturedElement>(capture.elements.map((e) => [e.ref, e]));

  if (finding.element_ref !== null) {
    const el = byRef.get(finding.element_ref);
    if (!el) {
      // The agent named an element that does not exist in the capture. That is
      // a fabrication about the page, so it fails the truth check outright —
      // it does not get to fall through to a text-inferred medium.
      return {
        kind: "drop",
        reason: `element_ref '${finding.element_ref}' not present in capture`,
      };
    }
    if (!isRealBox(el.bbox)) {
      return { kind: "drop", reason: `element '${el.ref}' has no renderable box` };
    }
    return {
      kind: "keep",
      confidence: "high",
      bbox: el.bbox,
      reason: `screenshot-verified on element '${el.ref}'`,
    };
  }

  if (quotesPageText(finding.observation, capture)) {
    return {
      kind: "keep",
      confidence: "medium",
      bbox: null,
      reason: "inferred from quoted page text",
    };
  }

  return { kind: "drop", reason: "no element evidence and no verifiable quote from the page" };
}
