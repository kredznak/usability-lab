import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  publisherCounts,
  homePage,
  questionsPage,
  STEPPER_JS,
  STEPPED_CSP,
  HERO_JS,
  HOME_CSP,
} from "./marketing.js";
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
 * The contrast floor, and the two measurements behind it.
 *
 * Hero text does not sit on `--paper`. It sits on whatever drifting form is
 * behind it at that second, and since 2026-08-20 those forms are deep: Kelly
 * asked for presence and the tonal range went from 16% of the scale to 25%.
 * Checking a token against `--paper` says 5.41:1 and is the wrong question.
 *
 * ## Why there are two numbers now and not one
 *
 * Deepening the forms took the sub-line to **2.92:1**. Darkening the text enough
 * to fix that needed `#463F37` — within a hair of the headline colour, which
 * collapses the hierarchy the sub-line depends on. So the fix was a veil: a
 * soft, edgeless lift of the page ground behind the words, leaving the forms at
 * full depth everywhere else.
 *
 * That split the hero into two zones, and one constant stopped describing it:
 *
 * - **Inside the veil**, the ground stays near paper (0.818), and `--ink-soft`
 *   is safe there.
 * - **Outside it**, the forms run to 0.528, where `--ink-soft` gives 3.61:1 and
 *   fails. The scroll cue lives there, which is why it is `--ink`.
 *
 * **The invariant: `--ink-soft` is only safe inside the veil.** Any hero text
 * placed outside it — a nav link, a second cue, a badge in a corner — must use
 * `--ink`, and this file is where that gets found out.
 *
 * ## These are measurements, so they go stale
 *
 * Taken by hiding the text, screenshotting with the pointer parked at all four
 * corners and the centre, three samples through the drift cycle at each, and
 * reading the darkest pixel under each text box. The first version of this said
 * 0.720 and was already wrong by the time the parallax shipped, because moving
 * the forms 40px pulls darker field under the text — and the test went on
 * passing while saying it.
 *
 * **Re-measure after any change to the forms' colours, blur, keyframes, size,
 * the veil, or `REACH` in `HERO_JS`. Do not adjust these to taste.**
 */
describe("hero text survives the forms behind it", () => {
  /** WCAG 2.1 relative luminance. */
  function luminance(hex: string): number {
    const n = parseInt(hex.replace("#", ""), 16);
    const channels = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * channels[0]! + 0.7152 * channels[1]! + 0.0722 * channels[2]!;
  }

  /** Behind the sub-line, where the veil holds the ground near paper. */
  const INSIDE_THE_VEIL = 0.81;
  /** Behind the scroll cue, where the forms run at full depth. */
  const OUTSIDE_THE_VEIL = 0.52;

  function token(name: string): string {
    const found = homePage().match(new RegExp(`${name}:\\s*(#[0-9A-Fa-f]{6})`));
    assert.ok(found, `${name} is not in the token block`);
    return found[1]!;
  }

  const ratio = (bg: number, fg: string) => (bg + 0.05) / (luminance(fg) + 0.05);

  test("--ink-soft clears 4.5:1 where the veil protects it", () => {
    const r = ratio(INSIDE_THE_VEIL, token("--ink-soft"));
    assert.ok(
      r >= 4.5,
      `--ink-soft is ${token("--ink-soft")}, giving ${r.toFixed(2)}:1 behind the sub-line. ` +
        `WCAG 1.4.3 needs 4.5:1. It looks light enough on --paper and is not.`,
    );
  });

  test("--ink clears 4.5:1 out where the forms are deepest", () => {
    const r = ratio(OUTSIDE_THE_VEIL, token("--ink"));
    assert.ok(r >= 4.5, `--ink gives ${r.toFixed(2)}:1 over the deepest form`);
  });

  test("--ink-soft would fail outside the veil, which is why the scroll cue is not using it", () => {
    // Not a bug being asserted — the reason for a design decision, pinned so it
    // does not get undone by someone tidying two greys into one.
    assert.ok(
      ratio(OUTSIDE_THE_VEIL, token("--ink-soft")) < 4.5,
      "if this ever passes, the forms got lighter and the note above is stale",
    );
  });

  test("the scroll cue uses --ink, because it sits outside the veil", () => {
    const rule = homePage().match(/\.scrollcue \{[^}]*\}/)?.[0] ?? "";
    assert.match(rule, /color:var\(--ink\)/, "the one hero element outside the protected zone");
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

/**
 * The hero's cursor parallax.
 *
 * Added 2026-08-20 after Kelly looked at the live page and asked where the
 * interaction was. There was none — the reactivity went out with the Three.js
 * particles and only the drifting was ever rebuilt. This is that gap closed, at
 * a cost of one transform on one element per frame instead of fifty thousand
 * particles recomputed on the CPU.
 *
 * The property worth protecting is the refusal: with `prefers-reduced-motion`
 * set, this must not bind a listener, start a loop, or write a transform. Not
 * "move less" — do nothing, and leave the still frame the CSS already renders.
 */
describe("the hero leans toward the cursor, unless asked not to", () => {
  test("reduced motion is checked before anything is bound", () => {
    // Order matters, not just presence. A listener attached before the check
    // would still fire; a transform written once before returning would still
    // move the page. So the guard has to be the first statement that runs.
    const body = HERO_JS.slice(HERO_JS.indexOf("(function"));
    const guard = body.indexOf("prefers-reduced-motion");
    const listener = body.indexOf("addEventListener");
    const raf = body.indexOf("requestAnimationFrame");
    assert.ok(guard > -1, "there is no reduced-motion branch at all");
    assert.ok(guard < listener, "the guard must come before any listener is bound");
    assert.ok(guard < raf, "the guard must come before any frame is scheduled");
  });

  test("it moves one element, not many", () => {
    // The whole argument for this over a particle field. If this ever grows a
    // querySelectorAll and a loop, it has become the thing we rejected.
    assert.match(HERO_JS, /querySelector\('\.forms'\)/);
    assert.doesNotMatch(HERO_JS, /querySelectorAll/, "one element, or it is a particle system again");
  });

  test("the loop stops when it settles rather than running forever", () => {
    assert.match(HERO_JS, /raf = null/, "an rAF loop with no exit is a permanent 60fps tax");
  });

  test("the listener is passive, so moving the pointer cannot block scrolling", () => {
    assert.match(HERO_JS, /\{ passive: true \}/);
  });

  test("the homepage authorises its script by hash and nothing else", () => {
    const digest = createHash("sha256").update(HERO_JS, "utf8").digest("base64");
    assert.ok(HOME_CSP.includes(`'sha256-${digest}'`), "policy derived from the script itself");
    assert.doesNotMatch(HOME_CSP, /script-src[^;]*unsafe-inline/);
    assert.match(HOME_CSP, /font-src 'self'/);
  });

  test("the script the policy names is the script in the page", () => {
    assert.ok(homePage().includes(HERO_JS), "byte-identical, or the browser silently runs nothing");
  });

  test("the CSS still freezes the forms outright under reduced motion", () => {
    // Belt and braces: the script declines to move them and the animation stops.
    // Either alone would leave motion on the page for someone who asked for none.
    assert.match(homePage(), /@media \(prefers-reduced-motion: reduce\)[^}]*\{[^}]*animation:\s*none/);
  });
});
