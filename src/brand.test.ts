import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MARK,
  MARK_ASPECT,
  MARK_RESOLVES_ABOVE,
  markCss,
  hairlineCss,
  bleedCss,
  siteUrl,
} from "./brand.js";

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

  test("the bleed strip is cut from the same slab as the artwork", () => {
    /**
     * `bleedCss` continues the slab past the element's left edge with a rotated
     * pseudo-element, which means it hardcodes three numbers that belong to the
     * drawing: where the slab's band starts, how deep it is, and its angle. Get
     * any of them wrong and the strip meets the rect at a visible step — and it
     * would only be visible on the pages that bleed, at the sizes they bleed at.
     *
     * So they are checked against the source file, the same way the letterforms
     * are. This is the assertion that survives somebody redrawing the logo at a
     * different angle.
     */
    const svg = readFileSync(SOURCE, "utf8");
    const rect = svg.match(/<rect[^>]*>/)![0];
    const y = Number(rect.match(/ y="([\d.]+)"/)![1]);
    const height = Number(rect.match(/ height="([\d.]+)"/)![1]);
    const angle = Number(rect.match(/rotate\((-?[\d.]+)/)![1]);
    const [, , , artHeight] = (svg.match(/viewBox="([^"]+)"/)![1] ?? "").split(" ").map(Number);
    assert.ok(artHeight, "no viewBox height to take percentages against");

    const css = bleedCss(".x", "var(--ink)");
    const pct = (n: number) => `${((n / artHeight) * 100).toFixed(3)}%`;
    assert.match(css, new RegExp(`top:${pct(y).replace(".", "\\.")}`), "the band starts elsewhere");
    assert.match(
      css,
      new RegExp(`height:${pct(height).replace(".", "\\.")}`),
      "the band is a different depth",
    );
    assert.match(css, new RegExp(`rotate\\(${String(angle).replace(".", "\\.")}deg\\)`));
  });

  test("the strip is measured in the element's own box, not in pixels", () => {
    // One rule has to be right at 240px and at 186px, and at whatever a later
    // layout picks. Percentages of a box whose height is the artwork's height
    // are correct at every size; pixels would be correct at exactly one.
    const css = bleedCss(".x", "var(--ink)");
    assert.match(css, /top:[\d.]+%/);
    assert.match(css, /height:[\d.]+%/);
    assert.doesNotMatch(css, /top:[\d.]+px|height:[\d.]+px/);
  });

  test("it pins itself to the element's left edge and rotates about that corner", () => {
    const css = bleedCss(".x", "var(--ink)");
    assert.match(css, /right:calc\(100% - 1px\)/, "no overlap leaves a hairline seam on the join");
    assert.match(css, /transform-origin:100% 0/, "any other origin and the bands diverge");
  });

  test("it does not declare position, which would move the mark it decorates", () => {
    // Every caller is `position:absolute`. Emitting `position:relative` here
    // would put the mark back in the flow it was deliberately taken out of.
    const css = bleedCss(".x", "var(--ink)");
    assert.doesNotMatch(css, /\.x \{[^}]*position:/);
  });

  test("the correction can be taken on its own, for a mark that changes width", () => {
    /**
     * `markCss` decides once, from `drawnAt`, which is right for a mark drawn at
     * one size and wrong for the homepage's: `min(372px,49vw)` on a desktop and
     * `min(255px,65vw)` on a phone, either side of the threshold. Compiled at
     * its widest it emits nothing, and the phone gets no correction at exactly
     * the size that needs it. `hairlineCss` is what the narrow media query uses.
     *
     * It must be byte-identical to what `markCss` emits, or the two placements
     * would drift and the phone would get a different weight from every other
     * small mark on the site.
     */
    assert.equal(hairlineCss("var(--paper)"), markCss("a", "var(--paper)", 190).split("\n")
      .slice(4).join("\n"), "the standalone correction has drifted from markCss's");
    assert.match(hairlineCss("#fff"), /@media \(max-resolution:1\.4dppx\)/);
    assert.match(hairlineCss("#fff"), /stroke:#fff; stroke-width:0\.6px/);
  });

  test("the threshold is exported, so callers can check their own widths", () => {
    // marketing.test.ts asserts the hero sits above it and the phone below it.
    // A literal 300 copied into that file would silently stop tracking this one.
    assert.equal(typeof MARK_RESOLVES_ABOVE, "number");
    assert.doesNotMatch(markCss("a", "b", MARK_RESOLVES_ABOVE), /stroke-width/);
    assert.match(markCss("a", "b", MARK_RESOLVES_ABOVE - 1), /stroke-width/);
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
