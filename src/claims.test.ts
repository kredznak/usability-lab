import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { Capture, type CapturedElement, type RawFinding } from "./types.js";
import { checkClaim, repeatedTextElements } from "./claims.js";

/**
 * Two kinds of test live here, and the distinction matters.
 *
 * REGRESSIONS are the two false positives that actually reached a results page
 * at high confidence. They are the reason this module exists, and each must be
 * rediscovered by the checker without being told what to look for.
 *
 * CALIBRATION tests pin the false-alarm rate. The checker's first run flagged
 * 15 of 72 findings; 14 of those were its own bugs. A checker that cries wolf
 * is worse than none — nobody reads the fifteenth alarm, so the two real
 * failures are the ones that get missed. Each case below is a specific way it
 * was wrong, kept so it cannot go back.
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
    font_size: 19,
    ...over,
  };
}

function capture(elements: CapturedElement[], text = ""): Capture {
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
    text_excerpt: text,
    text_total_chars: text.length,
    captured_at: "frozen",
  });
}

function finding(over: Partial<RawFinding>): RawFinding {
  return {
    heuristic: "h",
    severity: 2,
    element_ref: "el_1",
    observation: "",
    impact_note: "",
    positive: false,
    ...over,
  };
}

describe("claims: regressions from findings that actually shipped", () => {
  /**
   * linear.app, 2026-08-09. The h1 was reported as rendering its headline
   * twice. It wraps onto two lines; the duplicate was screen-reader-only text
   * that innerText picked up. Re-checked against a correct capture, the quote
   * is simply not on the page.
   */
  test("the duplicated-headline claim is contradicted by a correct capture", () => {
    const headline = "The product development system for teams and agents";
    const cap = capture(
      [element({ ref: "el_11", tag: "h1", text: headline, font_size: 64 })],
      headline,
    );
    const v = checkClaim(
      finding({
        element_ref: "el_11",
        observation: `The H1 text is rendered twice in sequence: "${headline} ${headline}".`,
      }),
      cap,
    );
    assert.equal(v.status, "contradicted");
    assert.ok(v.contradictions.some((c) => c.includes("NOT on the page")));
  });

  /**
   * The same claim against the BROKEN capture it was made from is `verified` —
   * and that is correct behaviour, not a gap in this test. When the capture is
   * wrong nothing downstream can know. That case belongs to the invariant
   * below, which catches it at source.
   */
  test("a wrong capture cannot be caught downstream, so it is caught at source", () => {
    const headline = "The product development system for teams and agents";
    const doubled = `${headline} ${headline}`;
    const broken = capture([element({ ref: "el_11", tag: "h1", text: doubled })], doubled);

    const v = checkClaim(
      finding({ element_ref: "el_11", observation: `The H1 renders twice: "${doubled}".` }),
      broken,
    );
    assert.equal(v.status, "verified", "consistent with a capture that is itself wrong");

    // The invariant is what actually catches it.
    assert.deepEqual(repeatedTextElements(broken), ["el_11"]);
    const good = capture([element({ ref: "el_11", tag: "h1", text: headline })], headline);
    assert.deepEqual(repeatedTextElements(good), []);
  });

  /**
   * gov.uk, 2026-08-09. WCAG 4.1.2 reported at severity 3 against a button
   * carrying a correct aria-label, because renderCapture never sent the
   * reviewer the accessible name it had.
   */
  test("a WCAG name violation against a named element is contradicted", () => {
    const cap = capture([
      element({ ref: "el_10", accessible_name: "Show search menu", name_source: "aria-label" }),
    ]);
    const v = checkClaim(
      finding({
        element_ref: "el_10",
        observation:
          "A 61x61px <button> in the header region has no visible text and no accessible name recorded.",
      }),
      cap,
    );
    assert.equal(v.status, "contradicted");
    assert.ok(v.contradictions.some((c) => c.includes("Show search menu")));
  });
});

describe("claims: calibration — the checker's own false alarms", () => {
  const cap = capture(
    [
      element({ ref: "el_26", tag: "a", text: "Benefits", bbox: { x: 0, y: 0, width: 69, height: 23 } }),
      element({ ref: "el_70", tag: "a", text: "News", bbox: { x: 0, y: 0, width: 50, height: 23 } }),
      element({
        ref: "el_15",
        tag: "input",
        text: "",
        input_type: "search",
        accessible_name: "Search",
        name_source: "label",
      }),
      element({
        ref: "el_10",
        accessible_name: "Show search menu",
        name_source: "aria-label",
      }),
    ],
    "Benefits News The best place to find government services and information",
  );

  test("text between two quotations is not itself a quotation", () => {
    // The single mistake behind 14 of the checker's first 15 contradictions.
    const v = checkClaim(
      finding({
        element_ref: "el_26",
        observation: 'Identical link text, e.g. "Benefits" (el_26 and el_96), "News" (el_70), repeats.',
      }),
      cap,
    );
    assert.equal(v.status, "verified", `false alarm: ${v.contradictions.join(" | ")}`);
  });

  test("a full stop the writer added is not a fabricated quote", () => {
    const v = checkClaim(
      finding({
        element_ref: "el_26",
        observation:
          'The main heading reads "The best place to find government services and information."',
      }),
      cap,
    );
    assert.equal(v.status, "verified", `false alarm: ${v.contradictions.join(" | ")}`);
  });

  test("a tag naming another element is not attributed to the cited one", () => {
    const v = checkClaim(
      finding({
        element_ref: "el_15",
        observation:
          "The search combobox (el_15) takes its name from an associated <label> element (el_14).",
      }),
      cap,
    );
    assert.equal(v.status, "verified", `false alarm: ${v.contradictions.join(" | ")}`);
  });

  test("a finding that quotes the real accessible name is not claiming it is absent", () => {
    const v = checkClaim(
      finding({
        element_ref: "el_10",
        observation:
          'The search toggle (el_10) shows no visible text, relying only on an icon with accessible name "Show search menu".',
        impact_note: "The function of the unlabelled control is less obvious when scanning.",
      }),
      cap,
    );
    assert.equal(v.status, "verified", `false alarm: ${v.contradictions.join(" | ")}`);
  });

  test("a naming claim in the impact note alone does not contradict", () => {
    // §9 makes the observation the literal claim; the note is interpretation.
    const v = checkClaim(
      finding({
        element_ref: "el_26",
        observation: 'The link reads "Benefits" and repeats in the footer.',
        impact_note: "An unlabelled control nearby compounds this.",
      }),
      cap,
    );
    assert.equal(v.status, "verified", `false alarm: ${v.contradictions.join(" | ")}`);
  });
});

describe("claims: the checks that must still bite", () => {
  const cap = capture([element({ ref: "el_1", tag: "a", text: "Get started" })], "Get started");

  test("an element that does not exist is contradicted", () => {
    const v = checkClaim(finding({ element_ref: "el_99999", observation: "x" }), cap);
    assert.equal(v.status, "contradicted");
  });

  test("an invented measurement is contradicted", () => {
    const v = checkClaim(
      finding({ observation: "The button measures 640x480px, far larger than its neighbours." }),
      cap,
    );
    assert.equal(v.status, "contradicted");
  });

  test("a real measurement passes", () => {
    const v = checkClaim(finding({ observation: "The control measures 61x61px." }), cap);
    assert.equal(v.status, "verified", v.contradictions.join(" | "));
  });

  test("a finding with nothing checkable is unverifiable, not verified", () => {
    const v = checkClaim(
      finding({ element_ref: null, observation: "The page feels cluttered." }),
      cap,
    );
    assert.equal(v.status, "unverifiable");
  });
});

describe("claims: the frozen corpus stays honest", () => {
  const CORPUS = "fixtures/labelled/findings.json";

  test("no capture in the corpus contains repeated-text elements", () => {
    // The source-level guard against a screen-reader-only regression.
    for (const name of ["govuk", "stripe", "hn", "wikipedia", "signup", "checkout", "stripe_pricing"]) {
      const c = Capture.parse(
        JSON.parse(readFileSync(`fixtures/captures/${name}.json`, "utf8")),
      );
      assert.deepEqual(repeatedTextElements(c), [], `${name} has doubled element text`);
    }
  });

  test("the corpus records the two known-false findings", { skip: !existsSync(CORPUS) }, () => {
    const corpus = JSON.parse(readFileSync(CORPUS, "utf8")) as {
      findings: { observation: string; auto: { status: string } }[];
    };
    const wcag = corpus.findings.find((f) =>
      f.observation.includes("no visible text and no accessible name"),
    );
    assert.ok(wcag, "the gov.uk WCAG false positive is missing from the corpus");
    assert.equal(wcag.auto.status, "contradicted");
  });
});
