import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Capture } from "../types.js";
import { renderCapture } from "./runner.js";

/**
 * What a reviewer can actually see.
 *
 * These exist because of a live failure, not a hypothetical one: the
 * Accessibility rubric promised each element's accessible name and its source,
 * and Visual Hierarchy promised font sizes. Both were fields on the Capture and
 * neither reached the prompt. The Accessibility reviewer read "(no text)" on a
 * correctly labelled gov.uk button and reported a confident WCAG violation
 * against it.
 *
 * A prompt is a promise about the input. This is where the promise is kept.
 */

const capture = Capture.parse(
  JSON.parse(readFileSync("fixtures/captures/signup.json", "utf8")),
);
const rendered = renderCapture(capture);

describe("renderCapture sends every field a rubric promises", () => {
  test("font size, which Visual Hierarchy is told it can measure", () => {
    const heading = capture.elements.find((e) => e.tag === "h1");
    assert.ok(heading, "fixture has no h1");
    assert.match(
      rendered,
      new RegExp(`${heading.ref} <h1>.*${heading.font_size}px`),
      "the h1's font size is missing from the prompt",
    );
  });

  test("input type, which is how Forms & Flow tells a field from a search box", () => {
    const email = capture.elements.find((e) => e.input_type === "email");
    assert.ok(email, "fixture has no email input");
    assert.match(rendered, new RegExp(`${email.ref} <input type="email">`));
  });

  test("accessible name and its source, which Accessibility reasons from", () => {
    const placeholderNamed = capture.elements.find((e) => e.name_source === "placeholder");
    assert.ok(placeholderNamed, "fixture has no placeholder-named field");
    assert.match(
      rendered,
      new RegExp(`name\\(placeholder\\)="${placeholderNamed.accessible_name}"`),
      "a field named only by its placeholder must be visibly named that way",
    );
  });

  test("an element with no name and no text says so explicitly", () => {
    // The alternative is "(no text)" alone, which reads identically to a
    // properly labelled icon button — that ambiguity is what produced the
    // false WCAG finding.
    const unnamed = { ...capture.elements[0]!, ref: "el_test", text: "", accessible_name: null };
    const out = renderCapture({ ...capture, elements: [unnamed] });
    assert.match(out, /NO ACCESSIBLE NAME/);
  });

  test("a named element is never reported as unnamed", () => {
    const named = { ...capture.elements[0]!, ref: "el_test", text: "", accessible_name: "Search", name_source: "aria-label" as const };
    const out = renderCapture({ ...capture, elements: [named] });
    assert.doesNotMatch(out, /NO ACCESSIBLE NAME/);
    assert.match(out, /name\(aria-label\)="Search"/);
  });

  test("truncation is still disclosed to the reviewer", () => {
    const truncated = renderCapture({ ...capture, elements_total: capture.elements.length + 40 });
    assert.match(truncated, /TRUNCATED/);
    assert.doesNotMatch(rendered, /TRUNCATED/, "an untruncated capture must not claim it is");
  });
});
