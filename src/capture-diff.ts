import type { Capture, CapturedElement } from "./types.js";

/**
 * What changed on the page — docs/design.md §1's monitoring promise, moved onto
 * evidence that can carry it.
 *
 * ## Why this and not a finding diff
 *
 * Measured 2026-08-17 (B15): the same page audited three times, reviewers
 * pinned to the same lanes, produced 14 / 12 / 15 findings, of which 6 appeared
 * every time and 7 appeared once. A finding diff on an unchanged page reports
 * 2-5 fixed and 2-5 new — "3 fixed, 1 new" is inside its own noise.
 *
 * The capture is not like that. Three captures each of basecamp, cotopaxi and
 * linear/pricing, minutes apart:
 *
 *     identical text, identical title, identical height, identical elements
 *
 * Zero. So a claim about the page is a claim we can support, and a claim about
 * whether the page got *better* is not — which is why this reports change and
 * says nothing about improvement.
 *
 * It has a second property no finding diff can have: **it does not care that we
 * changed our own pipeline.** basecamp's tool-tile finding vanished this week
 * because we fixed a capture bug, and a finding diff would have reported that
 * as the customer's improvement. This compares two pages.
 */

/** Interactive tags — the things a visitor can act on, per §5's selector. */
const INTERACTIVE = ["a", "button", "input", "select", "textarea"];
const HEADING = ["h1", "h2", "h3"];

const MONTHS =
  /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b|\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/;

export function label(e: CapturedElement): string {
  return (e.text || e.accessible_name || "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * The shape of a string, for spotting a list that rotates rather than changes.
 *
 * basecamp's live-class links roll forward every week: seven of the twelve
 * differences over six days were "aug 12 intro to basecamp" becoming "aug 19
 * intro to basecamp". Reporting those as eight removals and four additions
 * buries the one that mattered — "Try Basecamp free" had gone.
 *
 * **Digits are blurred only inside text that already looks like a date.** The
 * tempting version of this rule normalises every number, and it would hide
 * `$99 -> $129` on a pricing page, which is the most important change this
 * whole feature exists to catch. A month or weekday name has to be present
 * before any digit is touched.
 */
export function shape(text: string): string {
  if (!MONTHS.test(text)) return text;
  // Sentinels, because the obvious version rewrites "<month>" into "<<day>>":
  // "month" starts with "mon". A replacement that can be re-matched by a later
  // pass is a bug waiting for the right input, and this was that input.
  // Placeholders are uppercase and the patterns above are lowercase-only, so a
  // replacement cannot be re-matched by a later pass. The obvious version of
  // this rewrote "<month>" into "<<day>>", because "month" starts with "mon".
  return text
    .replace(/\b\d{1,2}(:\d{2})?\s*[ap]\.?m\.?\b/g, "<TIME>")
    .replace(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/g, "<MONTH>")
    .replace(/\b(mon|tue|wed|thu|fri|sat|sun)[a-z]*\b/g, "<DAY>")
    .replace(/\d+/g, "#");
}

export interface Item {
  tag: string;
  label: string;
}

export interface Change<T> {
  added: T[];
  removed: T[];
}

export interface CaptureDiff {
  title: { before: string; after: string } | null;
  final_url: { before: string; after: string } | null;
  /** Things a visitor can act on. The headline class. */
  interactive: Change<Item>;
  headings: Change<Item>;
  /** Form fields, keyed by type and name — a signup gaining a field is news. */
  fields: Change<Item>;
  /** Lists that rolled forward rather than changed. Reported, quietly. */
  rotated: { shape: string; count: number; added: number; removed: number }[];
  /** Context, never a headline: a page can grow without anything mattering. */
  height_px: { before: number; after: number } | null;
  text_chars: { before: number; after: number } | null;
  /**
   * Why this diff cannot be read as complete. Empty means it can.
   *
   * B8's lesson in a new place: an input that truncates in silence gets read as
   * evidence of absence. If either capture hit the element budget, an item can
   * disappear from this list by not being sampled, and no removal here is safe
   * to report as a removal.
   */
  partial: string[];
}

function counts(items: Item[]): Map<string, { item: Item; n: number }> {
  const m = new Map<string, { item: Item; n: number }>();
  for (const item of items) {
    const k = `${item.tag}|${item.label}`;
    const seen = m.get(k);
    if (seen) seen.n += 1;
    else m.set(k, { item, n: 1 });
  }
  return m;
}

/**
 * Multiset difference, because elements have no identity across captures.
 *
 * `el_7` is positional — the selector re-runs, the budget re-ranks, and the
 * seventh element of Tuesday's capture is not Friday's. Counting content and
 * diffing the counts asks a question the data can answer; tracking individuals
 * would be inventing one.
 */
function diffItems(before: Item[], after: Item[]): Change<Item> {
  const a = counts(before);
  const b = counts(after);
  const added: Item[] = [];
  const removed: Item[] = [];

  for (const [k, { item, n }] of b) {
    const missing = n - (a.get(k)?.n ?? 0);
    for (let i = 0; i < missing; i++) added.push(item);
  }
  for (const [k, { item, n }] of a) {
    const gone = n - (b.get(k)?.n ?? 0);
    for (let i = 0; i < gone; i++) removed.push(item);
  }
  return { added, removed };
}

/**
 * Pulls rotations out of a change.
 *
 * A shape that appears on *both* sides is a list rolling forward, not items
 * arriving and leaving. basecamp's live classes moved six out and three in over
 * six days; itemised, that is nine lines burying the one that mattered ("Try
 * Basecamp free" had gone). Grouped, it is one line that says the class list
 * turned over, with the counts kept so a list that shrank still says so.
 *
 * Pairing them off one-to-one was the first attempt and it was worse: the
 * leftovers came back as ordinary additions and removals, which reads as though
 * three specific classes were cancelled.
 */
function extractRotations(change: Change<Item>): {
  change: Change<Item>;
  rotated: { shape: string; count: number; added: number; removed: number }[];
} {
  const byShape = new Map<string, { added: Item[]; removed: Item[] }>();
  for (const item of change.added) {
    const s = `${item.tag}|${shape(item.label)}`;
    (byShape.get(s) ?? byShape.set(s, { added: [], removed: [] }).get(s)!).added.push(item);
  }
  for (const item of change.removed) {
    const s = `${item.tag}|${shape(item.label)}`;
    (byShape.get(s) ?? byShape.set(s, { added: [], removed: [] }).get(s)!).removed.push(item);
  }

  const added: Item[] = [];
  const removed: Item[] = [];
  const rotated: { shape: string; count: number; added: number; removed: number }[] = [];

  for (const [s, { added: a, removed: r }] of byShape) {
    // Both sides present: the list turned over. One side only: something really
    // did arrive or leave, and it keeps its own line.
    if (a.length > 0 && r.length > 0) {
      rotated.push({
        shape: s.split("|").slice(1).join("|"),
        count: Math.min(a.length, r.length),
        added: a.length,
        removed: r.length,
      });
      continue;
    }
    added.push(...a);
    removed.push(...r);
  }
  return { change: { added, removed }, rotated };
}

const itemsOf = (c: Capture, tags: string[]): Item[] =>
  c.elements
    .filter((e) => tags.includes(e.tag))
    .map((e) => ({ tag: e.tag, label: label(e) }))
    .filter((i) => i.label !== "");

export function diffCaptures(before: Capture, after: Capture): CaptureDiff {
  const partial: string[] = [];
  for (const [side, c] of [
    ["before", before],
    ["after", after],
  ] as const) {
    if (c.elements_total > c.elements.length) {
      partial.push(
        `the ${side} capture sampled ${c.elements.length} of ${c.elements_total} elements, ` +
          `so an item can be absent here without being absent from the page`,
      );
    }
  }

  const interactiveRaw = diffItems(itemsOf(before, INTERACTIVE), itemsOf(after, INTERACTIVE));
  const { change: interactive, rotated } = extractRotations(interactiveRaw);

  const fieldsOf = (c: Capture): Item[] =>
    c.elements
      .filter((e) => e.tag === "input" || e.tag === "select" || e.tag === "textarea")
      .map((e) => ({ tag: `${e.tag}${e.input_type ? `[${e.input_type}]` : ""}`, label: label(e) }));

  return {
    title: before.title === after.title ? null : { before: before.title, after: after.title },
    final_url:
      before.final_url === after.final_url
        ? null
        : { before: before.final_url, after: after.final_url },
    interactive,
    headings: diffItems(itemsOf(before, HEADING), itemsOf(after, HEADING)),
    fields: diffItems(fieldsOf(before), fieldsOf(after)),
    rotated,
    height_px:
      Math.round(before.full_height) === Math.round(after.full_height)
        ? null
        : { before: Math.round(before.full_height), after: Math.round(after.full_height) },
    text_chars:
      before.text_total_chars === after.text_total_chars
        ? null
        : { before: before.text_total_chars, after: after.text_total_chars },
    partial,
  };
}

/** True when nothing worth telling anyone about changed. Rotation is not change. */
export function isQuiet(d: CaptureDiff): boolean {
  return (
    d.title === null &&
    d.final_url === null &&
    d.interactive.added.length === 0 &&
    d.interactive.removed.length === 0 &&
    d.headings.added.length === 0 &&
    d.headings.removed.length === 0 &&
    d.fields.added.length === 0 &&
    d.fields.removed.length === 0
  );
}
