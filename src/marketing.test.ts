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
  billingPage,
  accountPage,
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
