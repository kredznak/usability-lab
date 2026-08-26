import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { MARK, MARK_ASPECT, markCss, siteUrl } from "./brand.js";

/**
 * The copy nobody would notice going stale.
 *
 * `brand.ts` holds the artwork as a string rather than reading the file, and the
 * reasons are good — see that module — but it means `brand/the-usability-lab.svg`
 * and the product are two copies of one drawing. Replace the file and the site
 * keeps drawing the old mark, forever, with nothing on any page looking wrong.
 * There is no user-visible symptom to catch it and no error to trip over: the
 * only evidence would be somebody remembering they had changed the logo.
 *
 * So the geometry is compared, and only the geometry. The file is `#000` on
 * `#FFF` and the product paints from whichever palette the mark lands in, which
 * is a difference on purpose rather than drift.
 */

const SOURCE = new URL("../brand/the-usability-lab.svg", import.meta.url);

function geometry(svg: string) {
  const rect = svg.match(/<rect[^>]*>/)?.[0] ?? "";
  const attr = (name: string) => rect.match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
  return {
    d: svg.match(/ d="([^"]+)"/)?.[1] ?? null,
    viewBox: svg.match(/viewBox="([^"]+)"/)?.[1] ?? null,
    rect: {
      y: attr("y"),
      width: attr("width"),
      height: attr("height"),
      transform: attr("transform"),
    },
  };
}

describe("the mark in the code is the mark in brand/", () => {
  const source = geometry(readFileSync(SOURCE, "utf8"));
  const drawn = geometry(MARK);

  test("the source file is still there and still parses", () => {
    assert.ok(source.d && source.d.length > 1000, "no path data found in the source svg");
    assert.equal(source.viewBox, "0 0 438 121");
  });

  test("the letterforms match", () => {
    assert.equal(
      drawn.d,
      source.d,
      "brand/the-usability-lab.svg has been changed and src/brand.ts still draws the old one",
    );
  });

  test("the slab matches", () => {
    assert.deepEqual(drawn.rect, source.rect);
  });

  test("the viewBox matches, because every size in the app is derived from it", () => {
    // Not decoration: `.brandmark` sets a width and the height follows from this
    // ratio, and marketing.test.ts uses it to prove the h1 clears the mark.
    assert.equal(drawn.viewBox, source.viewBox);
    const box = (source.viewBox ?? "").split(" ").map(Number);
    const [w, h] = [box[2], box[3]];
    assert.ok(w && h, "the viewBox has no width and height to derive a ratio from");
    assert.equal(MARK_ASPECT, h / w);
  });
});

describe("the mark carries its own name and takes its colours from outside", () => {
  test("it is exposed to a screen reader as an image with a name", () => {
    // The whole accessible name of the link home, on every page that links home.
    assert.match(MARK, /role="img"/);
    assert.match(MARK, /aria-label="The Usability Lab"/);
  });

  test("no colour is baked into the artwork", () => {
    assert.doesNotMatch(
      MARK,
      /fill="(?!none)[^"]+"/,
      "a fill in the markup would override whatever palette the mark lands in",
    );
  });

  test("markCss paints what it is given, and nothing else", () => {
    const css = markCss("var(--ink)", "var(--paper)");
    assert.match(css, /\.mark \.slab \{ fill:var\(--ink\); \}/);
    assert.match(css, /\.mark \.word \{ fill:var\(--paper\); \}/);
    assert.doesNotMatch(css, /#000|#fff|black|white/i);
  });
});

describe("where the mark points from a file on somebody else's disk", () => {
  /**
   * `results-full.html` is written to disk and opened as a file. A root-relative
   * href there points at the reader's own filesystem, so the link home has to be
   * absolute — which means it has to come from configuration, and has to survive
   * that configuration being absent.
   */
  const withEnv = (value: string | undefined, fn: () => void) => {
    const had = process.env.USABILITY_LAB_BASE_URL;
    if (value === undefined) delete process.env.USABILITY_LAB_BASE_URL;
    else process.env.USABILITY_LAB_BASE_URL = value;
    try {
      fn();
    } finally {
      if (had === undefined) delete process.env.USABILITY_LAB_BASE_URL;
      else process.env.USABILITY_LAB_BASE_URL = had;
    }
  };

  test("it follows the deploy's own base url", () => {
    withEnv("https://staging.example.com", () =>
      assert.equal(siteUrl(), "https://staging.example.com"),
    );
  });

  test("a trailing slash does not become a double slash", () => {
    withEnv("https://example.com/", () => assert.equal(siteUrl(), "https://example.com"));
  });

  test("an absent or blank setting still yields a link, not an empty href", () => {
    withEnv(undefined, () => assert.equal(siteUrl(), "https://theusabilitylab.com"));
    withEnv("   ", () => assert.equal(siteUrl(), "https://theusabilitylab.com"));
  });
});
