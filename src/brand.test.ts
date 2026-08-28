import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MARK,
  ICON,
  MARK_ASPECT,
  ICON_ASPECT,
  MARK_MIN_WIDTH,
  markCss,
  iconCss,
  siteUrl,
} from "./brand.js";

/**
 * The copy nobody would notice going stale.
 *
 * `brand.ts` holds the artwork as strings rather than reading the files, and the
 * reasons are good — see that module — but it means `brand/*.svg` and the
 * product are two copies of one drawing. Replace a file and the site keeps
 * drawing the old mark, forever, with nothing on any page looking wrong. There
 * is no user-visible symptom and no error to trip over: the only evidence would
 * be somebody remembering they had changed the logo.
 *
 * So the geometry is compared, and only the geometry. The files are `#000` and
 * the product paints from whichever palette the mark lands in, which is a
 * difference on purpose rather than drift.
 */
const LOGO_FILE = new URL("../brand/the-usability-lab.svg", import.meta.url);
const ICON_FILE = new URL("../brand/the-usability-lab-icon.svg", import.meta.url);

const paths = (svg: string) => [...svg.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]!);
const viewBox = (svg: string) => svg.match(/viewBox="([^"]+)"/)?.[1] ?? null;

describe("the artwork in the code is the artwork in brand/", () => {
  const logoSrc = readFileSync(LOGO_FILE, "utf8");
  const iconSrc = readFileSync(ICON_FILE, "utf8");

  test("both source files are still there and still parse", () => {
    assert.ok(paths(logoSrc).length === 5, `expected 5 paths in the lockup, saw ${paths(logoSrc).length}`);
    assert.ok(paths(iconSrc).length === 4, `expected 4 paths in the glyph, saw ${paths(iconSrc).length}`);
    assert.equal(viewBox(logoSrc), "0 0 1241 169");
    assert.equal(viewBox(iconSrc), "0 0 203 203");
  });

  test("every path in the lockup is drawn, in the same order", () => {
    assert.deepEqual(
      paths(MARK),
      paths(logoSrc),
      "brand/the-usability-lab.svg has changed and src/brand.ts still draws the old one",
    );
  });

  test("every path in the glyph is drawn, in the same order", () => {
    assert.deepEqual(paths(ICON), paths(iconSrc));
  });

  test("the glyph in the lockup is the glyph in the icon file", () => {
    /**
     * They are separate exports from Figma at different scales, so the path data
     * differs and cannot be compared directly. What can be compared is the
     * count: four lobes. If one export gains or loses a path the two pieces of
     * the identity have diverged, and the corner would be showing a different
     * mark from the homepage on the very same site.
     */
    assert.equal(paths(MARK).length - 1, paths(ICON).length, "the lockup and the icon disagree about the glyph");
  });

  test("the viewBoxes match, because every size in the app is derived from them", () => {
    assert.equal(viewBox(MARK), viewBox(logoSrc));
    assert.equal(viewBox(ICON), viewBox(iconSrc));
    const [, , w, h] = (viewBox(logoSrc) ?? "").split(" ").map(Number);
    assert.ok(w && h, "the lockup viewBox has no width and height to derive a ratio from");
    assert.equal(MARK_ASPECT, h / w);
    assert.equal(ICON_ASPECT, 1);
  });
});

describe("what the markup must not carry", () => {
  test("no ids, because inline SVG ids are document-global", () => {
    /**
     * Both Figma exports wrap their paths in a `clipPath` with a generated id.
     * The homepage draws the lockup and the glyph in the same element, so two
     * copies of the same id would be in one document — and a duplicate id is
     * not an error, it is a silent win for whichever came first.
     *
     * Both clips were checked by rendering with and without them: zero
     * differing bytes in either file, so they are dropped rather than renamed.
     */
    for (const [name, svg] of [["MARK", MARK], ["ICON", ICON]] as const) {
      assert.doesNotMatch(svg, / id="/, `${name} carries an id into the page`);
      assert.doesNotMatch(svg, /clip-path=/, `${name} still references a clip path`);
    }
  });

  test("no colour is baked into the artwork", () => {
    for (const [name, svg] of [["MARK", MARK], ["ICON", ICON]] as const) {
      assert.doesNotMatch(
        svg,
        /fill="(?!none)[^"]+"/,
        `${name}: a fill in the markup would override whatever palette it lands in`,
      );
    }
  });

  test("each is exposed to a screen reader as an image with a name", () => {
    // The whole accessible name of the link home, on every page that links home.
    for (const [name, svg] of [["MARK", MARK], ["ICON", ICON]] as const) {
      assert.match(svg, /role="img"/, `${name} is not exposed as an image`);
      assert.match(svg, /aria-label="The Usability Lab"/, `${name} has no accessible name`);
    }
  });
});

describe("painting it", () => {
  test("markCss and iconCss paint what they are given, and nothing else", () => {
    assert.match(markCss("var(--ink)"), /\.mark \.word, \.mark \.glyph \{ fill:var\(--ink\); \}/);
    assert.match(iconCss("var(--ink)"), /\.icon \.glyph \{ fill:var\(--ink\); \}/);
    for (const css of [markCss("var(--ink)"), iconCss("var(--ink)")]) {
      assert.doesNotMatch(css, /#000|#fff|black|white/i);
    }
  });

  test("neither emits a stroke", () => {
    /**
     * The previous artwork's knockout letters lost ink to antialiasing below
     * 300px and were given 0.6 device pixels of stroke back on low-density
     * displays. Measured against this artwork the problem does not exist — the
     * darkest letter pixels reach full ink at every width from 160px to 600px.
     *
     * Reintroducing a stroke here is the plausible wrong move, because the
     * reasoning that justified it is still in the repo history and reads as
     * general advice about small marks. It is not: it was about knockout
     * letterforms, which fill in, and these are positive ones, which thin.
     */
    for (const css of [markCss("a"), iconCss("a")]) {
      assert.doesNotMatch(css, /stroke/, "a stroke would make this artwork bolder than it was drawn");
    }
  });

  test("the size floor is a real number the shells can check", () => {
    // Not decoration: marketing.test.ts refuses any shell that draws the lockup
    // narrower than this, because a squeezed wordmark reads as cheap, not small.
    assert.equal(typeof MARK_MIN_WIDTH, "number");
    assert.ok(MARK_MIN_WIDTH >= 160, "below 160px the caps are under 17px and it is a grey dash");
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
