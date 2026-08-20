import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { publisherCounts, homePage, questionsPage, STEPPER_JS, STEPPED_CSP } from "./marketing.js";
import { SOURCES } from "./sources.js";
import { QUESTIONS } from "./profile.js";
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

/**
 * The stepped question flow, and the one property the whole design rests on.
 *
 * **Every field is in the HTML before a line of script runs.** The stepper hides
 * five of them; it does not fetch them, build them, or ask the server for them.
 * That single fact is what buys everything else: no server-side step state, so
 * nothing half-finished is stored, so no expiry policy for a stranger's free
 * text, so no new endpoint and no new rate-limit surface — and `/request` is
 * byte-for-byte the handler it always was.
 *
 * It is also what makes the page work with JavaScript off, where all six simply
 * display and submit as the form this replaced.
 *
 * ## Read the last test in this block before adding to it
 *
 * The obvious version of this guarantee — "assert every field name is present" —
 * **passes against an implementation that hides five of them server-side**,
 * which is exactly the broken thing it exists to catch. It took a second,
 * different assertion to have any teeth. The image-route tests in
 * `server.test.ts` carry the same warning from a different day.
 */
describe("the stepped flow degrades to the form it replaced", () => {
  test("all six fields are in the HTML before a line of script runs", () => {
    const html = questionsPage();
    assert.match(html, /name="url"/);
    for (const [i] of QUESTIONS.entries()) {
      assert.match(html, new RegExp(`name="q${i}"`), `q${i} must be present at first byte`);
    }
  });

  test("every question's text is in the markup, not assembled by script", () => {
    const html = questionsPage();
    for (const q of QUESTIONS) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "&#39;");
      assert.match(html, new RegExp(escaped), q);
    }
  });

  /**
   * The one with teeth. Presence is not enough — a step rendered `hidden` is
   * present and invisible, and a visitor without JavaScript sees one field and
   * no way to reach the other five.
   */
  test("no step is hidden server-side, because nothing may depend on the script", () => {
    const html = questionsPage();
    const steps = html.match(/<[^>]*class="step"[^>]*>/g) ?? [];
    assert.equal(steps.length, QUESTIONS.length + 1, "six steps: the URL and the five questions");
    for (const tag of steps) {
      assert.doesNotMatch(tag, /\bhidden\b/, `a step arrives hidden: ${tag}`);
    }
  });

  test("one form, one submit, posting where it always did", () => {
    const html = questionsPage();
    assert.equal(html.match(/<form/g)?.length, 1, "one submit, not one per step");
    assert.match(html, /action="\/request"/);
    assert.match(html, /method="post"/i);
  });

  test("the navigation buttons never submit the form on their own", () => {
    // With the script absent or broken, a bare <button> inside a form submits
    // it. Back and Skip would then post a half-filled flow.
    const html = questionsPage();
    for (const id of ["back", "skip", "next"]) {
      const tag = html.match(new RegExp(`<button[^>]*id="${id}"[^>]*>`))?.[0];
      assert.ok(tag, `#${id} is missing`);
      assert.match(tag, /type="button"/, `#${id} must not be a submit button`);
    }
  });

  test("typed answers come back escaped", () => {
    const html = questionsPage({
      url: `"><script>alert(1)</script>`,
      answers: { [QUESTIONS[0]!]: `<img src=x onerror=1>` },
      error: "nope",
    });
    assert.doesNotMatch(html, /<script>alert/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x/);
    assert.match(html, /nope/);
  });

  test("a refusal says which step to open on", () => {
    assert.match(questionsPage({ error: "bad url", url: "nope" }), /<form[^>]*data-error-step="0"/);
    // Matched against the <form> tag rather than the whole document: the
    // stepper reads this attribute by name, so a bare /data-error-step/ finds
    // the script and passes no matter what the server rendered.
    assert.doesNotMatch(questionsPage(), /<form[^>]*data-error-step/, "silent when all is well");
  });

  test("the CSP authorises exactly the script on the page, by hash", () => {
    const digest = createHash("sha256").update(STEPPER_JS, "utf8").digest("base64");
    assert.ok(
      STEPPED_CSP.includes(`'sha256-${digest}'`),
      "the policy must be derived from the script, so the two cannot drift apart",
    );
    assert.doesNotMatch(STEPPED_CSP, /script-src[^;]*unsafe-inline/);
    assert.match(STEPPED_CSP, /font-src 'self'/);
    assert.match(STEPPED_CSP, /default-src 'none'/);
  });

  test("the script the policy names is the script in the page", () => {
    // If the page ever renders a modified copy — minified, or with a value
    // interpolated in — the hash stops matching and the browser silently runs
    // nothing. Silently, because CSP failures are a console message.
    assert.ok(questionsPage().includes(STEPPER_JS), "byte-identical, or the policy blocks it");
  });
});
