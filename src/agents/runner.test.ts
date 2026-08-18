import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { Capture } from "../types.js";
import { renderCapture, buildRequest } from "./runner.js";
import { RUBRICS } from "./rubrics.js";
import { digestImages, loadCapture } from "./snapshot-request.js";

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

  /**
   * B8. The element list has warned about its own truncation since Slice 2.
   * The page text did not, and a reviewer read the silence as absence:
   * basecamp's text was cut at 4000 of 6753 characters, and the missing 41%
   * held the six tile labels it then reported as "no visible text on the page".
   * Rank 1, high confidence, mechanically verified, and false — the labels are
   * rendered as headings above every tile.
   *
   * Two truncations, one warning, was the whole bug.
   */
  test("truncated page text is disclosed too, not just a truncated element list", () => {
    const out = renderCapture({ ...capture, text_excerpt: "abc", text_total_chars: 6753 });
    assert.match(out, /VISIBLE PAGE TEXT \(3 of 6753 characters/);
    assert.match(out, /this text is TRUNCATED/);
    assert.match(out, /Do not claim anything is missing from the page/);
  });

  test("page text that is whole does not claim to be cut", () => {
    const out = renderCapture({
      ...capture,
      text_excerpt: "the whole page",
      text_total_chars: "the whole page".length,
    });
    assert.match(out, /VISIBLE PAGE TEXT:/);
    assert.doesNotMatch(out, /this text is TRUNCATED/);
  });

  test("a screenshot that was cut short says so", () => {
    // Third input, third truncation warning, same wording. B8's lesson was that
    // an input which truncates in silence gets read as evidence of absence.
    const out = buildRequest(RUBRICS.heuristics!, capture, {
      tiles: [{ base64: "AAAA", fromY: 0, toY: 900 }],
      unshownPx: 3200,
      fullHeightPx: 4100,
    });
    const text = JSON.stringify(out.messages[0]!.content);
    assert.match(text, /TRUNCATED/);
    assert.match(text, /first 900 of 4100px/);
    assert.match(text, /Do not claim anything is missing from the page/);
  });

  test("a whole-page screenshot does not claim to be cut", () => {
    const out = buildRequest(RUBRICS.heuristics!, capture, {
      tiles: [{ base64: "AAAA", fromY: 0, toY: 900 }],
      unshownPx: 0,
      fullHeightPx: 900,
    });
    const text = JSON.stringify(out.messages[0]!.content);
    assert.doesNotMatch(text, /TRUNCATED: it covers/);
    assert.match(text, /cover the whole page/);
  });

  test("the images come before the measurements", () => {
    // Order is the finding, not a style choice. The screenshot is the page; the
    // element list is our description of it. A reviewer given the description
    // first anchors on it and reads the picture as confirmation — which is how
    // basecamp's tile labels were reported as absent while plainly visible.
    const out = buildRequest(RUBRICS.heuristics!, capture, {
      tiles: [
        { base64: "AAAA", fromY: 0, toY: 900 },
        { base64: "BBBB", fromY: 900, toY: 1800 },
      ],
      unshownPx: 0,
      fullHeightPx: 1800,
    });
    const blocks = out.messages[0]!.content as { type: string }[];
    const firstImage = blocks.findIndex((b) => b.type === "image");
    const capturedData = blocks.findIndex(
      (b) => b.type === "text" && /captured_page_data/.test((b as { text?: string }).text ?? ""),
    );
    assert.ok(firstImage !== -1, "no image block was sent");
    assert.ok(firstImage < capturedData, "the element list must not precede the screenshot");
    assert.equal(blocks.filter((b) => b.type === "image").length, 2);
  });

  test("a capture with no screenshot still builds a request", () => {
    // Tiling can fail on a page we still audited successfully. Losing the run
    // at the last step over a missing crop would trade an audit for a picture.
    const out = buildRequest(RUBRICS.heuristics!, capture, {
      tiles: [],
      unshownPx: 0,
      fullHeightPx: 0,
    });
    const blocks = out.messages[0]!.content as { type: string }[];
    assert.equal(blocks.filter((b) => b.type === "image").length, 0);
    assert.match(JSON.stringify(blocks), /captured_page_data/);
    assert.doesNotMatch(JSON.stringify(blocks), /SCREENSHOT/);
  });

  test("the lane is the last thing in the request, after the page data", () => {
    // B12. Everything above it is identical for every reviewer of this audit,
    // which is what lets the images be written to the cache once and read by
    // the rest — ~$0.18 an audit.
    const blocks = buildRequest(RUBRICS.heuristics!, capture, {
      tiles: [{ base64: "AAAA", fromY: 0, toY: 900 }], unshownPx: 0, fullHeightPx: 900,
    }).messages[0]!.content as { type: string; text?: string }[];
    assert.match(blocks[blocks.length - 1]!.text ?? "", /Your lane/);
  });

  test("the page content carries a cache breakpoint", () => {
    // Four reviewers, one page. Without this the images are sent four times and
    // become the most expensive thing in the audit.
    const out = buildRequest(RUBRICS.heuristics!, capture, {
      tiles: [{ base64: "AAAA", fromY: 0, toY: 900 }],
      unshownPx: 0,
      fullHeightPx: 900,
    });
    const blocks = out.messages[0]!.content as { cache_control?: unknown; text?: string }[];
    assert.equal(
      blocks.filter((b) => b.cache_control).length,
      1,
      "exactly one breakpoint, so everything before it caches",
    );
    // B12: the breakpoint marks the end of the *shared* prefix, not the end of
    // the request. The lane block that follows it differs per reviewer and is
    // deliberately outside the cached span — that is the whole arrangement.
    const mark = blocks.findIndex((b) => b.cache_control);
    assert.match(blocks[mark]!.text ?? "", /captured_page_data/);
    assert.match(blocks[mark + 1]!.text ?? "", /Your lane/);
  });

  /**
   * B13. Two facts a reviewer confidently asserted and could not have known:
   * that duolingo's header is not sticky (it is `position: fixed`), and that a
   * footer stamp seven weeks old was "in the future". Neither is truncation —
   * the capture simply did not carry the fact, and absence of evidence became
   * evidence of absence at high confidence.
   */
  test("an element that stays put while the page scrolls is marked", () => {
    const header = { ...capture.elements[0]!, ref: "el_test", position: "fixed" as const };
    assert.match(renderCapture({ ...capture, elements: [header] }), /position:fixed/);
  });

  test("an ordinary element is not described as anything", () => {
    // Silence, not "position:static". Every capture taken before 2026-08-17 has
    // no position at all, and printing "static" on those would be a new claim
    // the capture cannot support — the exact mistake being fixed here.
    const plain = { ...capture.elements[0]!, ref: "el_test", position: null };
    assert.doesNotMatch(renderCapture({ ...capture, elements: [plain] }), /position:/);
  });

  test("the reviewer is told when the page was captured", () => {
    const out = buildRequest(
      RUBRICS.heuristics!,
      { ...capture, captured_at: "2026-08-17T14:31:02.000Z" },
      { tiles: [], unshownPx: 0, fullHeightPx: 0 },
    );
    assert.match(JSON.stringify(out.messages[0]!.content), /captured on 2026-08-17/);
  });

  test("the date is ours, not the page's", () => {
    // It sits outside <captured_page_data>. Read from inside, a page that wants
    // to look freshly updated could write whatever date it liked and we would
    // hand it to the reviewer as fact.
    const blocks = buildRequest(
      RUBRICS.heuristics!,
      { ...capture, captured_at: "2026-08-17T14:31:02.000Z" },
      { tiles: [], unshownPx: 0, fullHeightPx: 0 },
    ).messages[0]!.content as { type: string; text?: string }[];

    const dated = blocks.findIndex((b) => /captured on 2026-08-17/.test(b.text ?? ""));
    const untrusted = blocks.findIndex((b) => /<captured_page_data/.test(b.text ?? ""));
    assert.ok(dated !== -1 && untrusted !== -1);
    assert.ok(dated < untrusted, "the date must not sit inside the untrusted block");
  });

  test("the two truncation warnings are independent", () => {
    // A page can have a complete element list and a cut page text, or the
    // reverse. Reporting one because the other happened would be a new lie.
    const textOnly = renderCapture({ ...capture, text_excerpt: "abc", text_total_chars: 900 });
    assert.match(textOnly, /this text is TRUNCATED/);
    assert.doesNotMatch(textOnly, /this list is TRUNCATED/);

    const listOnly = renderCapture({ ...capture, elements_total: capture.elements.length + 40 });
    assert.match(listOnly, /this list is TRUNCATED/);
    assert.doesNotMatch(listOnly, /this text is TRUNCATED/);
  });
});

/**
 * The request snapshot is a review surface — a diff a person reads before a
 * prompt change ships. Six 1440x900 PNGs is roughly 1.2MB of base64, which
 * would make every fixture unreadable and every diff meaningless.
 */
describe("request fixtures record images without carrying them", () => {
  test("an image block becomes a digest, never base64", () => {
    const png = Buffer.from("not really a png, but bytes are bytes");
    const digested = digestImages({
      messages: [
        {
          content: [
            { type: "text", text: "hello" },
            { type: "image", source: { type: "base64", media_type: "image/png", data: png.toString("base64") } },
          ],
        },
      ],
    }) as { messages: { content: { type: string; source?: Record<string, unknown>; text?: string }[] }[] };

    const [text, image] = digested.messages[0]!.content;
    assert.equal(text!.text, "hello", "text blocks pass through untouched");
    assert.equal(image!.type, "image");
    assert.equal(image!.source!.bytes, png.length);
    assert.equal(typeof image!.source!.sha256, "string");
    assert.equal(image!.source!.data, undefined, "the payload must not survive");
    assert.doesNotMatch(JSON.stringify(digested), /bm90IHJlYWxseQ/, "base64 leaked into the fixture");
  });

  test("different bytes give different digests, so a changed screenshot shows up", () => {
    const of = (s: string) =>
      JSON.stringify(
        digestImages({ type: "image", source: { type: "base64", media_type: "image/png", data: Buffer.from(s).toString("base64") } }),
      );
    assert.notEqual(of("page one"), of("page two"));
    assert.equal(of("page one"), of("page one"), "and the same bytes are stable");
  });

  test("the snapshot fixture's screenshot is committed, not left under out/", () => {
    // out/ is gitignored. Without a committed PNG the harness would silently
    // build an image-free request on a fresh clone and report it unchanged.
    const loaded = loadCapture("govuk");
    assert.match(loaded.screenshot_path, /^fixtures\/captures\/govuk-page\.png$/);
    assert.ok(existsSync(loaded.screenshot_path), "the committed screenshot is missing");
  });
});
