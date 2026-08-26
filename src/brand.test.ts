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

/**
 * The hairline correction, and the two things it must not do.
 *
 * Reported as "the smaller logo looks pixelated" on 2026-08-26. It is an SVG, so
 * the first two suspects were rasterisation — the `opacity:.92` on the link and
 * its transition. Both measured, both wrong: the transition changed zero bytes
 * of rendered output and the opacity was a flat 8% lightening. The cause is that
 * these are hairline knockout letterforms, and below about 300px their strokes
 * fall under one device pixel and antialias to grey.
 *
 * Putting the ink back is easy. Doing it without spoiling the mark everywhere
 * else is the part worth guarding, because both failure modes are silent:
 *
 *   - applied above the threshold, it makes a logo that was rendering correctly
 *     permanently bolder than it was drawn (+37% letter ink at 438px);
 *   - applied on a retina display, it does the same to the majority of viewers
 *     to fix a minority's — at 2x every size already reaches paper white, so
 *     there is nothing there to correct.
 */
describe("the hairline correction is applied only where the ink was lost", () => {
  const small = markCss("var(--ink)", "var(--paper)", 190);
  const large = markCss("var(--ink)", "var(--paper)", 438);

  test("a mark drawn small gets it", () => {
    assert.match(small, /stroke-width:0\.6px/);
    assert.match(small, /vector-effect:non-scaling-stroke/);
  });

  test("a mark drawn at the size it was designed for does not", () => {
    assert.doesNotMatch(
      large,
      /stroke-width/,
      "the hero would be quietly bolder than the artwork it was drawn from",
    );
  });

  test("the threshold is a size, not a guess about which shell is which", () => {
    // 300px is where the measurement stops showing loss: 300 reaches paper (250)
    // and 240 does not (239). Anything at or above it is left alone.
    assert.doesNotMatch(markCss("a", "b", 300), /stroke-width/);
    assert.match(markCss("a", "b", 299), /stroke-width/);
  });

  test("it is behind a low-density query, so retina keeps the drawn weight", () => {
    assert.match(small, /@media \(max-resolution:1\.4dppx\)/);
    assert.match(
      small,
      /-webkit-max-device-pixel-ratio:1\.4/,
      "Safari before 16 does not support the resolution query and would take the stroke",
    );
    // The rule has to be *inside* the query, not merely near it.
    const query = small.slice(small.indexOf("@media"));
    assert.match(query, /\{[\s\S]*stroke-width[\s\S]*\}/);
  });

  test("the stroke is the same colour as the fill", () => {
    // A stroke in any other colour outlines the letters rather than thickening
    // them, which at this size would read as a coloured fringe.
    const css = markCss("var(--ink)", "var(--bg)", 190);
    const stroke = css.match(/stroke:([^;]+);/)?.[1];
    const fill = css.match(/\.mark \.word \{ fill:([^;]+);/)?.[1];
    assert.equal(stroke, fill);
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
