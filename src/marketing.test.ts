import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { publisherCounts, homePage } from "./marketing.js";
import { SOURCES } from "./sources.js";
import { PRICE_USD } from "./render.js";
import { SITE_LIMIT, AUDITS_PER_MONTH } from "./fairuse.js";

/**
 * The numbers on the homepage, and why none of them are typed.
 *
 * ## The counts
 *
 * `sources.ts` went 15 rows -> 22 -> 28 in a single day on 2026-08-19, and it
 * will move again. A page that says "we cite our sources" while printing a
 * count that stopped being true last week is not a stale number — it is a false
 * claim about honesty, on the one page whose whole argument is honesty. It is
 * also exactly the finding this product would report about somebody else's
 * site.
 *
 * ## The money
 *
 * §11 wants one price in one place, and `PRICE_USD` is that place. The limits
 * have the same problem for a worse reason: `SITE_LIMIT` and
 * `AUDITS_PER_MONTH` are enforced by `fairuse.ts` against real customers, so a
 * homepage that advertises different figures is not out of date, it is
 * mis-sold.
 *
 * These tests read the real tables rather than a fixture, on purpose. A mock
 * would keep passing on the day the table moves, which is the only day they
 * matter.
 */

describe("the homepage's numbers are read, not typed", () => {
  test("publisher counts add up to the whole table", () => {
    assert.equal(
      publisherCounts().reduce((n, p) => n + p.n, 0),
      SOURCES.length,
      "every source belongs to exactly one publisher",
    );
  });

  test("counts are ordered largest first", () => {
    const ns = publisherCounts().map((p) => p.n);
    assert.deepEqual(ns, [...ns].sort((a, b) => b - a));
  });

  test("every publisher in the table reaches the page, with its real count", () => {
    const html = homePage();
    for (const { publisher, n } of publisherCounts()) {
      assert.match(html, new RegExp(`>${n}<`), `${publisher}'s count`);
      // The first word is enough — "Nielsen Norman Group" is broken across
      // lines in the markup, and asserting the whole string would be asserting
      // the line breaks.
      assert.match(html, new RegExp(publisher.split(/[\s.]/)[0]!), publisher);
    }
  });

  test("the total is the table's length", () => {
    assert.match(homePage(), new RegExp(`\\b${SOURCES.length}\\b`), "28 today, whatever it is later");
  });

  test("money and limits come from the constants that enforce them", () => {
    const html = homePage();
    assert.match(html, new RegExp(`\\$${PRICE_USD}\\b`));
    assert.match(html, new RegExp(`\\b${SITE_LIMIT} sites\\b`));
    assert.match(html, new RegExp(`\\b${AUDITS_PER_MONTH} re-audits\\b`));
  });

  test("the first audit is priced as free, because it is", () => {
    // FREE_FINDINGS = 3 then an email reveals the rest; $29 buys monitoring. A
    // bare price above the button would say it costs $29 to try, which is the
    // only false sentence this page could carry.
    const html = homePage();
    assert.match(html, /Your first audit/);
    assert.match(html, /Free/);
  });
});

describe("what the homepage must not do", () => {
  test("it has no form and sends nobody to /request", () => {
    const html = homePage();
    assert.doesNotMatch(html, /<form/i, "the questions live at /start now");
    assert.doesNotMatch(html, /\/request/);
    assert.match(html, /href="\/start"/);
  });

  test("it still lists no audits", () => {
    // §8's rule, not an omission: an index would be a cross-customer surface.
    // The homepage is the obvious place someone would later add "recent audits".
    const html = homePage();
    assert.doesNotMatch(html, /\/a\/[0-9a-f]{8}/i);
  });

  test("the drifting forms stop for anyone who asked them to", () => {
    // A full-bleed animation with no reduced-motion branch is a vestibular
    // trigger, and it is the specific reason the Three.js hero was rejected.
    const html = homePage();
    assert.match(html, /@media \(prefers-reduced-motion: reduce\)/);
    assert.match(html, /animation:\s*none/);
  });

  test("it uses no accent colour", () => {
    assert.doesNotMatch(homePage(), /#E4572E/i, "chroma belongs to render.ts's severity pins");
  });
});

/**
 * The contrast floor, and the measurement behind the number.
 *
 * Secondary text in the hero does not sit on `--paper`. It sits on whatever
 * drifting form happens to be behind it, and the forms are darker than the
 * ground. Checking `--ink-soft` against `--paper` says 5.41:1 and is the wrong
 * question.
 *
 * So the real background was measured: the hero was rendered with its text
 * hidden, screenshotted at five points across the drift cycle, and every pixel
 * under each text box sampled for the darkest one. That worst case has a
 * relative luminance of **0.72**, and against it the original `#6E665C` scored
 * **4.14:1** — under WCAG 1.4.3's 4.5:1 for body text.
 *
 * Which is exactly why the Three.js hero was rejected. Finding the same fault in
 * the replacement is the argument for measuring rather than reasoning about it.
 *
 * This test holds the floor in the direction that can actually break: somebody
 * lightening `--ink-soft` because it looks heavy on a white background, where it
 * genuinely does, without knowing what it sits on in the one place that matters.
 */
describe("secondary text survives the forms drifting behind it", () => {
  /** WCAG 2.1 relative luminance. */
  function luminance(hex: string): number {
    const n = parseInt(hex.replace("#", ""), 16);
    const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  }

  /** Measured, not assumed — see the block comment above. */
  const DARKEST_FORM_BEHIND_TEXT = 0.72;

  function token(name: string): string {
    const found = homePage().match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`));
    assert.ok(found, `${name} is not in the token block`);
    return found[1]!;
  }

  test("--ink-soft clears 4.5:1 against the darkest pixel behind it", () => {
    const ratio = (DARKEST_FORM_BEHIND_TEXT + 0.05) / (luminance(token("--ink-soft")) + 0.05);
    assert.ok(
      ratio >= 4.5,
      `--ink-soft is ${token("--ink-soft")}, giving ${ratio.toFixed(2)}:1 over the hero's ` +
        `darkest drifting form. WCAG 1.4.3 needs 4.5:1. It looks light enough on --paper ` +
        `and is not; that is the whole point of this test.`,
    );
  });

  test("--ink clears 4.5:1 there too, with room to spare", () => {
    const ratio = (DARKEST_FORM_BEHIND_TEXT + 0.05) / (luminance(token("--ink")) + 0.05);
    assert.ok(ratio >= 4.5, `--ink gives ${ratio.toFixed(2)}:1`);
  });
});
