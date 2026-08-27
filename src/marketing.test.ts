import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  publisherCounts,
  homePage,
  aboutPage,
  MENU_JS,
  questionsPage,
  STEPPER_JS,
  STEPPED_CSP,
  HERO_JS,
  HOME_CSP,
  billingPage,
  accountPage,
  signInPage,
  schedulePage,
} from "./marketing.js";
import { MARK_RESOLVES_ABOVE } from "./brand.js";
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

/**
 * The card that used to admit it was invented.
 *
 * "Here is this page, audited by the thing this page is selling" sat above a
 * finding nobody's pipeline had produced, and a paragraph saying so. B24. It now
 * quotes finding 3 of audit e338784b and links to the published page carrying
 * it — which is a claim that can rot in ways the old placeholder could not, so
 * two of these tests guard the rot rather than the change.
 */
describe("the finding on the card is real, and the page agrees with it", () => {
  test("its citation resolves to a row in the sources table", () => {
    const jakobs = SOURCES.find((s) => s.id === "lawsofux-jakobs");
    // marketing.ts asserts this non-null. Renaming the row would not fail a
    // type check — it would throw on every render of the front page.
    assert.ok(jakobs, "the card's source must still exist");
    assert.ok(homePage().includes(jakobs.url), "and the card links to it, not to a retyped title");
  });

  test("nothing in the sample admits to being invented", () => {
    // Phrases, not the bare word: `input::placeholder` is in the stylesheet and
    // matching that would be a test of the CSS reset, passing forever.
    const html = homePage();
    assert.doesNotMatch(html, /is a placeholder/i);
    assert.doesNotMatch(html, /the real one lands/i);
  });

  test("the card's pin is the pin drawn on the picture beside it", () => {
    // A forward guard, not a test of B24 — both numbers were 2 before and
    // agreed. render.ts's comment records what disagreement looks like: three
    // cards reading "2" beside an image pinned 1..n, connected by nothing.
    const html = homePage();
    const onCard = html.match(/<div class="pin">(\d+)<\/div>/)?.[1];
    const onShot = html.match(/\.pinmark::after \{ content:"(\d+)"/)?.[1];
    assert.ok(onCard && onShot, "both numbers must be findable");
    assert.equal(onCard, onShot);
  });

  test("the page does not contradict the finding it publishes about itself", () => {
    // Also a forward guard. The card says this page carries no privacy policy,
    // terms, or contact link. The day that stops being true the card becomes a
    // false claim about us, on the page arguing we check our claims — so adding
    // those links has to fail here first and take the card with it.
    assert.doesNotMatch(homePage(), /href="\/(privacy|terms|contact)/);
  });
});

describe("what the homepage must not do", () => {
  test("it has no form and sends nobody to /request", () => {
    const html = homePage();
    assert.doesNotMatch(html, /<form/i, "the questions live at /start now");
    assert.doesNotMatch(html, /\/request/);
    assert.match(html, /href="\/start"/);
  });

  test("it still lists no audits, and links to exactly one", () => {
    // §8's rule, not an omission: an index would be a cross-customer surface.
    // The homepage is the obvious place someone would later add "recent audits"
    // — and in its first form this test caught B24 doing a smaller version of
    // that, which is the only reason the exception below got looked at.
    //
    // One link is permitted: the audit of this page, hardcoded in marketing.ts.
    // It is a constant rather than a query, so it cannot enumerate, and the page
    // it reaches is about us and carries no one else's site. A second id here
    // means someone has started building the index, and this fails.
    const linked = new Set(
      [...homePage().matchAll(/\/a\/([0-9a-f-]{8,})/gi)].map((m) => m[1]!.toLowerCase()),
    );
    assert.deepEqual([...linked], ["e338784b-6ae0-4cf5-926a-eeb8c0c6bfce"]);
  });

  test("the dot field has a reduced-motion branch, in the paint loop", () => {
    /**
     * There is no CSS animation to switch off any more — the drift and the
     * repulsion both live in the canvas loop, which is deliberate: one place to
     * honour the setting instead of a keyframe and a script that could disagree
     * about it. So the guarantee is asserted against the script, below.
     *
     * A full-bleed animation with no way to stop it is a vestibular trigger, and
     * it is the specific reason the Three.js hero was rejected.
     */
    assert.match(homePage(), /prefers-reduced-motion: reduce/);
    assert.match(homePage(), /<canvas class="dots"/, "the field is a canvas now");
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
  const INSIDE_THE_VEIL = 0.73;
  /** Behind the scroll cue, where the forms run at full depth. */
  const OUTSIDE_THE_VEIL = 0.94;

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

  test("--ink-soft clears 4.5:1 outside the veil too, over the dot field", () => {
    /**
     * This test used to assert the opposite — that --ink-soft *failed* out here
     * — because the blurred forms it was written against ran deep at the bottom
     * of the hero. When the dot field replaced them it failed, with the message
     * it was given: "if this ever passes, the forms got lighter."
     *
     * They did. Dots are sparse and the cloud stops short of the bottom edge, so
     * the ground under the scroll cue went 0.52 -> 0.948 and the soft grey is
     * comfortable there again. The scroll cue went back to --ink-soft with it.
     *
     * Kept as a live assertion rather than deleted: it is what will notice if
     * the field ever grows to fill the hero.
     */
    const r = ratio(OUTSIDE_THE_VEIL, token("--ink-soft"));
    assert.ok(r >= 4.5, `--ink-soft gives ${r.toFixed(2)}:1 over the open field`);
  });

  test("the scroll cue is --ink-soft again, now that the field is gentler", () => {
    const rule = homePage().match(/\.scrollcue \{[^}]*\}/)?.[0] ?? "";
    assert.match(rule, /color:var\(--ink-soft\)/);
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
  test("reduced motion means no pointer listener and no animation loop", () => {
    /**
     * The earlier version of this asserted that the string
     * "prefers-reduced-motion" appeared before the first `addEventListener`.
     * That passes on the *declaration* of the flag and says nothing about the
     * early return — it would have gone on passing if the guard moved to the
     * bottom of the file. Another test passing for a reason unrelated to the
     * thing it names.
     *
     * What actually matters is that `if (still) return;` sits above the
     * pointermove binding and above the loop that schedules frames.
     */
    const body = HERO_JS.slice(HERO_JS.indexOf("(function"));
    const guard = body.indexOf("if (still) return;");
    const pointer = body.indexOf("'pointermove'");
    const loop = body.lastIndexOf("requestAnimationFrame(step)");
    assert.ok(guard > -1, "there is no early return at all");
    assert.ok(pointer > -1 && loop > -1, "the listener or the loop got renamed");
    assert.ok(guard < pointer, "the guard must precede the pointermove binding");
    assert.ok(guard < loop, "the guard must precede the frame loop being started");
  });

  test("nothing is allocated in the hot loop", () => {
    /**
     * This *is* a particle field now — Kelly asked for the dots back. What made
     * the original unusable was never the dots, it was the loop: five Vector3
     * objects per particle per frame, ~200,000 allocations at 60fps, all
     * collected again immediately.
     *
     * Here position, velocity and origin live in Float32Arrays and every line of
     * `step` is scalar arithmetic on numbers already in them. If `new` or an
     * object literal ever appears inside that function, the property that makes
     * 5,200 dots cost 8ms a frame is gone.
     */
    const step = HERO_JS.slice(HERO_JS.indexOf("function step"), HERO_JS.indexOf("window.addEventListener('resize'"));
    assert.ok(step.length > 200, "step() was not found — did it get renamed?");
    assert.doesNotMatch(step, /\bnew [A-Z]/, "no constructor calls per frame");
    assert.doesNotMatch(step, /[[{]\s*\w+\s*,/, "no array or object literals per frame");
    assert.match(HERO_JS, /Float32Array/, "flat arrays are the whole trick");
  });

  test("the draw is batched by tone rather than set per dot", () => {
    // fillStyle is a state change; assigning it 5,200 times a frame costs more
    // than the arithmetic does. Five assignments, one per grey.
    const draw = HERO_JS.slice(HERO_JS.indexOf("function draw"), HERO_JS.indexOf("function step"));
    assert.match(draw, /for \(var t = 0; t < TONES\.length/, "outer loop is the tone");
    assert.equal(draw.match(/fillStyle/g)?.length, 1, "assigned once per tone, not once per dot");
  });

  test("the dots are grey, with no chroma anywhere", () => {
    // The original tinted every particle with setHSL(Math.random(), 0.8, …) —
    // full-spectrum confetti, against a reference board with no colour on it.
    const tones = HERO_JS.match(/var TONES = \[([^\]]+)\]/)?.[1] ?? "";
    const hexes = tones.match(/#[0-9A-Fa-f]{6}/g) ?? [];
    assert.ok(hexes.length >= 3, "there is a tone ramp");
    for (const hex of hexes) {
      const n = parseInt(hex.slice(1), 16);
      const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
      const spread = Math.max(r, g, b) - Math.min(r, g, b);
      assert.ok(spread <= 14, `${hex} has a channel spread of ${spread} — that is a colour, not a grey`);
    }
    assert.doesNotMatch(HERO_JS, /setHSL|hsl\(/, "no hue generation at all");
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

  test("a still frame is still painted when motion is refused", () => {
    // Not a blank hero. `resize()` runs — and therefore `draw()` — before the
    // early return, so someone with the setting on sees the composition, just
    // not the movement. The resize listener is bound before the guard on
    // purpose, so the still frame survives a window resize.
    const body = HERO_JS.slice(HERO_JS.indexOf("window.addEventListener('resize'"));
    assert.match(body, /resize\(\);\s*\n\s*\n?\s*if \(still\) return;/, "paint, then stop");
  });
});

/**
 * Who writes the audits, said out loud.
 *
 * Until 2026-08-25 the word "AI" appeared on no page this product serves. What
 * appeared instead was "reviewers", "your team", "we", and — on the waiting
 * page — "a person starts each audit by hand" and "last checks before a person
 * reads it". Every one of those is a sentence a customer reads as people, two
 * of them were by then false outright, and the product had already taken money
 * from someone on the strength of the impression.
 *
 * The word is accurate for six sub-agents, so it stays. What it cannot do is
 * arrive unqualified: the first use on each surface says "AI reviewers", and
 * these tests are what stops that slipping back to the shorter, friendlier,
 * more misleading version.
 */
describe("the site says who writes the audits", () => {
  /**
   * Phrases that put a human where there is not one. `your team` was the
   * waiting page's fallback string for its whole life; `by hand` and
   * `a person starts` were true until `worker.ts` shipped.
   *
   * Not on this list: "a person checks it" and "read by a person", which are
   * real and conditional — the founder gate still exists for the ~4% of audits
   * where `claims.ts` disagrees with a finding, and those pages are entitled to
   * say so. The rule is not "never mention a human". It is "never mention one
   * who was not there".
   */
  const IMPLIES_A_HUMAN = [/your team/i, /\bby hand\b/i, /a person starts/i];

  const SURFACES: [string, () => string][] = [
    ["the homepage", homePage],
    ["the question flow", () => questionsPage()],
  ];

  for (const [name, render] of SURFACES) {
    test(`${name} names the reviewers as AI before it calls them reviewers`, () => {
      const html = render();
      const first = html.toLowerCase().indexOf("reviewer");
      assert.notEqual(first, -1, `${name} talks about reviewers, or this test is aimed wrong`);
      // Look at the twenty characters in front of the first mention rather than
      // asserting the whole sentence: the copy is allowed to be rewritten, the
      // qualifier is not allowed to be dropped.
      const before = html.slice(Math.max(0, first - 20), first).toLowerCase();
      assert.match(before, /\bai\b/, `${name} says "reviewers" before it says AI`);
    });

    test(`${name} claims no people it does not have`, () => {
      const html = render();
      for (const phrase of IMPLIES_A_HUMAN) {
        assert.doesNotMatch(html, phrase, `${name} still suggests a person: ${phrase}`);
      }
    });
  }

  test("the disclosure is not in the small print", () => {
    /**
     * The one thing a disclosure can do wrong while being technically present.
     * `.aside` is this page's footnote voice — 13px, ink-soft, forty pixels
     * below whatever it qualifies — and it is where a sentence goes when the
     * layout would rather you did not read it. The disclosure sits in the
     * "What we do" section, directly under the claim it qualifies, above the
     * fold's first rule.
     */
    const html = homePage();
    const disclosure = html.indexOf("AI reviewers");
    const firstRule = html.indexOf(`<div class="rule">`);
    assert.notEqual(disclosure, -1);
    assert.ok(
      disclosure < firstRule,
      "the disclosure is below the first section break, where nobody reads",
    );
    assert.doesNotMatch(
      html.slice(disclosure - 200, disclosure),
      /class="aside"/,
      "the disclosure is set in the footnote voice",
    );
  });
});


/**
 * What a customer is told about their own money.
 *
 * This page renders from one row and nothing else — no card, no last-four, no
 * expiry, because `results.html` promises the reader that card details never
 * touch us and a placeholder would imply they had. What it does hold is the
 * status, and until 2026-08-25 it printed that status straight into the markup
 * for every state except `active`.
 */
describe("the billing tab gives each state its own words", () => {
  const view = (over: Partial<Parameters<typeof billingPage>[1]> = {}) =>
    billingPage("someone@example.com", {
      status: "active",
      renewsAt: "2026-10-25T20:06:12.000Z",
      manageable: true,
      csrf: "c",
      ...over,
    });

  test("no state renders the column value", () => {
    /**
     * The whole class of bug in one assertion. `past_due` is a value in a
     * SQLite column, and it reached a real customer's screen because the page
     * had a branch for `active` and an `else` for everything else.
     */
    for (const status of ["active", "past_due", "canceled", null] as const) {
      const html = view({ status });
      assert.doesNotMatch(html, /past_due|canceled\b/, `${status} leaks the column value`);
    }
  });

  test("a refused card is not reported as having no subscription", () => {
    /**
     * Measured live on 2026-08-25, against a Stripe test clock with a declining
     * card. The page said, in this order: `past_due`, "Access ran to
     * 2026-10-25", and "There is no active subscription on this address."
     *
     * The third line is the one that matters. There *is* a subscription —
     * Stripe is retrying the card and will go on retrying it for days. Denying
     * that it exists to someone who is still being charged for it is the
     * worst available sentence, and it was the last thing on the page.
     */
    const html = view({ status: "past_due" });
    assert.doesNotMatch(
      html,
      /no active subscription/i,
      "the subscription exists; Stripe is still trying the card",
    );
    assert.match(html, /Payment failed/, "say what happened");
    assert.match(html, /try it again/i, "and that it is not over yet");
  });

  test("a refused card shows no date at all", () => {
    /**
     * Stripe advances `current_period_end` when it raises the invoice, so a
     * failed renewal leaves a *future* date in the row — and the page rendered
     * it under "Access ran to", which is both the wrong tense and the wrong
     * month. The date a customer would want is when the card was refused, and
     * that is not something this row holds.
     */
    const html = view({ status: "past_due" });
    assert.doesNotMatch(html, /2026-10-25/, "that date is the end of a month nobody paid for");
    assert.doesNotMatch(html, /Access ran to|Runs to/, "no date label without a date to put in it");
  });

  test("the button names the one thing a refused card needs", () => {
    assert.match(view({ status: "past_due" }), /<button[^>]*>Update your card<\/button>/);
    assert.match(view({ status: "active" }), /<button[^>]*>Manage billing<\/button>/);
  });

  test("the states that were already right stayed right", () => {
    // The refactor from a ternary chain to a switch is the kind that quietly
    // rewords a branch nobody was looking at.
    assert.match(view({ status: "active" }), /<dd>Active<\/dd>/);
    assert.match(view({ status: "active" }), /Runs to<\/dt><dd>2026-10-25/);

    const cancelled = view({ status: "canceled" });
    assert.match(cancelled, /<dd>Cancelled<\/dd>/);
    assert.match(cancelled, /Access ran to<\/dt><dd>2026-10-25/);
    assert.match(cancelled, /no active subscription/i, "true here, and only here");

    // manageable:false because the server cannot produce the other combination
    // — `manageable` is `Boolean(billing && row?.stripe_customer_id)`, and with
    // no row there is no customer id. The first draft of this test passed
    // `true` and failed here, which is the fixture being wrong rather than the
    // page.
    const none = view({ status: null, renewsAt: null, manageable: false });
    assert.match(none, /No subscription on this address/);
    assert.doesNotMatch(none, /<button/, "nothing to manage");
  });
});

describe("the dashboard agrees with the billing tab about who is paying", () => {
  const dash = (sub: Parameters<typeof accountPage>[2]) =>
    accountPage("someone@example.com", [], sub);

  test("a failed payment is not the absence of a subscription", () => {
    /**
     * The same defect as the billing tab's "There is no active subscription on
     * this address", reached from the other direction: this page took a single
     * `subscribed: boolean`, so every state that was not paid-and-current
     * collapsed into one word. A customer whose card Stripe is still retrying
     * was told, on two tabs at once, that they had no subscription.
     */
    assert.match(dash({ active: false, status: "past_due" }), /payment failed/);
    assert.doesNotMatch(dash({ active: false, status: "past_due" }), /no subscription/);
  });

  test("the other two states keep their words", () => {
    assert.match(dash({ active: true, status: "active" }), /&middot; subscribed/);
    assert.match(dash({ active: false, status: "canceled" }), /no subscription/);
    assert.match(dash({ active: false, status: null }), /no subscription/);
  });

  test("an active row whose period has run out is not subscribed", () => {
    // `active` and `isActive` are different questions — db.ts refuses access on
    // a row that says active with an expired period end, and this page has to
    // ask the same one it does.
    assert.doesNotMatch(dash({ active: false, status: "active" }), /&middot; subscribed/);
  });
});

/**
 * Branding on the pages a customer actually lives on.
 *
 * The homepage has carried a wordmark since it was built. Nothing else did — so
 * someone who followed a magic link into their dashboard was on an unbranded
 * page with no way back to the site, which is the one journey this product's
 * paying customers take most often.
 */
describe("the wordmark is on every page that is not the homepage", () => {
  const shells = {
    "sign-in": () => signInPage(),
    dashboard: () => accountPage("a@b.com", [], { active: true, status: "active" }),
    billing: () =>
      billingPage("a@b.com", { status: "active", renewsAt: null, manageable: false, csrf: "c" }),
    schedule: () => schedulePage("a@b.com"),
  };

  for (const [name, render] of Object.entries(shells)) {
    test(`${name} carries it, and it goes home`, () => {
      const html = render();
      assert.match(html, /<a class="brandmark" href="\/"><svg class="mark"/, name);
    });
  }

  /**
   * The regression that replacing words with a picture invites.
   *
   * Until 2026-08-26 the mark was the literal text "The Usability Lab" inside an
   * `<a>`, so its accessible name was free and could not be lost. It is now an
   * `<svg>`, which has no accessible name by default — an unlabelled one is
   * announced as nothing at all, and the link home on every logged-in page
   * becomes an anonymous link. Nothing on screen changes when this breaks.
   */
  test("the mark is announced, not just drawn", () => {
    for (const [name, render] of Object.entries(shells)) {
      const html = render();
      assert.match(html, /role="img"/, `${name}: the svg is not exposed as an image`);
      assert.match(
        html,
        /aria-label="The Usability Lab"/,
        `${name}: the mark has no accessible name, so the link home is announced as nothing`,
      );
    }
    assert.match(homePage(), /aria-label="The Usability Lab"/, "homepage");
  });

  test("it takes its colours from the palette, not from black and white", () => {
    /**
     * The supplied artwork is `#000` on `#FFF`. The palette note in
     * `marketing.ts` argues that pure white reads wrong beside these warm
     * neutrals, and pure black reads as a second, colder ink beside `--ink`.
     * Hardcoding the file's own values would put two inks on one page and it
     * would look like a rendering bug rather than a decision.
     */
    const css = accountPage("a@b.com", [], { active: true, status: "active" });
    assert.match(css, /\.mark \.slab \{ fill:var\(--ink\); \}/);
    assert.match(css, /\.mark \.word \{ fill:var\(--paper\); \}/);
    assert.doesNotMatch(
      css.slice(css.indexOf(".mark"), css.indexOf("</style>")),
      /fill:\s*(#000|#fff|black|white)\b/i,
      "the mark is painted with literal black or white instead of the palette",
    );
  });

  test("the page's own title still clears the mark", () => {
    /**
     * Measured, not eyeballed, because eyeballing it is what missed it.
     *
     * The mark is `position:absolute`, so nothing in the flow knows how tall it
     * is. At the first size that made the letters legible — 240px, up from the
     * 156px that rendered as a smudge — the slab reached y=96 and `.wrap` began
     * its content at exactly y=96. On a 390px screen the corner of the slab sat
     * on the word "Your" in "Your audits".
     *
     * The artwork is 438x121, so its height is fixed by its width. That makes
     * this a relationship between two numbers in the stylesheet rather than
     * something only a screenshot can see — which is the difference between a
     * test that holds and one that has to be re-checked by hand every time
     * somebody nudges the mark.
     */
    const html = accountPage("a@b.com", [], { active: true, status: "active" });
    const ASPECT = 121 / 438;

    const clears = (label: string, block: string) => {
      const top = Number(block.match(/\.brandmark \{[^}]*top:(\d+)px/)?.[1]);
      const width = Number(block.match(/\.brandmark \{[^}]*width:(\d+)px/)?.[1]);
      const pad = Number(block.match(/\.wrap \{ padding-top:(\d+)px; \}/)?.[1]);
      assert.ok(top && width && pad, `${label}: could not read top/width/padding back out`);
      const bottom = top + width * ASPECT;
      assert.ok(
        pad > bottom,
        `${label}: the mark ends at ${bottom.toFixed(0)}px and the content starts at ${pad}px`,
      );
    };

    // Anchored on the mark's own block. The base stylesheet has a
    // `@media (max-width:600px)` of its own, earlier in the document, and
    // splitting the whole page on the first one lands in the wrong rules.
    const css = html.slice(html.indexOf(".brandmark {"));
    const narrowAt = css.indexOf("@media (max-width:600px)");
    assert.notEqual(narrowAt, -1, "the mark has no narrow-screen rules");
    clears("wide", css.slice(0, narrowAt));
    clears("narrow", css.slice(narrowAt));
  });

  test("each shell asks for the correction its own size needs", () => {
    /**
     * `markCss` decides whether to emit the hairline correction from the width
     * it is told the mark is drawn at. That makes every call site's argument a
     * claim about its own CSS, and nothing inside `brand.ts` can check it —
     * pass 438 for a mark rendered at 190 and it silently goes uncorrected.
     *
     * So the check belongs here, where both numbers are visible: the account
     * shells draw at 240 and must carry it; the hero draws large and must not,
     * because at that size the letters already reach paper and the stroke would
     * only make the logo bolder than Kelly drew it.
     *
     * **Inverted 2026-08-27, and the old assertion is the point.** This read
     * `assert.doesNotMatch(homePage(), /stroke-width/)` — "the hero is 438px and
     * would be permanently heavier than the artwork" — which was true of the
     * whole document only because the homepage's *narrow* mark was going
     * uncorrected too, at 296px on a phone. Fixing that put a `stroke-width`
     * into the homepage for the first time, and this test failed for telling
     * the truth. Kept and narrowed rather than deleted: the claim it was making
     * about the hero is still one worth holding, so it is now made against the
     * hero's own rules instead of against the file.
     */
    const dash = accountPage("a@b.com", [], { active: true, status: "active" });
    assert.match(dash, /max-resolution:1\.4dppx/, "the 240px mark is drawn without the correction");
    assert.match(dash, /stroke-width:0\.6px/);

    // Everything before the narrow query, not just the .brandmark rule: a
    // stroke declared anywhere above it applies to the hero just as well, and
    // slicing from `.brandmark {` looked at a window that a revert stepped
    // straight over — the guard passed while the hero was being bolded.
    const home = homePage();
    const beforeNarrow = home.slice(0, home.indexOf("@media (max-width:640px)"));
    assert.doesNotMatch(
      beforeNarrow,
      /stroke-width/,
      "the hero is drawn above the threshold and would be permanently heavier than the artwork",
    );
    assert.match(
      home.slice(home.indexOf("@media (max-width:640px)")),
      /stroke-width:0\.6px/,
      "the phone draws the same mark small and needs the correction the hero does not",
    );
  });

  test("the slab runs off the left edge, and the letters stay where they are", () => {
    /**
     * Asked for on 2026-08-26: the account mark should bleed like the hero's
     * instead of floating in the corner.
     *
     * The hero does it by pulling the element left. That does not transfer — at
     * 240px the letters begin 14px into the box, so any offset large enough to
     * read as a bleed clips the T, which was tried and reads as broken. So the
     * element does not move at all and a pseudo-element carries the slab off the
     * edge instead. `left` staying positive is therefore part of the fix, not an
     * accident: it is what keeps the letters clear of the screen edge.
     */
    for (const [name, render] of Object.entries(shells)) {
      const html = render();
      assert.match(html, /\.brandmark::before \{ content:""/, `${name}: no bleed strip`);
    }

    const css = accountPage("a@b.com", [], { active: true, status: "active" });
    const rule = css.slice(css.indexOf(".brandmark {"), css.indexOf(".brandmark:hover"));
    const left = Number(rule.match(/left:(-?\d+)px/)?.[1]);
    assert.ok(left > 0, `the mark itself is offset to ${left}px; the strip should do the bleeding`);
  });

  test("the bleed strip has something positioned to hang off", () => {
    /**
     * `bleedCss` deliberately emits no `position`, because declaring
     * `position:relative` would drop this mark back into the flow it is
     * positioned out of. That makes the pairing a thing two files have to agree
     * on and neither can check alone — so it is checked here, where both halves
     * are in the same string.
     *
     * Unpaired, the strip positions against the viewport instead of the mark and
     * lands somewhere unrelated to the slab.
     */
    const css = accountPage("a@b.com", [], { active: true, status: "active" });
    const rule = css.slice(css.indexOf(".brandmark {"), css.indexOf("}", css.indexOf(".brandmark {")));
    assert.match(rule, /position:(absolute|relative|fixed|sticky)/, "the strip has no anchor");
  });

  test("the mark is at full contrast when nobody is pointing at it", () => {
    // It was `opacity:.92` at rest, which spent 8% of the contrast between the
    // paper letters and the ink slab on strokes already losing ink to
    // antialiasing. A hover state can afford that; a resting state cannot.
    const css = accountPage("a@b.com", [], { active: true, status: "active" });
    const rest = css.slice(css.indexOf(".brandmark {"), css.indexOf(".brandmark:hover"));
    assert.doesNotMatch(rest, /opacity:0?\.\d/, "the resting mark is dimmed");
    assert.match(css, /\.brandmark:hover \{ opacity:\.78; \}/, "and hover still gives feedback");
  });

  test("the homepage keeps its own, larger one", () => {
    // Same artwork, deliberately not the same placement: the hero runs it off
    // the left edge, which only reads as intentional with room around it. See
    // the note on BRANDMARK for why the dashboard's is whole and inset.
    const home = homePage();
    assert.match(home, /<div class="brandmark"><svg class="mark"/);
    const heroWidth = Number(home.match(/\.brandmark \{[^}]*width:min\((\d+)px/)?.[1]);
    const pageWidth = Number(
      accountPage("a@b.com", [], { active: true, status: "active" }).match(
        /\.brandmark \{[^}]*width:(\d+)px/,
      )?.[1],
    );
    assert.ok(heroWidth > pageWidth, `hero ${heroWidth}px must stay larger than page ${pageWidth}px`);
    assert.match(home, /left:-\d+px/, "and it bleeds off the left edge");
  });
});

/**
 * `/start`, which kept the old wordmark for a day after everything else took the
 * artwork — added 2026-08-27.
 *
 * It is the only shell whose mark sits in the flow rather than on top of it, and
 * that is the whole of what these guard. Everywhere else `.brandmark` is
 * `position:absolute`, which is both what takes it out of the flow and what
 * gives `bleedCss`'s strip something to be absolute against. In the flowbar the
 * mark has to stay a flex item beside the step counter, so it is the one caller
 * that must ask for a containing block itself.
 */
/**
 * The homepage nav, added 2026-08-27 at Kelly's request.
 *
 * A `<details>` and not a scripted button, so the whole of open/close, keyboard
 * and the screen-reader announcement come from the browser and survive the
 * script being blocked. `MENU_JS` adds only outside-click and Escape.
 */
describe("the homepage's menu", () => {
  test("it opens without a script, because it is a disclosure and not a widget", () => {
    /**
     * The guard that matters most and is the easiest to lose: someone rebuilds
     * this as `<button>` plus a click handler and it behaves identically in
     * every manual test, because the tester has JavaScript. Then CSP blocks the
     * script, or it throws before this line, and the only navigation on the
     * homepage is a button that does nothing.
     */
    const html = homePage();
    assert.match(html, /<details class="menu" id="menu">/);
    assert.match(html, /<summary>Menu/, "the summary is what makes it operable with no script");
  });

  test("it holds the two destinations, at the addresses the server serves", () => {
    const html = homePage();
    const panel = html.slice(html.indexOf('<div class="menu-items">'), html.indexOf("</details>"));
    assert.match(panel, /<a href="\/about">About<\/a>/);
    // `/sign-in` reads more naturally and 404s. server.ts serves `/signin`.
    assert.match(panel, /<a href="\/signin">Sign in<\/a>/);
    assert.doesNotMatch(panel, /href="\/sign-in"/, "that route does not exist");
  });

  test("the panel is inside the details, or it never hides", () => {
    // Outside it, `.menu-items` is simply a visible box: `<details>` only hides
    // what it contains. It would look like an always-open menu, which is the
    // kind of break that reads as a design choice.
    const html = homePage();
    const details = html.slice(html.indexOf('<details class="menu"'), html.indexOf("</details>"));
    assert.match(details, /menu-items/);
  });

  test("the two links are in a labelled landmark", () => {
    assert.match(homePage(), /<nav class="menu-wrap" aria-label="Main">/);
  });

  test("the wrapper is what is positioned, not the details", () => {
    /**
     * `.hero` is `display:flex`. A statically positioned `<nav>` inside it is a
     * flex item and shifts the centred hero content left by its own width —
     * while the menu itself still looks right, because the panel is absolute
     * either way. The symptom is a hero that is subtly off-centre and a menu
     * that looks fine, which is not a symptom anyone traces to the menu.
     */
    const css = homePage();
    const wrap = css.slice(css.indexOf(".menu-wrap {"), css.indexOf("}", css.indexOf(".menu-wrap {")));
    assert.match(wrap, /position:absolute/, "the nav is in the hero's flex flow and moving it");
  });

  test("its script is named in the policy, alongside the hero's", () => {
    // Two `<script>` elements, so two hashes: CSP hashes each element's own
    // text and a single hash of the pair would match neither.
    for (const [name, js] of [["hero", HERO_JS], ["menu", MENU_JS]] as const) {
      const digest = createHash("sha256").update(js, "utf8").digest("base64");
      assert.ok(HOME_CSP.includes(`'sha256-${digest}'`), `${name}: not covered by HOME_CSP`);
    }
    assert.doesNotMatch(HOME_CSP, /script-src[^;]*unsafe-inline/);
  });

  test("closing is an enhancement, so nothing in it may be load-bearing", () => {
    // If this script ever became the thing that opens the menu, the test above
    // about `<details>` would still pass while the menu stopped working without
    // it. Assert it only ever *closes*.
    assert.doesNotMatch(MENU_JS, /\.open\s*=\s*true/, "MENU_JS has taken over opening the menu");
    assert.match(MENU_JS, /if \(!menu\) return/, "it must survive the element being absent");
  });
});

describe("the homepage mark, 15% smaller", () => {
  test("the hero is still drawn above the width where letters lose ink", () => {
    // 372px, down from 438. Still clear of the threshold, so the hero must not
    // have picked up the hairline stroke and been quietly bolded.
    const css = homePage();
    const wide = Number(css.match(/\.brandmark \{[^}]*width:min\((\d+)px/)?.[1]);
    assert.ok(wide, "could not read the hero width back out");
    assert.ok(wide >= MARK_RESOLVES_ABOVE, `${wide}px would need a correction the hero does not get`);
  });

  test("the phone's mark is below that width, and does get the correction", () => {
    /**
     * The gap the resize uncovered, and it predates the resize: `HERO_MARK_CSS`
     * is compiled at the hero's widest — which is what `drawnAt` means — so it
     * emits nothing, and the narrow rule then draws the same mark at 255px. The
     * old narrow rule was `min(300px,76vw)`, which looks like it sits exactly on
     * the threshold and does not: the vw term wins under 395px.
     */
    const css = homePage();
    const narrowBlock = css.slice(css.indexOf("@media (max-width:640px)"));
    const narrow = Number(narrowBlock.match(/\.brandmark \{[^}]*width:min\((\d+)px/)?.[1]);
    assert.ok(narrow, "could not read the narrow width back out");
    assert.ok(narrow < MARK_RESOLVES_ABOVE, `${narrow}px is above the threshold; drop the correction`);
    assert.match(
      narrowBlock,
      /stroke-width:0\.6px/,
      "the phone draws the mark small with no correction, as it did before this was noticed",
    );
  });

  test("the correction is scoped to the query that made the mark small", () => {
    // At the top level it would apply to the hero too, which is the +37% ink
    // mistake `brand.ts` records. It has to sit inside `max-width:640px`.
    /**
     * Sliced from the top of the document, not from `.brandmark {`. A revert
     * that inserted the stroke one line *above* that rule left this green while
     * the hero was being bolded — the injected rule was outside the window, and
     * the window was the only reason the test passed.
     */
    const css = homePage();
    const wideOnly = css.slice(0, css.indexOf("@media (max-width:640px)"));
    assert.doesNotMatch(wideOnly, /stroke-width/, "the hero would be bolder than the artwork");
  });
});

/**
 * A phone turned sideways — added 2026-08-27.
 *
 * **What these can and cannot prove.** The real invariant is geometric: at
 * 844x390 the mark's bottom edge was 145 and the h1's top was 63, so the words
 * "A design" were painted over. Proving that needs layout, and this suite has no
 * browser in it — 881 tests in eight seconds is worth more than one test that
 * could measure it. So the geometry was verified out of band, by rendering
 * eleven viewport sizes and asserting no intersection between the mark, the menu
 * and the h1, and that the button stays above the fold. All eleven clear.
 *
 * What is left here is the shape of the rule that made it true. Weak, and said
 * so — but it catches the edits that would undo it without anyone looking at a
 * phone: the block being deleted, reordered, or quietly reduced to half the fix.
 */
describe("the homepage on a short screen", () => {
  const shortAt = (css: string) => css.indexOf("@media (max-height:520px)");

  test("there is a rule keyed to height, not only to width", () => {
    const css = homePage();
    assert.ok(shortAt(css) > 0, "nothing responds to a short viewport; the mark will cover the h1");
  });

  test("both the mark and the type come down, not one of them", () => {
    /**
     * Shrinking only the type leaves the mark dominating a 390px-tall screen;
     * shrinking only the mark leaves the h1 filling it and the two still meet.
     * Either half alone looks like a fix and measures like a failure.
     */
    const css = homePage();
    const block = css.slice(shortAt(css));
    assert.match(block, /\.brandmark \{[^}]*width:min\(\d+px/, "the mark keeps its full size");
    assert.match(block, /\.hero-in h1 \{[^}]*font-size:\d+px/, "the headline keeps its full size");
  });

  test("the short rule is smaller than the rules it overrides", () => {
    // Read back and compared rather than pinned to literals: what matters is
    // the direction, and a pinned 27 would have to be edited to retune it.
    const css = homePage();
    const size = (from: number) =>
      Number(css.slice(from).match(/\.hero-in h1 \{[^}]*font-size:(\d+)px/)?.[1]);
    const base = size(css.indexOf(".hero-in h1 {"));
    const short = size(shortAt(css));
    assert.ok(base && short, `could not read both headline sizes (${base}, ${short})`);
    assert.ok(short < base, `the short-screen headline is ${short}px against a base of ${base}px`);
  });

  test("it comes after the width rule, or it loses to it", () => {
    /**
     * Load-bearing ordering. A small phone in landscape matches both queries and
     * they set the same properties at the same specificity, so the later one
     * wins. Move this above `max-width:640px` and it silently stops applying on
     * exactly the devices it was written for — while still applying on a short
     * *wide* window, which is where anyone would test it.
     */
    const css = homePage();
    assert.ok(
      shortAt(css) > css.indexOf("@media (max-width:640px)"),
      "the short-screen rule is being overridden by the narrow rule on phones",
    );
  });

  test("the smaller mark still gets its ink back", () => {
    // 172px, further under the threshold than either other size. The correction
    // has to be inside this query too — it is not inherited from the one above.
    const css = homePage();
    assert.match(css.slice(shortAt(css)), /stroke-width:0\.6px/);
  });
});

describe("the about page", () => {
  test("it says what Kelly wrote, in Kelly's words", () => {
    /**
     * Copy supplied by the owner, set verbatim. Paraphrasing it in a later edit
     * is the failure this guards — particularly the last sentence of the second
     * paragraph, which is a promise about honesty and is the one claim on the
     * page the product has to keep.
     */
    const html = aboutPage();
    for (const phrase of [
      "you can see your\n        conversions leaking",
      "Automated checkers flag broken links",
      "Six specialist\n        agents review your page",
      "honestly marked\n        &ldquo;no source found.&rdquo;",
      "Every time you ship, we critique",
    ]) {
      assert.ok(html.includes(phrase), `the about copy no longer contains: ${phrase.slice(0, 40)}`);
    }
  });

  test("it is the shared shell, so it carries the mark and the way home", () => {
    const html = aboutPage();
    assert.match(html, /<a class="brandmark" href="\/"><svg class="mark"/);
    assert.match(html, /<title>About — The Usability Lab<\/title>/);
  });

  test("it runs no script, and so must not be served a policy that allows one", () => {
    // The route hands it MARKETING_CSP rather than HOME_CSP. This half of that
    // decision — that there is nothing here needing a script — lives here.
    assert.doesNotMatch(aboutPage(), /<script/);
  });
});

describe("the stepped flow carries the artwork, not the name in letter-spacing", () => {
  test("the mark is drawn and it goes home", () => {
    const html = questionsPage();
    assert.match(html, /<a class="flowmark" href="\/"><svg class="mark"/);
    assert.doesNotMatch(
      html,
      />The Usability Lab</,
      "the flow is back to drawing the name as text, so /start has a different logo from every other page",
    );
  });

  test("the mark is announced, not just drawn", () => {
    const html = questionsPage();
    assert.match(html, /role="img"/);
    assert.match(html, /aria-label="The Usability Lab"/);
  });

  test("it asks for its own containing block, which no other caller has to", () => {
    /**
     * The silent one. `bleedCss` emits no `position` on purpose — its other
     * callers are absolute already and `position:relative` would drop them back
     * into the flow they were taken out of. Drop `position:relative` here and
     * nothing errors: the strip goes absolute against whatever ancestor happens
     * to be positioned, or the viewport, and paints a black bar somewhere else
     * on the page entirely. The mark itself still looks perfect.
     */
    const css = questionsPage();
    const rule = css.slice(css.indexOf(".flowmark {"), css.indexOf("}", css.indexOf(".flowmark {")));
    assert.match(rule, /position:relative/, "the bleed strip has nothing to be positioned against");
    assert.match(css, /\.flowmark::before \{ content:""/, "no bleed strip");
  });

  test("the bar keeps padding for the strip to run across", () => {
    // A strip that starts at x=0 is a strip nobody sees: it extends leftward off
    // the screen and paints nothing. The bleed reads only because the mark is
    // inset by the bar's own padding and the slab fills that gap.
    const css = questionsPage();
    const pad = Number(css.match(/\.flowbar \{[^}]*padding:\d+px (\d+)px/)?.[1]);
    assert.ok(pad > 0, `the mark sits flush at ${pad}px, so the bleed paints off-screen only`);
  });

  test("both widths are in the range the hairline correction is compiled for", () => {
    /**
     * One `markCss` call serves the wide and narrow rules, and it bakes in a
     * decision made from a single number: below 300px the stroke is emitted,
     * above it is not. Two widths straddling that line would give the phone a
     * correction the desktop silently lacks, or the reverse.
     */
    const css = questionsPage();
    const wide = Number(css.match(/\.flowmark \{[\s\S]*?width:(\d+)px/)?.[1]);
    const narrow = Number(css.match(/@media \(max-width:600px\)[\s\S]*?\.flowmark \{ width:(\d+)px/)?.[1]);
    assert.ok(wide && narrow, `could not read both widths back out (${wide}, ${narrow})`);
    assert.ok(narrow < wide, "the phone should get the smaller mark, not the larger");
    assert.match(css, /stroke-width:0\.6px/, "neither width gets the ink put back");
    assert.ok(wide < 300 && narrow < 300, "one of these widths is above the threshold the other is below");
  });

  test("it is not smaller than the size that was rejected as mush", () => {
    // 156px was tried on the dashboard and read as a smudge. This bar is the
    // most tempting place to go smaller — it is chrome, and the mark is by far
    // the tallest thing in it.
    const css = questionsPage();
    const wide = Number(css.match(/\.flowmark \{[\s\S]*?width:(\d+)px/)?.[1]);
    assert.ok(wide > 156, `${wide}px is at or below the width already found illegible`);
  });
});
