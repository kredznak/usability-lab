import type { Capture, CapturedElement } from "./types.js";

/**
 * Capture signals — the "page data" half of the spawn rules in docs/design.md §3.
 *
 * Pure, deterministic, zero tokens. The Orchestrator is allowed judgment about
 * *which* specialists to send; it is not allowed to invent facts about the page
 * to justify sending them. Everything a rule can cite about the capture is
 * computed here first, from measurements, and logged with the decision.
 *
 * Every threshold below was set by measuring the seven frozen fixtures rather
 * than by taste, and each has at least one fixture on each side of it. The
 * numbers in the comments are those measurements; if you move a threshold,
 * re-run `npm run signals` and move the comment too.
 */

export interface CaptureSignals {
  /** Fields a visitor actually fills in. Search boxes and buttons excluded. */
  form_fields: number;
  /** Two or more real fields: a form that asks for something, not a search box. */
  has_substantive_form: boolean;
  /** Fields whose only name is a placeholder, or which have no name at all. */
  unlabelled_fields: number;
  /** Interactive elements with neither visible text nor an accessible name. */
  unnamed_interactives: number;
  /** Those as a share of all interactive elements. A count alone scales with page size. */
  unnamed_interactive_share: number;
  /** Something concrete a WCAG reviewer would have to look at. */
  a11y_signal: boolean;
  /** Visible characters per viewport-screen of page. */
  copy_density: number;
  copy_dense: boolean;
  /** How many above-fold elements are set at (near) the largest type size. */
  competing_emphases: number;
  h1_count: number;
  /** Flat type scale above the fold, or a broken/absent h1. */
  hierarchy_signal: boolean;
  page_kind: PageKind;
  /** A page whose whole job is a goal action. */
  is_goal_page: boolean;
}

export type PageKind = "checkout" | "pricing" | "signup" | "landing" | "content";

/** input types that are not a question asked of the visitor. */
const NON_FIELD_INPUT = new Set(["search", "hidden", "submit", "button", "reset", "image"]);
const FIELD_TAGS = new Set(["input", "select", "textarea"]);
const INTERACTIVE_TAGS = new Set(["a", "button", "input", "select", "textarea"]);

/**
 * Two, not one. Every site on the web has a search box; a form that asks two
 * separate questions is one the visitor can abandon. Measured: checkout 9,
 * signup 5, hn 1 (its search field), everything else 0.
 */
const SUBSTANTIVE_FORM_FIELDS = 2;

/**
 * Characters of visible text per viewport-screen. Measured: hn 2967,
 * wikipedia 1688 | stripe_pricing 1273, stripe 973, govuk 722, signup 375.
 */
const COPY_DENSE_CHARS_PER_SCREEN = 1500;

/**
 * Elements within this fraction of the largest above-fold type size are
 * competing for the same attention rather than sitting below it in a hierarchy.
 */
const EMPHASIS_RATIO = 0.8;

/**
 * More than three things shouting at the same volume. Measured:
 * stripe_pricing 97, hn 59 | wikipedia 3, stripe 2, govuk 1, checkout 1, signup 1.
 */
const MAX_COMPETING_EMPHASES = 3;

/**
 * Unnamed interactive elements only mean something as a proportion. Four
 * unnamed icons among stripe_pricing's 324 interactives is housekeeping; 32
 * among hn's 231 is a page a screen-reader user cannot vote on. Measured share:
 * stripe 0.15, hn 0.14 | wikipedia 0.07, stripe_pricing 0.01, govuk 0, checkout 0.
 *
 * The absolute floor stops a tiny page with one unnamed icon out of four from
 * scoring 0.25 and spending a spawn slot on it.
 */
const UNNAMED_INTERACTIVE_SHARE = 0.1;
const UNNAMED_INTERACTIVE_FLOOR = 5;

function isField(e: CapturedElement): boolean {
  return FIELD_TAGS.has(e.tag) && !NON_FIELD_INPUT.has(e.input_type ?? "");
}

function isInteractive(e: CapturedElement): boolean {
  return INTERACTIVE_TAGS.has(e.tag) || e.role === "button" || e.role === "link";
}

/**
 * What kind of page this is, from the URL path and title. Keyword matching, and
 * honest about it: `landing` is the answer for a site root and `content` is the
 * fallback, so a wrong guess sends a generalist rather than a specialist.
 */
export function classifyPage(capture: Capture): PageKind {
  let pathname = "";
  try {
    pathname = new URL(capture.final_url).pathname.toLowerCase();
  } catch {
    pathname = capture.final_url.toLowerCase();
  }
  const haystack = `${pathname} ${capture.title.toLowerCase()}`;

  if (/checkout|\bcart\b|basket|payment|\bpay\b/.test(haystack)) return "checkout";
  if (/pricing|\bplans\b|subscribe|upgrade/.test(haystack)) return "pricing";
  if (/signup|sign-up|register|\bjoin\b|create.?account|free.?trial|get.?started/.test(haystack)) {
    return "signup";
  }
  if (pathname === "" || pathname === "/") return "landing";
  return "content";
}

export function deriveSignals(capture: Capture): CaptureSignals {
  const els = capture.elements;

  const fields = els.filter(isField);
  const unlabelledFields = fields.filter(
    (e) => e.name_source === null || e.name_source === "placeholder",
  );
  const interactives = els.filter(isInteractive);
  const unnamedInteractives = interactives.filter((e) => !e.text && !e.accessible_name);
  const unnamedShare =
    interactives.length === 0 ? 0 : unnamedInteractives.length / interactives.length;
  const manyUnnamed =
    unnamedInteractives.length >= UNNAMED_INTERACTIVE_FLOOR &&
    unnamedShare >= UNNAMED_INTERACTIVE_SHARE;

  const screens = Math.max(1, capture.full_height / capture.viewport.height);
  const copyDensity = capture.text_total_chars / screens;

  const aboveFoldText = els.filter((e) => e.above_fold && e.text && e.font_size > 0);
  const topFont = aboveFoldText.reduce((m, e) => Math.max(m, e.font_size), 0);
  const competing = aboveFoldText.filter((e) => e.font_size >= EMPHASIS_RATIO * topFont).length;

  const h1Count = els.filter((e) => e.tag === "h1").length;
  const pageKind = classifyPage(capture);

  return {
    form_fields: fields.length,
    has_substantive_form: fields.length >= SUBSTANTIVE_FORM_FIELDS,
    unlabelled_fields: unlabelledFields.length,
    unnamed_interactives: unnamedInteractives.length,
    unnamed_interactive_share: Math.round(unnamedShare * 100) / 100,
    // A field named only by its placeholder loses its name the moment the
    // visitor types into it — one is enough to be worth a look. Unnamed
    // interactives are graded on proportion instead, because every large site
    // has a few and a rule that fires everywhere routes nothing.
    a11y_signal: unlabelledFields.length > 0 || manyUnnamed,
    copy_density: Math.round(copyDensity),
    copy_dense: copyDensity > COPY_DENSE_CHARS_PER_SCREEN,
    competing_emphases: competing,
    h1_count: h1Count,
    // Exactly one h1 is the structure; zero or many is not a hierarchy at all.
    hierarchy_signal: competing > MAX_COMPETING_EMPHASES || h1Count !== 1,
    page_kind: pageKind,
    is_goal_page: pageKind === "checkout" || pageKind === "signup" || pageKind === "pricing",
  };
}
