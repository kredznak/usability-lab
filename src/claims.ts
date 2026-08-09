import type { Capture, Finding, RawFinding } from "./types.js";
import { normalize, pageSources, pageContains } from "./confidence.js";

/**
 * Mechanical truth-checking of a finding against the capture it came from.
 *
 * ## Why this exists, and what it is not
 *
 * `deriveConfidence()` proves an element EXISTS. It cannot prove a sentence
 * about that element is TRUE, and two live false positives went out at "high"
 * because of exactly that gap: a duplicated-headline claim about a real h1, and
 * a WCAG violation against a button that carries a correct aria-label.
 *
 * This module checks the three things a finding asserts that can be checked
 * without judgment:
 *
 *   1. the element it cites exists, and is the kind of element it says it is
 *   2. every substantial quoted string actually appears in the page's text
 *   3. every stated pixel measurement matches something we measured
 *
 * A `contradicted` verdict is the valuable one — it means the finding says
 * something the capture disproves. `verified` is weaker than it sounds: it
 * means nothing checkable is wrong, not that the finding is a good observation.
 * Whether a true statement is a *useful* one is a judgment call and stays with
 * a person (§10 assumes founder spot-checks).
 *
 * ## The limit worth stating plainly
 *
 * This checks a finding against the capture. When the CAPTURE is wrong, it
 * cannot help — the linear.app headline claim was consistent with a capture
 * that had itself picked up screen-reader-only text. Nothing downstream can
 * catch that, which is why capture correctness carries its own tests upstream.
 * What this does catch is the same claim re-checked against a correct capture,
 * which is how a fix gets proven and a regression gets caught.
 */

export type ClaimStatus = "verified" | "contradicted" | "unverifiable";

export interface ClaimCheck {
  kind: "element" | "tag" | "quote" | "measurement";
  ok: boolean;
  detail: string;
}

export interface ClaimVerdict {
  status: ClaimStatus;
  checks: ClaimCheck[];
  /** Every failed check, for the report. */
  contradictions: string[];
}

/** Pixel slack for rounding between measurement and prose. */
const PX_TOLERANCE = 2;

/** Shorter quoted runs are too easy to match by accident to be evidence. */
const MIN_QUOTE_LEN = 12;

/**
 * Quotation marks alternate, so the quoted spans are the odd segments of a
 * split. A regex scanning for open/close pairs instead matches the text
 * BETWEEN two quotations — on `"Benefits" (el_26 and el_96), "News"` it happily
 * reports ` (el_26 and el_96), ` as a quote that is not on the page. That one
 * mistake produced 14 of the first 15 contradictions this checker found, which
 * is a good illustration of why a noisy checker is worse than no checker: it
 * buries the two real failures in false alarms nobody will keep reading.
 *
 * Only double quotes. Apostrophes are far too common in ordinary prose
 * ("the page's header") to treat as quotation.
 */
function quotedSpans(s: string): string[] {
  const parts = s.split(/["“”]/);
  const spans: string[] = [];
  for (let i = 1; i < parts.length; i += 2) spans.push(parts[i] ?? "");
  return spans;
}

/**
 * Trailing punctuation belongs to the sentence quoting the page, not to the
 * page. Someone writing `reads "…services and information."` has added the full
 * stop themselves; treating that as a fabricated quote is pedantry, not rigour.
 */
function trimQuotePunctuation(s: string): string {
  return s.replace(/^[\s.,;:!?—–-]+|[\s.,;:!?—–-]+$/g, "");
}
const PAIR_PX_RE = /(\d[\d,]*)\s*(?:x|×)\s*(\d[\d,]*)\s*px/gi;
const SINGLE_PX_RE = /\b(\d[\d,]*)\s*px\b/gi;
const TAG_RE = /<([a-z][a-z0-9]*)>/gi;

function num(s: string): number {
  return Number(s.replace(/,/g, ""));
}

function near(a: number, b: number): boolean {
  return Math.abs(a - b) <= PX_TOLERANCE;
}

export function checkClaim(finding: RawFinding | Finding, capture: Capture): ClaimVerdict {
  const checks: ClaimCheck[] = [];
  const byRef = new Map(capture.elements.map((e) => [e.ref, e]));
  const text = `${finding.observation} ${finding.impact_note}`;

  // 1. The cited element exists.
  const cited = finding.element_ref ? byRef.get(finding.element_ref) : undefined;
  if (finding.element_ref) {
    checks.push({
      kind: "element",
      ok: Boolean(cited),
      detail: cited
        ? `cites ${finding.element_ref}, which exists`
        : `cites ${finding.element_ref}, which is not in the capture`,
    });
  }

  // 2. If it names a tag for the element it cites, that is the tag it has.
  //
  //    Attribution is the hard part. Taking the first tag in the sentence is
  //    wrong: "the combobox (el_15) has its name from an associated <label>
  //    (el_14)" is a true sentence that would be read as calling el_15 a label.
  //    So a tag only counts when it sits next to that element's own ref.
  if (cited) {
    for (const m of text.matchAll(TAG_RE)) {
      const tag = (m[1] ?? "").toLowerCase();
      const window = text.slice(Math.max(0, m.index - 40), m.index + 40);
      // Another element named closer than ours means the tag is describing that
      // one, not this one.
      const nearbyRefs = [...window.matchAll(/\bel_\d+\b/g)].map((r) => r[0]);
      if (nearbyRefs.length === 0 || !nearbyRefs.includes(cited.ref)) continue;
      if (nearbyRefs.some((r) => r !== cited.ref)) continue;

      // A negated tag names an element that is ABSENT, not the one we cite:
      // "the email field el_81 has no visible <label>" is a true sentence about
      // an input, and reading it as calling el_81 a label inverts its meaning.
      const before = text.slice(Math.max(0, m.index - 24), m.index);
      if (/\b(?:no|not|without|missing|lacks?|lacking|absent|never|associated)\s+\S*\s*$/i.test(before)) {
        continue;
      }

      checks.push({
        kind: "tag",
        ok: tag === cited.tag,
        detail:
          tag === cited.tag
            ? `calls ${cited.ref} a <${tag}>, which it is`
            : `calls ${cited.ref} a <${tag}>, but it is a <${cited.tag}>`,
      });
      break;
    }
  }

  // 3. Quoted page text is text the page contains — inside one source, never
  //    across the seam between two of them. See pageSources() for why.
  const sources = pageSources(capture);
  for (const span of quotedSpans(finding.observation)) {
    const quoted = normalize(trimQuotePunctuation(span));
    if (quoted.length < MIN_QUOTE_LEN) continue;
    // Accessible names are legitimately quotable — the Accessibility lane
    // quotes aria-labels, which are real page content a visitor never reads.
    const found = pageContains(sources, quoted);
    checks.push({
      kind: "quote",
      ok: found,
      detail: found
        ? `quotes "${span.slice(0, 60)}", which is on the page`
        : `quotes "${span.slice(0, 60)}", which is NOT on the page`,
    });
  }

  // 4. Stated measurements match something we actually measured. Checked
  //    against the whole capture, not just the cited element, because one
  //    sentence often compares several elements.
  const boxes = capture.elements.map((e) => ({
    w: Math.round(e.bbox.width),
    h: Math.round(e.bbox.height),
    font: e.font_size,
  }));

  for (const m of text.matchAll(PAIR_PX_RE)) {
    const w = num(m[1] ?? "");
    const h = num(m[2] ?? "");
    const found = boxes.some((b) => near(b.w, w) && near(b.h, h));
    checks.push({
      kind: "measurement",
      ok: found,
      detail: found
        ? `states ${w}x${h}px, which matches a measured element`
        : `states ${w}x${h}px, which matches no element in the capture`,
    });
  }

  // Singles are ambiguous — a font size, a dimension, or the page height — so
  // they pass if they match any of those. The check is against invention, not
  // imprecision.
  const singleCandidates = new Set<number>([
    Math.round(capture.full_height),
    capture.viewport.width,
    capture.viewport.height,
  ]);
  for (const b of boxes) {
    singleCandidates.add(b.w);
    singleCandidates.add(b.h);
    singleCandidates.add(b.font);
  }
  const singles = [...singleCandidates];

  for (const m of text.matchAll(SINGLE_PX_RE)) {
    // Skip anything already consumed as half of a WxH pair.
    if (/(?:x|×)\s*$/i.test(text.slice(Math.max(0, m.index - 3), m.index))) continue;
    const v = num(m[1] ?? "");
    const found = singles.some((c) => near(c, v));
    checks.push({
      kind: "measurement",
      ok: found,
      detail: found
        ? `states ${v}px, which matches a measured value`
        : `states ${v}px, which matches nothing we measured`,
    });
  }

  // 5. Accessibility name claims. Added because this is the exact shape of the
  //    second live false positive — "no accessible name" asserted about a
  //    correctly aria-labelled button — and because it is one of the few
  //    semantic claims we hold the ground truth for.
  //
  //    This can misfire on a sentence that contrasts two elements ("el_15 has a
  //    label, unlike el_9"). That is acceptable: a contradiction routes the
  //    finding to a person, it never deletes it.
  //
  //    The phrase list is deliberately narrow. A looser negation pattern also
  //    fired on "el_9 shows a label, while el_10 shows no visible text" — a true
  //    sentence about visible text, not about naming. "No visible text" is not
  //    a naming claim and must not be read as one.
  //    Tested against the observation alone, never the impact note. §9 makes
  //    the observation the literal claim and the impact note interpretation —
  //    and a note reasoning about "the unlabelled control" was enough to
  //    contradict a finding whose observation quoted the correct aria-label.
  const obs = finding.observation;
  const claimsUnnamed =
    /\b(?:no|without an?|lacks an?|missing an?|has no)\s+(?:accessible|programmatic)\s+name\b/i.test(obs) ||
    /\bno\s+accessible\s+(?:text|label)\b/i.test(obs) ||
    /\b(?:unlabell?ed|no\s+label\b|missing\s+labels?\b)/i.test(obs);

  //    A finding that states the element's actual accessible name knows it has
  //    one; whatever it is arguing, it is not claiming the name is absent.
  const quotesTheName = Boolean(
    cited?.accessible_name && normalize(obs).includes(normalize(cited.accessible_name)),
  );

  if (cited && claimsUnnamed && !quotesTheName) {
    const named = Boolean(cited.accessible_name);
    checks.push({
      kind: "element",
      ok: !named,
      detail: named
        ? `says ${cited.ref} has no accessible name, but it is named "${cited.accessible_name}" via ${cited.name_source}`
        : `says ${cited.ref} has no accessible name, and it has none`,
    });
  }

  const contradictions = checks.filter((c) => !c.ok).map((c) => c.detail);
  const status: ClaimStatus =
    contradictions.length > 0 ? "contradicted" : checks.length > 0 ? "verified" : "unverifiable";

  return { status, checks, contradictions };
}

/**
 * A capture-level invariant, not a finding check.
 *
 * An element whose visible text is one string repeated back to back is the
 * signature of the screen-reader-only duplicate that produced our first false
 * positive. Catching it here catches the bug at its source, where a downstream
 * check provably cannot.
 */
export function repeatedTextElements(capture: Capture, minHalf = 20): string[] {
  const offenders: string[] = [];
  for (const e of capture.elements) {
    const t = normalize(e.text);
    if (t.length < minHalf * 2) continue;
    // Exact back-to-back repetition, with or without a separating space.
    const half = Math.floor(t.length / 2);
    const a = t.slice(0, half).trim();
    const b = t.slice(t.length - half).trim();
    if (a.length >= minHalf && a === b) offenders.push(e.ref);
  }
  return offenders;
}
