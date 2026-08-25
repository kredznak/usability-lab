import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Capture, Finding, type CapturedElement } from "./types.js";
import { renderPublic, renderResults, locationLine, FREE_FINDINGS, type RenderInput, publicHtml } from "./render.js";
import { deriveSignals } from "./signals.js";

/**
 * The visitor's page is the only artifact a customer ever sees, and its riskiest
 * sentence is the one counting what we held back. If that number drifts from the
 * truth we are misrepresenting the thing we charge for, and no other test in the
 * suite is looking at it.
 */

function element(over: Partial<CapturedElement> = {}): CapturedElement {
  return {
    ref: "el_1",
    tag: "button",
    role: null,
    text: "",
    bbox: { x: 0, y: 0, width: 61, height: 61 },
    above_fold: true,
    input_type: null,
    accessible_name: null,
    name_source: null,
    font_size: 16,
    ...over,
  };
}

function capture(elements: CapturedElement[] = []): Capture {
  return Capture.parse({
    audit_id: "test",
    url: "https://example.com",
    final_url: "https://example.com/",
    title: "Example",
    screenshot_id: "s",
    screenshot_path: "out/s.png",
    viewport: { width: 1440, height: 900 },
    full_height: 2000,
    elements,
    elements_total: elements.length,
    text_excerpt: "",
    text_total_chars: 0,
    captured_at: "2026-01-01T00:00:00.000Z",
  });
}

function finding(n: number, severity: number, over: Partial<Finding> = {}): Finding {
  return Finding.parse({
    heuristic: `Heuristic ${n}`,
    severity,
    element_ref: null,
    observation: `Observation ${n}`,
    impact_note: `Impact ${n}`,
    positive: false,
    id: `f${n}`,
    agent: "heuristics",
    screen_ref: "s",
    confidence: "high",
    citation: { source_type: "none", url: null },
    evidence: { screenshot_id: "s", bbox: null },
    ...over,
  });
}

/**
 * `allFindings` defaults to `kept` because most of these tests publish
 * everything. The pin tests pass it explicitly, which is the case that matters:
 * pin numbers are positions in the array the screenshot was drawn from, so a
 * cut finding still uses up its number.
 */
async function publish(
  kept: Finding[],
  opts: {
    capture?: Capture;
    allFindings?: Finding[];
    corrections?: { at: string; reason: string }[];
  } = {},
): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "ulab-render-"));
  try {
    const out = await renderPublic(
      {
        capture: opts.capture ?? capture(),
        kept,
        allFindings: opts.allFindings ?? kept,
        annotatedImage: path.join(dir, "a.png"),
        summary: "A review of this page.",
        corrections: opts.corrections,
      },
      dir,
    );
    return readFileSync(out, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the visitor's page: what it shows and what it admits to hiding", () => {
  /**
   * The published file gets nothing it cannot use.
   *
   * `results.html` on disk has no form to post and no session to post it with,
   * so it gets neither the offer markup nor a byte of the CSS for it. This is a
   * standing guard against a mistake already made once: the email gate's rules
   * were spliced into the shared stylesheet unconditionally, and the claim
   * "the artifact is byte-identical" was made about a file that had grown ten
   * lines. Optional features that render nothing must also style nothing.
   */
  test("the published artifact carries no subscribe markup and no CSS for it", async () => {
    const html = await publish([1, 2, 3, 4].map((n) => finding(n, 2)));
    assert.doesNotMatch(html, /class="offer"/);
    assert.doesNotMatch(html, /\.offer \{/);
    assert.doesNotMatch(html, /name="csrf"/);
    assert.doesNotMatch(html, /Keep watching this page/);
  });

  test("shows three issues and no more, however many were kept", async () => {
    const html = await publish([1, 2, 3, 4, 5, 6, 7].map((n) => finding(n, 2)));
    for (const n of [1, 2, 3]) {
      assert.match(html, new RegExp(`Observation ${n}<`), `finding ${n} should be shown`);
    }
    for (const n of [4, 5, 6, 7]) {
      assert.doesNotMatch(html, new RegExp(`Observation ${n}<`), `finding ${n} must be withheld`);
    }
  });

  test("the withheld count is the real number, not the page's finding count", async () => {
    const html = await publish([1, 2, 3, 4, 5, 6, 7].map((n) => finding(n, 2)));
    assert.match(html, /4 more findings/);
    assert.match(html, /found 7 issues on this page/);
  });

  test("rank decides what is free, not raw severity", async () => {
    // The Synthesizer ranked the severity 4 last — it weighs fixability and the
    // visitor's stated concern, which raw severity cannot see. Selecting by
    // severity here would discard that judgment.
    const kept = [finding(1, 2), finding(2, 2), finding(3, 2), finding(4, 4)];
    const html = await publish(kept);
    assert.doesNotMatch(html, /Observation 4</, "rank 4 is withheld even at severity 4");
    assert.match(html, /1 more finding\b/);
    assert.doesNotMatch(html, /1 more findings/, "singular when one is held back");
  });

  test("withholding a severe finding is admitted in the same breath", async () => {
    // The honest half of the rule above: if rank withholds something severe,
    // the page says so rather than letting the reader assume filler.
    const html = await publish([finding(1, 2), finding(2, 2), finding(3, 2), finding(4, 4)]);
    assert.match(html, /1 of the 1 held back is severity 3 or higher/);
  });

  test("within the three shown, the most severe leads", async () => {
    const html = await publish([finding(1, 2), finding(2, 4), finding(3, 1), finding(4, 2)]);
    const order = [...html.matchAll(/Observation (\d)</g)].map((m) => m[1]);
    assert.deepEqual(order, ["2", "1", "3"], "severity orders presentation, rank chose the set");
  });

  test("the withheld line states how severe the held-back findings are", async () => {
    const severe = await publish([
      finding(1, 4),
      finding(2, 4),
      finding(3, 4),
      finding(4, 3),
      finding(5, 3),
    ]);
    assert.match(severe, /2 of the 2 held back are severity 3 or higher/);

    const mild = await publish([finding(1, 4), finding(2, 4), finding(3, 4), finding(4, 1)]);
    assert.match(mild, /None of the 1 held back is above severity 2/);
  });

  test("with three or fewer findings there is no withhold notice at all", async () => {
    const html = await publish([finding(1, 3), finding(2, 2)]);
    assert.doesNotMatch(html, /more finding/);
    assert.doesNotMatch(html, /held back/);
  });

  test("positives never occupy one of the three free slots", async () => {
    const kept = [
      finding(1, 1, { positive: true }),
      finding(2, 2),
      finding(3, 2),
      finding(4, 2),
      finding(5, 2),
    ];
    const html = await publish(kept);
    for (const n of [2, 3, 4]) {
      assert.match(html, new RegExp(`Observation ${n}<`), `issue ${n} should be shown`);
    }
    assert.match(html, /found 4 issues on this page/, "positives are not counted as issues");
    assert.match(html, /Observation 1</, "the positive still appears, in its own section");
  });

  test("FREE_FINDINGS is what the page actually honours", async () => {
    const html = await publish(Array.from({ length: 9 }, (_, i) => finding(i + 1, 2)));
    const shown = [...html.matchAll(/class="observation"/g)].length;
    assert.equal(shown, FREE_FINDINGS);
  });
});

describe("locationLine: a founder should not need devtools", () => {
  const cap = capture([
    element({ ref: "el_19", tag: "a", text: "SHOP MEN", above_fold: true }),
    element({ ref: "el_81", tag: "input", text: "", accessible_name: "Email Address" }),
    element({ ref: "el_0", tag: "button", text: "", above_fold: false }),
  ]);

  test("names the element by its visible text and keeps the ref", () => {
    const line = locationLine(finding(1, 2, { element_ref: "el_19" }), cap);
    assert.match(line, /“SHOP MEN”/);
    assert.match(line, /<a>/);
    assert.match(line, /above the fold/);
    assert.match(line, /\(el_19\)/, "the ref stays — it is what makes the finding checkable");
  });

  test("falls back to the accessible name when there is no visible text", () => {
    const line = locationLine(finding(1, 2, { element_ref: "el_81" }), cap);
    assert.match(line, /“Email Address”/);
  });

  test("says so plainly when an element has no name of any kind", () => {
    const line = locationLine(finding(1, 2, { element_ref: "el_0" }), cap);
    assert.match(line, /unlabelled <button>/);
    assert.match(line, /below the fold/);
  });

  test("a page-level finding says it is page-level rather than inventing a location", () => {
    assert.match(locationLine(finding(1, 2), cap), /Page-level/);
  });

  test("a ref that is not in the capture is reported, not rendered as if fine", () => {
    const line = locationLine(finding(1, 2, { element_ref: "el_999" }), cap);
    assert.match(line, /not present in the capture/);
  });
});

/**
 * The published basecamp page shipped with three cards badged "2", "2", "2" —
 * severity — under a caption promising each finding pointed at something on the
 * screenshot, which is pinned 1..n. Nothing connected a card to a pin.
 */
describe("pin numbers: the card and the screenshot agree", () => {
  const boxed = (n: number, severity = 2) =>
    finding(n, severity, { evidence: { screenshot_id: "s", bbox: { x: 1, y: 1, width: 9, height: 9 } } });

  test("the badge is the pin number, not the severity", async () => {
    const html = await publish([boxed(1, 4)]);
    assert.match(html, /class="sev sev-4">1</, "badge shows pin 1, coloured by severity 4");
    assert.match(html, /severity 4/, "severity is still stated, in words");
  });

  test("pin numbers survive the findings the founder cut", async () => {
    // Four findings drawn on the screenshot as 1,2,3,4; the founder cuts 1 and 2.
    const all = [1, 2, 3, 4].map((n) => boxed(n));
    const html = await publish([all[2]!, all[3]!], { allFindings: all });
    assert.match(html, /class="sev sev-2">3</, "the third finding keeps pin 3");
    assert.match(html, /class="sev sev-2">4</, "the fourth keeps pin 4");
    assert.doesNotMatch(html, /class="sev sev-2">1</, "renumbering from 1 would point at the wrong box");
  });

  test("a finding with no bbox has no pin, and the caption says why", async () => {
    const html = await publish([finding(1, 2)]);
    assert.match(html, /class="sev sev-2">&mdash;</, "no box means no number, not a made-up one");
    assert.match(html, /carry no pin/, "the caption must account for the dash");
  });

  test("the caption claims only what the page can back", async () => {
    const html = await publish([boxed(1)]);
    assert.doesNotMatch(
      html,
      /Every finding below points at something on this screenshot/,
      "false for any text-inferred finding",
    );
  });
});

test("a kept finding that is not in allFindings is a crash, not a wrong pin", async () => {
  // The coupling renderPublic cannot check in the type system: pin numbers are
  // only meaningful if allFindings is the array annotate drew from. A caller who
  // filters first would produce a page pointing at the wrong boxes, and a wrong
  // number looks exactly like a right one.
  const all = [1, 2, 3].map((n) => finding(n, 2));
  await assert.rejects(
    () => publish([finding(9, 2)], { allFindings: all }),
    /is not in allFindings/,
  );
});

/**
 * The page the founder reads at the gate. Until now it had no test at all,
 * which is how it acquired a severity re-sort that put it out of step with
 * `npm run review` and `npm run outcome`.
 */
describe("the internal review copy", () => {
  const boxed = (n: number, severity = 2) =>
    finding(n, severity, { evidence: { screenshot_id: "s", bbox: { x: 1, y: 1, width: 9, height: 9 } } });

  async function full(findings: Finding[], over: Partial<RenderInput> = {}): Promise<string> {
    const dir = mkdtempSync(path.join(tmpdir(), "ulab-full-"));
    const cap = capture();
    try {
      const out = await renderResults(
        {
          capture: cap,
          findings,
          dropped: [],
          annotatedImage: path.join(dir, "a.png"),
          timings: [{ step: "capture", ms: 1000 }],
          costUsd: 0.34,
          profile: {
            site_kind: "other",
            concerns: ["abandonment"],
            goal: "purchase",
            drop_point: "final_step",
            summary: "A shop that sells things.",
          },
          signals: deriveSignals(cap),
          plan: {
            spawn: ["heuristics"],
            fired: [],
            dropped: [],
            rationale: "One reviewer was enough.",
            override_rejected: null,
            latencyMs: 10,
            costUsd: 0.01,
          },
          synthesis: {
            merged: [],
            excluded: [],
            rejected: [],
            degraded: null,
            latencyMs: 10,
            costUsd: 0.02,
          },
          degraded: [],
          ...over,
        },
        dir,
      );
      return readFileSync(out, "utf8");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("shows every finding, not the visitor's three", async () => {
    const html = await full([1, 2, 3, 4, 5, 6, 7].map((n) => finding(n, 2)));
    for (const n of [1, 2, 3, 4, 5, 6, 7]) {
      assert.match(html, new RegExp(`Observation ${n}<`), `finding ${n} must be on the gate page`);
    }
    assert.match(html, /What we found \(7\)/);
  });

  test("keeps the Synthesizer's rank order, so the page and the terminal agree", async () => {
    // A severity 4 ranked last stays last. `npm run review` walks findings.json
    // in this order and `npm run outcome` scores rank against those calls —
    // re-sorting here would mean judging one order while reading another.
    const html = await full([finding(1, 2), finding(2, 1), finding(3, 4)]);
    const order = [...html.matchAll(/Observation (\d)</g)].map((m) => m[1]);
    assert.deepEqual(order, ["1", "2", "3"]);
  });

  test("pins match the numbers annotate drew, gaps and all", async () => {
    // Finding 2 has no bbox, so it takes its number out of circulation: the
    // third finding is pin 3 on the image, not pin 2.
    const html = await full([boxed(1), finding(2, 2), boxed(3)]);
    const pins = [...html.matchAll(/class="pin">([^<]*)</g)].map((m) => m[1]);
    assert.deepEqual(pins, ["1", "—", "3"]);
  });

  test("positives are shown but do not count as issues", async () => {
    const html = await full([finding(1, 2), finding(2, 1, { positive: true })]);
    assert.match(html, /What we found \(1\)/);
    assert.match(html, /What's working \(1\)/);
  });

  test("what the Synthesizer set aside is on the page, with its reason", async () => {
    // The audit showing its own work is the thing we sell against being taken
    // on faith — and these exclusions are invisible to every metric we compute.
    const html = await full([finding(1, 2)], {
      synthesis: {
        merged: [],
        excluded: [{ id: "x1", agent: "a11y", reason: "not relevant to the stated concern" }],
        rejected: [],
        degraded: null,
        latencyMs: 10,
        costUsd: 0.02,
      },
    });
    assert.match(html, /not relevant to the stated concern/);
  });

  test("a degraded run says so on the page, not just in the log", async () => {
    const html = await full([finding(1, 2)], { degraded: ["forms: timed out"] });
    assert.match(html, /ran degraded/);
    assert.match(html, /forms: timed out/);
  });

  /**
   * The footer used to tell every reader "Research and citations are not
   * built". That was true when it was written and went quietly false the day
   * citations shipped — so ghost.org/pricing rendered nine resolving sources
   * above a sentence denying they existed, on the page a customer pays for.
   *
   * A hardcoded claim about what the system does cannot stay true on its own.
   * These tests make the footer count what is actually on the page.
   */
  const sourced = (n: number) =>
    finding(n, 2, { citation: { source_type: "paper", url: "https://www.nngroup.com/articles/x/" } });

  test("the footer never denies citations the page is already showing", async () => {
    const html = await full([sourced(1), finding(2, 2)]);
    assert.doesNotMatch(
      html,
      /citations are not built/i,
      "the page shows a resolving source; saying otherwise makes the page contradict itself",
    );
  });

  test("the footer counts the sourced findings and the ones standing on our own evaluation", async () => {
    const html = await full([sourced(1), sourced(2), finding(3, 2)]);
    assert.match(html, /2 of the 3 findings/i, "must state how many carry a source");
    assert.match(html, /other 1/i, "must state how many do not, rather than leaving it implied");
  });

  test("a page with no sourced finding says that plainly, without denying the system exists", async () => {
    const html = await full([finding(1, 2), finding(2, 2)]);
    assert.match(html, /none of the 2 findings/i);
    assert.doesNotMatch(html, /citations are not built/i);
  });

});

/**
 * The evidence has to be visible on the finding that has it.
 *
 * notion.com/pricing was published on 2026-08-17 with three resolved citations
 * and displayed none of them: all three sat on positive findings, and the
 * positive card rendered the heuristic and observation only. Meanwhile the
 * footer told the reader that findings without a source say so — true of every
 * visible issue on that page, and quietly false of the positives.
 */
describe("citations appear on the findings that carry them", () => {
  const cited = (n: number, over: Partial<Finding> = {}) =>
    finding(n, 1, {
      positive: true,
      citation: { source_type: "paper", url: "https://www.nngroup.com/articles/x/" },
      ...over,
    });

  test("a cited positive shows its source, and links to it", async () => {
    const html = await publish([finding(1, 3), cited(2)]);
    assert.match(html, /What&#39;s already working|What's already working/);
    assert.match(html, /https:\/\/www\.nngroup\.com\/articles\/x\//);
  });

  test("an uncited positive says so rather than staying silent", async () => {
    // Scoped to the positive card on purpose. Asserting on the whole page
    // matched text coming from an issue card and passed with this fix reverted
    // — a test that agrees with any implementation.
    const html = await publish([finding(1, 3), finding(2, 1, { positive: true })]);
    const card = html.slice(html.indexOf(`<div class="positive">`));
    assert.match(card, /Based on our evaluation/);
  });

  test("a citation on a withheld issue is not leaked onto the page", async () => {
    // The free three are what a visitor sees. A source attached to a finding
    // they have not been shown must not appear, or the page implies evidence
    // for a claim it never made.
    const shown = [finding(1, 3), finding(2, 3), finding(3, 3)];
    const withheld = finding(4, 4, {
      citation: { source_type: "paper", url: "https://example.test/secret-source" },
    });
    const html = await publish([...shown, withheld]);
    assert.doesNotMatch(html, /secret-source/);
  });
});

/**
 * A citation has to name something a reader can recognise.
 *
 * `Finding.citation` carries `{source_type, url}`, and `source_type` is a kind
 * — "paper", "none" — not a name. The renderer used it as the link text, so
 * every citation on every published page read `<a href="...">paper</a>`. Three
 * of them on ghost.org/pricing, six on our own audit: a product that sells
 * evidence-backed findings showing the reader a link called "paper".
 *
 * The id never reaches the renderer, but the URL does, and all 28 SOURCES urls
 * are distinct — so the URL is enough to recover the publisher and title.
 */
describe("a citation names its source, not its file type", () => {
  const REAL = "https://www.nngroup.com/articles/better-link-labels/";

  /** The `.citation` line only — the lesson from the positives test above. */
  const citationLines = (html: string) =>
    [...html.matchAll(/<p class="citation">([\s\S]*?)<\/p>/g)].map((m) => m[1]!);

  test("a known source is named by publisher and title", async () => {
    const html = await publish([
      finding(1, 3, { citation: { source_type: "paper", url: REAL } }),
    ]);
    const line = citationLines(html).join("\n");
    assert.match(line, /Nielsen Norman Group/, "the publisher is what a reader recognises");
    assert.match(line, /Better Link Labels/, "the title is what makes it checkable");
    assert.doesNotMatch(line, />paper</, "the kind is not a name and must not be the link text");
  });

  test("naming the source does not cost the link to it", async () => {
    const html = await publish([
      finding(1, 3, { citation: { source_type: "paper", url: REAL } }),
    ]);
    assert.match(citationLines(html).join("\n"), new RegExp(`href="${REAL}"`));
  });

  test("a url we do not hold falls back to the kind rather than inventing a name", async () => {
    // Every existing citation test uses an unlisted url. Silence beats a
    // fabricated authority — quality-bar.md §3 — so the old behaviour is the
    // right floor here, not a bug to fix.
    const html = await publish([
      finding(1, 3, { citation: { source_type: "paper", url: "https://example.test/not-ours" } }),
    ]);
    const line = citationLines(html).join("\n");
    assert.match(line, />paper</);
    assert.doesNotMatch(line, /Nielsen Norman Group/);
  });

  test("an uncited finding is untouched by any of this", async () => {
    const html = await publish([finding(1, 3)]);
    assert.match(citationLines(html).join("\n"), /Based on our evaluation/);
  });
});

/**
 * B5 — a published page that turns out to be wrong is fixed *and says so*.
 *
 * Twice before this existed, a published page was regenerated by a throwaway
 * script that bypassed review.ts's refusal, and nothing recorded that what the
 * visitor saw had changed. Silence is the option this product sells against.
 */
describe("a corrected page carries its corrections", () => {
  test("the dated line names what changed", async () => {
    const html = await publish([finding(1, 3)], {
      corrections: [{ at: "2026-08-17T22:00:00.000Z", reason: "added the sources for two findings" }],
    });
    assert.match(html, /Corrected 2026-08-17/);
    assert.match(html, /added the sources for two findings/);
  });

  test("several corrections all appear, oldest first", async () => {
    // A page corrected twice must not hide the first one. The history is the
    // part a reader would care about most.
    const html = await publish([finding(1, 3)], {
      corrections: [
        { at: "2026-08-17T10:00:00.000Z", reason: "first fix" },
        { at: "2026-08-18T10:00:00.000Z", reason: "second fix" },
      ],
    });
    assert.ok(html.indexOf("first fix") < html.indexOf("second fix"));
  });

  test("an uncorrected page says nothing about corrections", async () => {
    // Most pages are not corrected. A permanent empty block would imply the
    // page had a history it does not have.
    const html = await publish([finding(1, 3)]);
    assert.doesNotMatch(html, /Corrected/);
    assert.doesNotMatch(html, /class="corrections"/);
  });

  test("the reason is escaped, because a person types it", async () => {
    const html = await publish([finding(1, 3)], {
      corrections: [{ at: "2026-08-17T10:00:00.000Z", reason: `<script>alert(1)</script>` }],
    });
    assert.doesNotMatch(html, /<script>alert/);
  });
});

/**
 * The footer is a promise to a customer, and for one day it was a false one.
 *
 * It read "read by a person before publishing" for its whole life, which was
 * true while every audit stopped at the founder gate. Automating that gate on
 * 2026-08-24 made it false on every audit that published itself — a trust
 * claim, on a paying customer's page, about the exact thing that had changed.
 * Found by reading a live page rather than by any test, which is why these
 * exist now.
 */
describe("the footer claims only what actually happened", () => {
  const base = () => ({
    capture: capture([element()]),
    kept: [finding(1, 2)],
    allFindings: [finding(1, 2)],
    annotatedImage: "/tmp/x-annotated.png",
    summary: "A page.",
    reveal: true,
  });

  test("an audit a person read says so", () => {
    const html = publicHtml({ ...base(), decidedBy: "founder" } as Parameters<typeof publicHtml>[0]);
    assert.match(html, /read by a person/);
  });

  test("an audit that published itself does not", () => {
    const html = publicHtml({ ...base(), decidedBy: "auto" } as Parameters<typeof publicHtml>[0]);
    assert.doesNotMatch(html, /read by a person/, "nobody read it, so it must not say so");
    assert.match(html, /checks are automatic/, "and it says what did happen instead");
  });

  test("a caller that does not say gets the cautious wording", () => {
    // The flattering claim is the one that must be earned explicitly.
    const html = publicHtml(base() as Parameters<typeof publicHtml>[0]);
    assert.doesNotMatch(html, /read by a person/);
  });
});
