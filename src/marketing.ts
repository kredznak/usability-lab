/**
 * Every surface that is not a rendered audit — the shell, the homepage, the
 * question flow — and the Content-Security-Policy strings they need.
 *
 * ## Why this file exists at all
 *
 * `server.ts` was 1073 lines and held the only HTML in the repo that is not an
 * audit: a `page()` frame, a question form, and a `<style>` block written by
 * hand next to the one in `render.ts`. The two had already drifted — same hexes,
 * typed twice, one of them wrapped in `:root` variables and the other not.
 *
 * Splitting them apart draws the line the design actually has. `render.ts`
 * renders audits and keeps its own warm-editorial look; this file renders
 * everything a visitor sees *before* an audit exists, and follows
 * `docs/specs/2026-08-20-homepage-design.md`.
 *
 * ## Why the policies live here and not next to `send()`
 *
 * Two of the three are derived from the stepper script, and the stepper script
 * lives in this file. Holding them in `server.ts` would mean `server.ts`
 * importing the script in order to hash it while this file imported `server.ts`
 * for the base policy — a cycle, to share three strings. So: `server.ts` imports
 * this, and this imports nothing of `server.ts`.
 */

import { createHash } from "node:crypto";
import { SOURCES } from "./sources.js";
import { QUESTIONS, type Answers } from "./profile.js";
import { PRICE_USD, escapeHtml } from "./render.js";
import { SITE_LIMIT, AUDITS_PER_MONTH } from "./fairuse.js";
import type { SubscriptionStatus } from "./db.js";
import { MARK, markCss } from "./brand.js";

/**
 * What every response gets unless it asks for otherwise — unchanged from the
 * policy that has been on every response since the server shipped.
 *
 * `default-src 'none'` is the part doing the work. It denies scripts, fonts,
 * frames, connections and everything else not explicitly allowed back. An audit
 * page quotes text captured from a stranger's site, so a `<script>` smuggled
 * through a finding must have nowhere to run — that is a real control against a
 * real threat model, and it is not loosened for a marketing page.
 *
 * `send()` takes this as a default rather than hardcoding it, so a route added
 * later by somebody not thinking about headers comes out locked down. Anything
 * that needs more has to say so at the call site.
 *
 * ## `frame-ancestors 'none'`, spelled out because it looks redundant
 *
 * It is not covered by `default-src 'none'`. `frame-ancestors` is one of the
 * few directives with **no fallback to `default-src`** — the others being
 * `report-uri`, `sandbox` and `base-uri` — so a policy that opens with
 * `default-src 'none'` and stops there still permits the page to be framed by
 * anybody. Read quickly, this line is noise; deleted, every page here is
 * frameable.
 *
 * Added 2026-08-22, when the site went onto a public hostname. It cost nothing
 * on a laptop and it costs nothing now — but `/a/<id>/subscribe` is a button
 * that spends a customer's money, and UI-redress is the attack that exists for
 * buttons like that. The CSRF token bounds it; this closes it.
 */
export const STRICT_CSP =
  "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; frame-ancestors 'none'";

/**
 * What the marketing surfaces need on top of strict: one font, from us.
 *
 * `font-src 'self'` and nothing else. These pages still run no script — only
 * `/start` does, and it names its one script by hash rather than widening this.
 */
export const MARKETING_CSP = `${STRICT_CSP}; font-src 'self'`;

/**
 * The token set — `docs/specs/2026-08-20-homepage-design.md` §3.1.
 *
 * ## Every white here is warm
 *
 * That is not taste, it is the reference board: plaster, limestone, bone. There
 * is no pure white on any of those six images and no cool tone either, so
 * `#FFFFFF` would read wrong beside them. `--paper` is the pre-existing `--bg`
 * from render.ts, which survived the redesign unchanged — the one token that
 * was already right.
 *
 * `--ink` moves from a neutral `#1a1a1a` to a warm `#26221E`, because a neutral
 * black on a warm ground reads faintly blue.
 *
 * ## `--ink-soft` is darker than it looks like it should be, and must stay there
 *
 * It started at `#6E665C`, which gives a comfortable 5.41:1 against `--paper`.
 * But the hero's secondary text does not sit on `--paper` — it sits on whatever
 * drifting form is behind it at that second. Measured against the darkest pixel
 * actually rendered under it, `#6E665C` fell to **4.14:1**, under the 4.5:1 that
 * WCAG 1.4.3 asks for.
 *
 * That is the same failure the Three.js hero was rejected for, found in our own
 * design and only because the pixels were sampled rather than the token pair
 * assumed. `#645C52` clears it with margin at every point in the drift cycle.
 *
 * Fixed here rather than by moving the forms on purpose: a colour cannot regress
 * when somebody later adjusts a keyframe. `marketing.test.ts` holds the floor.
 *
 * ## There is deliberately no accent
 *
 * `--accent:#E4572E` is alive and correct in render.ts, where severity pins and
 * the sev-3/sev-4 tags use it to mean something. Here the palette is
 * achromatic-warm end to end and colour carries no meaning, so importing the
 * accent would be borrowing a signal to use as decoration.
 *
 * ## Depth is tonal, never linear
 *
 * Nothing on the reference board has a hard edge. So a raised surface is a
 * lighter tone plus a soft shadow rather than a border, form fields are
 * underlined rather than boxed, and radii are large. Where render.ts reaches
 * for `1px solid var(--line)`, this reaches for a shadow.
 */
export const SHELL_CSS = `
  @font-face { font-family:Inter; src:url(/s/inter.woff2) format('woff2');
               font-weight:300 600; font-style:normal; font-display:swap; }
  :root { --paper:#FBFAF8; --bone:#F2EFE9; --plaster:#EAE5DC; --sand:#DDD6C9;
          --shade:#C9C0B2; --sage:#D6D8D0; --ink:#26221E; --ink-soft:#645C52; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink);
         font:400 16px/1.65 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
         -webkit-font-smoothing:antialiased; text-rendering:optimizeLegibility; }
  a { color:var(--ink); text-decoration-color:var(--shade); text-underline-offset:3px; }
  a:hover { text-decoration-color:var(--ink); }
  .wrap { max-width:640px; margin:0 auto; padding:96px 28px; }
  h1 { font-size:38px; font-weight:300; letter-spacing:-.02em; line-height:1.18; margin:0 0 18px; }
  p { margin:0 0 16px; }
  .lead { font-size:17px; }
  .hint { color:var(--ink-soft); font-size:14px; margin:8px 0 24px; }
  .err { color:#8C3A22; font-size:15px; margin:0 0 18px; }
  code { background:var(--plaster); padding:2px 6px; border-radius:4px; font-size:14px; }
  .btn { display:inline-block; font:500 15px Inter,sans-serif; letter-spacing:-.01em;
         background:var(--ink); color:var(--paper); border:0; border-radius:100px;
         padding:15px 32px; cursor:pointer; text-decoration:none; }
  .btn:hover { background:#3A342E; }
  label { display:block; font-size:13px; color:var(--ink-soft); margin:26px 0 0; }
  input, textarea, button { font-family:inherit; }
  input, textarea { width:100%; font-size:17px; font-weight:300; color:var(--ink);
         background:transparent; border:0; border-bottom:1px solid var(--shade);
         padding:11px 2px; outline:none; transition:border-color .2s ease; }
  input::placeholder, textarea::placeholder { color:var(--shade); }
  input:focus, textarea:focus { border-bottom-color:var(--ink); }
  textarea { resize:vertical; line-height:1.5; }
  button { font:500 15px Inter,sans-serif; letter-spacing:-.01em; margin-top:32px;
         background:var(--ink); color:var(--paper); border:0; border-radius:100px;
         padding:15px 32px; cursor:pointer; }
  button:hover { background:#3A342E; }
  @media (max-width:600px) {
    .wrap { padding:64px 22px; }
    h1 { font-size:31px; }
  }
`;

/**
 * The frame for every page that is not a rendered audit.
 *
 * `title` is interpolated unescaped, exactly as it was before this moved out of
 * server.ts: every caller passes a literal. It is not a place to start putting
 * a visitor's text — `body` is, and everything that reaches it goes through
 * `escapeHtml` at the call site.
 */

/**
 * The marketing palette's colourway, twice, because the two placements are two
 * different sizes and the hairline correction depends on size.
 *
 * See `brand.ts`: the correction puts back ink that antialiasing takes off
 * sub-pixel strokes, and applying it to a mark already drawn large enough just
 * makes the logo bolder than it was drawn. The hero is 438px and needs none; the
 * account shells are 240px falling to 186px on a phone, and do.
 */
const MARK_CSS = markCss("var(--ink)", "var(--paper)", 240);
const HERO_MARK_CSS = markCss("var(--ink)", "var(--paper)", 438);

/**
 * The mark, top-left, on every page that is not the homepage.
 *
 * The homepage has carried `.brandmark` since it was built; nothing else did,
 * so a customer who followed a magic link into their dashboard was on an
 * unbranded page with no way back to the site.
 *
 * ## Why this one is inset and the homepage's bleeds off the edge
 *
 * The hero runs the mark off the left edge of the screen, which is the gesture
 * that makes it an identity rather than a picture of some words. It only reads
 * that way with room around it. On a dashboard the slab would sit a few
 * millimetres from an `<h1>` and a table, where a shape clipped by the viewport
 * reads as a layout bug rather than a decision — so here it is whole, inset, and
 * small enough that the page's own title is still the first thing read. That
 * last constraint is older than the artwork and `marketing.test.ts` enforces it.
 *
 * ## 240px, arrived at by looking
 *
 * The first attempt was 156px, chosen to sit near the old 15px wordmark's
 * footprint. Rendered, the letterforms turned to mush: this is light-weight
 * condensed type whose strokes are under a pixel below about 200px wide, so the
 * mark read as a dark smudge in the corner. 240px is the smallest size where
 * the words are legible, and it still sits entirely in the left margin, clear of
 * the content column. The bleeding treatment was tried here too and rejected by
 * the same method — clipped at this size it cuts into the T and reads as broken.
 *
 * It is a link because a logo in the corner is one everywhere else on the web,
 * and a mark that looks clickable and is not is a small lie about the page.
 */
const BRANDMARK = `<a class="brandmark" href="/">${MARK}</a>`;

const BRANDMARK_CSS = `${MARK_CSS}
  /*
   * Full opacity at rest, dimming on hover rather than the other way round.
   * It was .92 resting, which cost 8% of the contrast between --paper letters
   * and the --ink slab — on strokes that at this size are already losing ink to
   * antialiasing. Measured, the opacity was a contributor and not the cause, but
   * it was contributing in exactly the wrong place, and a hover state can afford
   * a contrast cost that a resting state cannot.
   */
  .brandmark { position:absolute; top:30px; left:32px; width:240px; display:block;
    text-decoration:none; transition:opacity .15s ease; }
  .brandmark:hover { opacity:.78; }
  /*
   * The mark is absolutely positioned, so nothing in the flow knows how tall it
   * is, and .wrap's own padding was set when the mark was 13px of text. At 240px
   * the slab reaches y=96 and the h1 began at y=96; on a phone it landed on top
   * of the word "Your". Caught by rendering the shells at 390px, not by reading
   * the CSS. The clearance lives here rather than in the base stylesheet because
   * it is the mark that needs it — .wrap is only ever used by page().
   */
  .wrap { padding-top:120px; }
  @media (max-width:600px) {
    .brandmark { top:22px; left:22px; width:186px; }
    .wrap { padding-top:96px; }
  }
`;

export function page(title: string, body: string, extraCss = ""): string {
  return documentHtml(
    `${title} — The Usability Lab`,
    `${BRANDMARK_CSS}${extraCss}`,
    `${BRANDMARK}<div class="wrap"><h1>${title}</h1>${body}</div>`,
  );
}

/**
 * The frame under both `page()` and `homePage()`.
 *
 * The homepage cannot go through `page()` — `.wrap` caps at 640px and the hero
 * is full-bleed — but it must not grow a second copy of the token block either.
 * That duplication is the thing this file was split out to end.
 */
function documentHtml(title: string, css: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${SHELL_CSS}${css}</style></head>
<body>${body}</body></html>`;
}

/**
 * How many sources each publisher contributes, largest first.
 *
 * Derived rather than written down, and the reason is on the record: the table
 * went from 15 rows to 28 in a single day this week. A hardcoded "15" on the
 * page that claims we cite our sources is not a stale number, it is a false
 * claim about honesty — and it is precisely the finding this product would
 * report about somebody else's site.
 */
/**
 * The audit of this page, and the source the finding on it cites.
 *
 * The "See one" card used to hold an invented finding with a paragraph under it
 * admitting as much — the only honest way to fill that slot before the pipeline
 * had ever been pointed at us. It has now: audit e338784b, 11 findings, and this
 * is finding 3 of them, quoted exactly as the reviewers wrote it.
 *
 * It is one of the three the published page shows for free, which is the whole
 * reason it is the one on the card. The severity-2 findings sit behind the email
 * gate, so a card quoting one of those would link to a page a visitor could read
 * end to end without ever finding it — the promise broken in the very act of
 * making it.
 *
 * The citation resolves through SOURCES rather than being retyped, for the same
 * reason `publisherCounts()` exists: a hardcoded claim about our own honesty is
 * the finding this product would file about somebody else.
 */
const SELF_AUDIT = "e338784b-6ae0-4cf5-926a-eeb8c0c6bfce";
const JAKOBS = SOURCES.find((s) => s.id === "lawsofux-jakobs")!;

export function publisherCounts(): { publisher: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const s of SOURCES) counts.set(s.publisher, (counts.get(s.publisher) ?? 0) + 1);
  return [...counts]
    .map(([publisher, n]) => ({ publisher, n }))
    // Ties broken by name so the column order is stable between runs. Without
    // it, adding a source could silently reshuffle the row.
    .sort((a, b) => b.n - a.n || a.publisher.localeCompare(b.publisher));
}

/**
 * The hero background: four blurred forms, drifting.
 *
 * ## Why this is CSS and not the component that started the conversation
 *
 * The reference for this was a 50,000-particle Three.js scene. It was rejected
 * on 2026-08-20 for three reasons, and only the first is about tooling:
 *
 * 1. It needs React, Next, Tailwind and shadcn. This repo has five runtime
 *    dependencies and no bundler.
 * 2. Its physics ran on the CPU — roughly 200,000 `Vector3` allocations per
 *    frame, plus a square root each — where it belongs in a vertex shader. It
 *    also never disposed its geometry, material or renderer.
 * 3. **It would have failed our own audit.** White text over a moving
 *    multicoloured field has no contrast ratio to measure at all, it ignored
 *    `prefers-reduced-motion` entirely, and a `requestAnimationFrame` scene
 *    never settles — which is the exact non-determinism B15 spent a week
 *    measuring, and our own capture pipeline would have seen a different
 *    homepage on every run.
 *
 * The reference board settled it on taste as well: those images are continuous
 * soft volumes — draped plaster, poured stone — and a field of discrete dots is
 * granular and unmistakably digital. A different material.
 *
 * ## The reduced-motion branch is not a nicety
 *
 * A full-bleed animation with no way to stop it is a vestibular trigger. With
 * `reduce` set, the forms hold their first frame — which is a complete version
 * of this design, not a degraded one, because the composition never depended on
 * the movement.
 */
const HOME_CSS = `
  .hero { position:relative; min-height:100vh; min-height:100svh; display:flex;
          align-items:center; justify-content:center; overflow:hidden; }
  /*
   * The dot field. One canvas, painted by HERO_JS.
   *
   * No CSS animation on it at all — the drift and the cursor repulsion both live
   * in the paint loop, so reduced-motion is handled in one place rather than
   * split between a keyframe and a script that could disagree.
   *
   * pointer-events are off because the canvas covers the whole hero: the cursor
   * is tracked on window, and the CTA underneath has to stay clickable.
   *
   * (No backticks in here. This is inside a template literal and one silently
   * ends the string — twice today.)
   */
  .dots { position:absolute; inset:0; z-index:0; width:100%; height:100%;
          pointer-events:none; display:block; }

  /*
   * A soft lift of the page ground, sitting between the forms and the words.
   *
   * The forms were deepened for presence and immediately took the sub-line to
   * 2.92:1 — WCAG 1.4.3 wants 4.5. The obvious fix, darkening the secondary
   * text, needed #463F37 to clear it, which is within a hair of the headline
   * colour and collapses the hierarchy the sub-line depends on.
   *
   * So the forms keep their depth everywhere except directly behind the text,
   * where this lifts the ground back toward --paper. It has no edge — a blurred
   * radial that fades to nothing well before the viewport — so it reads as
   * atmosphere rather than as a panel, which is the whole language of the
   * reference board.
   *
   * Deliberately outside .forms: the parallax must not drag it off the text it
   * exists to protect.
   */
  .veil { position:absolute; z-index:0; left:50%; top:48%; transform:translate(-50%,-50%);
          width:min(1180px,96%); height:min(660px,84%); pointer-events:none;
          background:radial-gradient(ellipse at center,
                     rgba(251,250,248,.97) 0%, rgba(251,250,248,.86) 36%,
                     rgba(251,250,248,.52) 58%, rgba(251,250,248,0) 76%);
          filter:blur(26px); }

  /*
   * Run off the left edge on purpose. .hero is overflow:hidden, so the negative
   * offset is clipped to a clean vertical cut rather than the angled corner the
   * artwork ends in — which is what makes it read as a stamp laid on the page
   * instead of an image placed on it. Overflow to the left never extends the
   * scrollable area in LTR, so this cannot produce a sideways scrollbar the way
   * a negative right offset would.
   *
   * top and left are the two numbers to touch if the placement wants nudging;
   * nothing else depends on them. (No backticks in here — this comment lives
   * inside a template literal, and one would end the string.)
   */
  .brandmark { position:absolute; top:42px; left:-18px; z-index:2;
               width:min(438px,58vw); line-height:0; }
${HERO_MARK_CSS}
  .hero-in { position:relative; z-index:1; text-align:center; padding:0 32px; max-width:800px; }
  .hero-in h1 { font-size:56px; font-weight:300; line-height:1.14; letter-spacing:-.018em; margin:0 0 26px; }
  .hero-in .sub { font-size:15px; color:var(--ink-soft); margin:0 0 38px; letter-spacing:.005em; }
  /*
   * Back to --ink-soft, and the round trip is worth recording.
   *
   * It was --ink for one commit, because the blurred forms it replaced ran deep
   * enough down here to take the soft grey to 3.61:1. The dot field is gentler:
   * dots are sparse and the cloud does not reach the bottom of the hero, so the
   * ground under this measures 0.948 and the soft grey clears 6.25:1.
   *
   * Measured, not assumed. The zone changed when the background did.
   */
  .scrollcue { position:absolute; bottom:30px; left:50%; transform:translateX(-50%); z-index:2;
               font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-soft);
               text-decoration:none; }

  .sec { max-width:720px; margin:0 auto; padding:130px 32px; text-align:center; }
  .eyebrow { font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-soft); margin:0 0 26px; }
  .big { font-size:27px; line-height:1.42; font-weight:300; letter-spacing:-.012em; margin:0; }
  .big b { font-weight:500; }
  /*
   * Deliberately not .aside. That treatment (13px, ink-soft, 40px down) is the
   * footnote voice this page uses for the source count, and a disclosure set in
   * the footnote voice is one the layout is apologising for. This is a step
   * below .big and a step above body text, and the two words that matter are
   * the darkest thing in the sentence.
   */
  .disclose { font-size:16px; line-height:1.62; color:var(--ink-soft);
              max-width:560px; margin:30px auto 0; }
  .disclose b { font-weight:500; color:var(--ink); }
  .rule { height:1px; background:var(--plaster); max-width:720px; margin:0 auto; }

  .counts { display:flex; justify-content:center; margin:46px 0 0; }
  .count { flex:1; padding:0 12px; }
  .count + .count { border-left:1px solid var(--plaster); }
  .count .n { display:block; font-size:34px; font-weight:300; letter-spacing:-.03em; }
  .count .l { display:block; font-size:12px; color:var(--ink-soft); line-height:1.45; margin-top:8px; }
  .aside { font-size:13px; color:var(--ink-soft); line-height:1.7; margin:40px 0 0; }

  .sample { background:var(--bone); border-radius:20px; padding:26px; margin-top:46px; text-align:left;
            box-shadow:0 1px 2px rgba(38,34,30,.05), 0 18px 44px -18px rgba(38,34,30,.16); }
  .shot { height:160px; border-radius:12px; position:relative; overflow:hidden;
          background:linear-gradient(180deg,#fff 0%,var(--paper) 100%);
          box-shadow:inset 0 0 0 1px rgba(38,34,30,.05); }
  .shot i { position:absolute; display:block; border-radius:5px; background:var(--plaster); }
  .shot .r1 { left:24px; top:24px; width:126px; height:9px; background:var(--sand); }
  .shot .r2 { left:24px; top:47px; width:228px; height:9px; }
  .shot .r3 { left:24px; top:66px; width:186px; height:9px; }
  .shot .r4 { left:24px; top:98px; width:96px; height:28px; border-radius:14px; background:var(--shade); }
  .shot .pinmark { left:102px; top:94px; width:34px; height:34px; border-radius:50%; background:var(--ink);
                   box-shadow:0 0 0 6px rgba(38,34,30,.08); }
  /* Matches the card's pin. render.ts learned this the hard way: cards numbered
     by severity beside an image pinned 1..n is three cards reading "2" and
     nothing connecting them to the picture. */
  .shot .pinmark::after { content:"3"; position:absolute; inset:0; display:flex; align-items:center;
                          justify-content:center; color:var(--paper); font-size:13px; font-weight:500; }
  .finding { display:flex; gap:16px; margin-top:24px; }
  .finding .pin { flex:0 0 30px; height:30px; border-radius:50%; background:var(--ink); color:var(--paper);
                  font-size:13px; font-weight:500; display:flex; align-items:center; justify-content:center; }
  .finding h2 { margin:3px 0 8px; font-size:15px; font-weight:500; letter-spacing:-.01em; }
  .finding p { margin:0 0 8px; font-size:14px; line-height:1.62; color:var(--ink-soft); }
  .tag { display:inline-block; font-size:11px; letter-spacing:.06em; text-transform:uppercase; vertical-align:2px;
         background:var(--plaster); color:var(--ink-soft); padding:4px 10px; border-radius:100px; margin-left:8px; }
  .cite { font-size:12px; }
  /* Closes finding 6 of the same audit: a heuristic name is our vocabulary, not
     the reader's, and "MODERATE" beside it explains nothing on its own. */
  .gloss { font-style:italic; }
  .realdeal { font-size:13px; margin:18px 0 0; }

  .foot { padding:120px 32px 130px; text-align:center; background:var(--bone); }
  .foot h2 { font-size:32px; font-weight:300; letter-spacing:-.02em; margin:0 0 36px; }
  .price { max-width:400px; margin:0 auto 36px; }
  .prow { display:flex; align-items:baseline; justify-content:space-between; padding:13px 0; }
  .prow + .prow { border-top:1px solid var(--plaster); }
  .prow .what { font-size:14px; color:var(--ink-soft); text-align:left; }
  .prow .amt { font-size:20px; font-weight:300; letter-spacing:-.02em; white-space:nowrap; }
  .prow .amt small { font-size:12px; color:var(--ink-soft); letter-spacing:0; }
  .fine { font-size:12px; color:var(--ink-soft); line-height:1.75; margin:28px 0 0; }

  @media (max-width:640px) {
    .hero-in h1 { font-size:36px; }
    .brandmark { top:26px; left:-10px; width:min(300px,76vw); }
    .sec { padding:88px 24px; }
    .big { font-size:22px; }
    .counts { flex-wrap:wrap; gap:26px 0; }
    .count { flex:0 0 33.33%; }
    .count:nth-child(3n+1) { border-left:0; }
    .foot { padding:88px 24px 96px; }
    .foot h2 { font-size:26px; }
  }
`;

/**
 * `/` — the marketing page.
 *
 * One scroll. Hero, what we do, where the research comes from, one real audit,
 * and the price. There is exactly one action on it and it appears twice.
 *
 * It does not go through `page()` because `.wrap` caps at 640px and the hero is
 * full-bleed; it shares the token block through `documentHtml` instead.
 *
 * **No form, and no list of audits.** The questions moved to `/start`. The
 * absence of an index is §8's rule rather than an oversight — an index would be
 * a cross-customer surface, and the homepage is the obvious place someone would
 * later think to add "recent audits".
 */
/**
 * Who writes the audits. Added 2026-08-25.
 *
 * Before this the word "AI" appeared on no page this product serves. What
 * appeared instead read, to anyone who had not seen the source, as a small
 * agency: reviewers, a team, a person starting each audit by hand. Two of those
 * sentences were by then false outright — `worker.ts` had been draining the
 * queue on a timer since 2026-08-24 — and the product had already taken money
 * from someone who had no way to know any of it.
 *
 * ## Why it is a constant and not markup in the section
 *
 * The first draft put the reasoning you are reading in an HTML comment beside
 * the paragraph, which ships it to every visitor, and the drift guard in
 * `marketing.test.ts` failed on the comment's own quotation of "your team".
 * A rationale that has to be sent to the browser to be preserved is in the
 * wrong file. This way the page carries the sentence and the repository carries
 * the reason.
 *
 * ## Why it is not in the footer
 *
 * It sits directly under the claim it qualifies. A disclosure the reader has to
 * go looking for is one that has been designed not to be read, and this product
 * publishes findings about other people's sites that say exactly that.
 */
const DISCLOSURE = `<p class="disclose">The critique is written by <b>AI reviewers</b> reading your
       page. Everything they claim points at the element it came from, because you
       should not have to take it on trust.</p>`;

export function homePage(): string {
  const counts = publisherCounts()
    .map(
      ({ publisher, n }) =>
        `<div class="count"><span class="n">${n}</span><span class="l">${publisherLabel(publisher)}</span></div>`,
    )
    .join("");

  return documentHtml(
    "The Usability Lab — a design critique of your site, backed by research",
    HOME_CSS,
    `<main>
  <section class="hero">
    <canvas class="dots" id="dots" aria-hidden="true"></canvas>
    <div class="veil" aria-hidden="true"></div>
    <div class="brandmark">${MARK}</div>
    <div class="hero-in">
      <h1>A design critique of your site,<br>backed by research</h1>
      <p class="sub">Five questions to shape your critique. Under ten minutes.
         Real screenshots of your site.</p>
      <a class="btn" href="/start">Get started</a>
    </div>
    <a class="scrollcue" href="#what">Scroll to discover</a>
  </section>

  <section class="sec" id="what">
    <p class="eyebrow">What we do</p>
    <p class="big">Your URL and five answers become a <b>research-backed critique</b>
       of your site — with cited findings and annotated screenshots, so you can
       check every one of them.</p>
    ${DISCLOSURE}
  </section>

  <div class="rule"></div>

  <section class="sec">
    <p class="eyebrow">Where the research comes from</p>
    <p class="big">Every finding points at a source,
       <b>or says plainly that it couldn&rsquo;t find one.</b></p>
    <div class="counts">${counts}</div>
    <p class="aside">${SOURCES.length} sources in all &mdash; and that number is read from the
       table the reviewers cite against, not typed onto this page.</p>
  </section>

  <div class="rule"></div>

  <section class="sec">
    <p class="eyebrow">See one</p>
    <p class="big">Here is <b>this page</b>, audited by the thing this page is selling.</p>
    <div class="sample">
      <div class="shot" aria-hidden="true">
        <i class="r1"></i><i class="r2"></i><i class="r3"></i><i class="r4"></i>
        <i class="pinmark"></i>
      </div>
      <div class="finding">
        <div class="pin">3</div>
        <div>
          <h2>Consistency and Standards<span class="tag">Severity 3</span></h2>
          <p class="gloss">Whether a page works the way other sites have taught people to expect.</p>
          <p>There are no links to a privacy policy, terms of service, contact/support,
             or company information anywhere on the page.</p>
          <p class="cite">Cited: <a href="${JAKOBS.url}">${JAKOBS.publisher} &mdash;
             ${JAKOBS.title}</a></p>
        </div>
      </div>
      <p class="realdeal"><a href="/a/${SELF_AUDIT}/">Read the whole audit of this page
         &rarr;</a></p>
    </div>
  </section>

  <footer class="foot">
    <h2>One page. Five questions.</h2>
    <div class="price">
      <div class="prow"><span class="what">Your first audit</span><span class="amt">Free</span></div>
      <div class="prow"><span class="what">Keep watching the page</span>
        <span class="amt">$${PRICE_USD} <small>/ month</small></span></div>
    </div>
    <a class="btn" href="/start">Get started</a>
    <p class="fine">No card to start. The subscription buys re-audits &mdash; we capture the
       page again and tell you what moved. Up to ${SITE_LIMIT} sites and
       ${AUDITS_PER_MONTH} re-audits a month. Cancel any time.</p>
    <!--
      Been here before? Until 2026-08-25 the answer was "find the email we sent
      you", because every credential opened one audit and there was no route
      above it. A dashboard nobody can navigate to is not shipped, so this link
      is part of the same change rather than a follow-up.
    -->
    <p class="fine"><a href="/signin">Already have audits? Sign in</a></p>
  </footer>
</main>
<script>${HERO_JS}</script>`,
  );
}

/**
 * Publisher names, broken where they read best in a narrow column.
 *
 * Unknown publishers fall through unchanged rather than throwing, so adding a
 * row to `sources.ts` can never take the homepage down — it just gets a column
 * that wraps on its own.
 */
function publisherLabel(publisher: string): string {
  const breaks: Record<string, string> = {
    "Nielsen Norman Group": "Nielsen Norman<br>Group",
    "W3C Web Accessibility Initiative": "WCAG<br>(W3C&nbsp;WAI)",
    "Laws of UX": "Laws<br>of&nbsp;UX",
    "Baymard Institute": "Baymard<br>Institute",
    "Growth.Design": "Growth<br>.Design",
  };
  return breaks[publisher] ?? publisher;
}

/**
 * The stepper. Six steps, one submit, and it hides fields rather than fetching
 * them.
 *
 * ## What it deliberately does not do
 *
 * Every field is already in the DOM when this runs. That is the design, not an
 * implementation detail, and everything good about this page follows from it:
 * no server-side step state, so nothing half-finished is stored, so there is no
 * expiry policy to write for a stranger's free text; no new endpoint, so no new
 * rate-limit surface; and `/request` is the handler it always was.
 *
 * With the script absent, all six steps simply display and the form submits as
 * it did before any of this — which is why `.stepped` is added *by* the script
 * rather than rendered by the server. The hiding is opt-in from the client.
 *
 * A POST-per-step design was considered and rejected: it buys a progress bar in
 * exchange for storing half-answered questions about somebody's business.
 *
 * ## Written plainly on purpose
 *
 * `var`, no arrow functions, no optional chaining. This string is hashed into
 * the page's Content-Security-Policy, so it can never go through a build step —
 * a transform of any kind would change the bytes and the browser would silently
 * refuse to run it. Silently, because a CSP refusal is a console message and
 * nothing else. Keeping it boring keeps it honest.
 */
export const STEPPER_JS = `
(function () {
  var form = document.getElementById('flow');
  if (!form) return;
  var steps = Array.prototype.slice.call(form.querySelectorAll('.step'));
  if (steps.length < 2) return;
  var segs = Array.prototype.slice.call(form.querySelectorAll('.seg'));
  var count = document.getElementById('count');
  var back = document.getElementById('back');
  var skip = document.getElementById('skip');
  var next = document.getElementById('next');
  var submit = document.getElementById('submit');
  var note = document.getElementById('note');
  var i = Number(form.getAttribute('data-error-step') || 0);

  form.className += ' stepped';

  function field(n) { return steps[n].querySelector('input, textarea'); }

  function draw() {
    for (var n = 0; n < steps.length; n++) {
      steps[n].hidden = n !== i;
      segs[n].className = 'seg' + (n <= i ? ' done' : '');
    }
    count.textContent = 'Step ' + (i + 1) + ' of ' + steps.length;
    back.hidden = i === 0;
    skip.hidden = i === 0;
    next.hidden = i === steps.length - 1;
    submit.hidden = i !== steps.length - 1;
    note.textContent = i === 0
      ? 'The only thing we actually need.'
      : 'Optional. Skipping is a real answer, and a better one than a guess.';
    var f = field(i);
    if (f) f.focus();
  }

  function go(n) {
    if (n < 0) n = 0;
    if (n > steps.length - 1) n = steps.length - 1;
    i = n;
    draw();
  }

  next.onclick = function (e) { e.preventDefault(); go(i + 1); };
  back.onclick = function (e) { e.preventDefault(); go(i - 1); };
  skip.onclick = function (e) {
    e.preventDefault();
    var f = field(i);
    if (f) f.value = '';
    go(i + 1);
  };

  form.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (i === steps.length - 1) return;
    e.preventDefault();
    go(i + 1);
  });

  draw();
})();
`;

/**
 * The policy for the one page that runs a script, naming that script by hash.
 *
 * A hash and not `'unsafe-inline'`, which would hand back everything the header
 * exists to prevent. A hash and not a nonce, because the script is a fixed
 * string we own — so the digest is taken from the script itself and the policy
 * cannot drift out of sync with the code it authorises. Change one and the
 * other changes with it.
 */
export const STEPPED_CSP =
  `${MARKETING_CSP}; script-src 'sha256-` +
  createHash("sha256").update(STEPPER_JS, "utf8").digest("base64") +
  `'`;

/**
 * The hero's dot field — a cursor-reactive particle cloud, in greys.
 *
 * ## This is the component's idea, without the component's problems
 *
 * The reference was 50,000 Three.js points pushed away from the pointer. The
 * dots were never the problem. The problem was the loop: five `Vector3` objects
 * allocated per particle per frame, roughly 200,000 allocations at 60fps, plus a
 * square root each, all on the main thread. That is a garbage-collection
 * firehose, and it needs React, Next, Tailwind, shadcn and two npm packages to
 * arrive.
 *
 * This is the same behaviour in a plain 2D canvas with **no dependency and no
 * allocation in the hot loop**. Position, velocity and origin live in flat
 * `Float32Array`s; every calculation is scalar arithmetic on numbers already in
 * those arrays. Nothing is constructed per frame, so nothing has to be collected.
 *
 * Two more things buy back time:
 *
 * - **Squares, not arcs.** `fillRect` at 1–2px is an order of magnitude cheaper
 *   than `arc()` and indistinguishable at this size.
 * - **Batched by tone.** Particles are bucketed into a handful of greys and
 *   drawn bucket by bucket, so `fillStyle` is assigned a few times a frame
 *   rather than once per dot.
 *
 * ## Greys, not the rainbow
 *
 * The original tinted every particle with `setHSL(Math.random(), 0.8, …)` —
 * full-spectrum confetti by construction, and wrong against a reference board
 * with essentially no chroma on it. Kelly's call, 2026-08-20: greys. The ramp is
 * very slightly warm so it does not read blue against `--paper`.
 *
 * ## What it refuses to do
 *
 * Under `prefers-reduced-motion` it paints **one still frame** and stops: no
 * listener, no animation loop, no repulsion. The cloud is a composition, so a
 * single frame of it is a complete version of the design rather than a broken
 * one. Checked before anything is bound.
 *
 * Written in plain `var`-and-`function` style because this string is hashed into
 * the page's Content-Security-Policy — any transform of the bytes and the
 * browser silently refuses to run it.
 */
export const HERO_JS = `
(function () {
  var canvas = document.getElementById('dots');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d');
  if (!ctx) return;

  var still = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  var COUNT = 6400;
  var TONES = ['#C2BFB9', '#B0ACA5', '#9E9992', '#8C877F', '#7A756D'];
  var REPEL = 130;
  var REPEL2 = REPEL * REPEL;
  var FORCE = 1.5;
  var SPRING = 0.012;
  var DAMP = 0.90;
  var DOT = 1.6;

  var px = new Float32Array(COUNT), py = new Float32Array(COUNT);
  var ox = new Float32Array(COUNT), oy = new Float32Array(COUNT);
  var vx = new Float32Array(COUNT), vy = new Float32Array(COUNT);
  var ph = new Float32Array(COUNT);
  var tone = new Uint8Array(COUNT);
  var w = 0, h = 0, dpr = 1;
  var mx = -9999, my = -9999;
  var raf = null, t0 = 0;

  /* Overlapping soft clusters, so the cloud has a denser core and a ragged edge
     rather than reading as a circle. Each is [x, y, spread, share] as fractions
     of the hero, and the shares are what make "a few more over there" a number
     rather than a rewrite. The fourth is the top-left one Kelly asked for; it
     carries the smallest share on purpose, so it reads as the cloud reaching
     that way rather than as a second cloud. */
  var SEEDS = [
    [0.50, 0.46, 0.30, 32],
    [0.63, 0.36, 0.20, 23],
    [0.40, 0.58, 0.22, 23],
    /* Nudged down and tightened from [0.25, 0.27, 0.20]: at that spread the
       cluster reached y=0.07 and put dots behind the brandmark, which measured
       3.45:1 against WCAG's 4.5. It now starts below y=0.16 and the logo sits on
       clean paper. */
    [0.26, 0.33, 0.17, 22]
  ];
  var SHARE = 0;
  for (var k = 0; k < SEEDS.length; k++) SHARE += SEEDS[k][3];

  function pick(i) {
    /* Walked deterministically rather than sampled, so every cluster gets its
       exact share and a reseed on resize looks like the same cloud. */
    var at = (i / COUNT) * SHARE, acc = 0;
    for (var k = 0; k < SEEDS.length; k++) {
      acc += SEEDS[k][3];
      if (at < acc) return SEEDS[k];
    }
    return SEEDS[SEEDS.length - 1];
  }

  function seed() {
    for (var i = 0; i < COUNT; i++) {
      var s = pick(i);
      /* Two uniforms summed approximate a bell, which clumps toward the centre
         without the cost of a real gaussian. */
      var rx = (Math.random() + Math.random() - 1) * s[2];
      var ry = (Math.random() + Math.random() - 1) * s[2];
      ox[i] = (s[0] + rx) * w;
      oy[i] = (s[1] + ry) * h;
      px[i] = ox[i];
      py[i] = oy[i];
      vx[i] = 0;
      vy[i] = 0;
      ph[i] = Math.random() * 6.283;
      /* Denser toward the middle of the ramp, so the field has few very dark
         dots and reads soft rather than speckled. */
      var t = Math.random() + Math.random();
      tone[i] = Math.min(TONES.length - 1, Math.floor(t * TONES.length / 2));
    }
  }

  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth;
    h = canvas.clientHeight;
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    seed();
    draw();
  }

  function draw() {
    ctx.clearRect(0, 0, w, h);
    for (var t = 0; t < TONES.length; t++) {
      ctx.fillStyle = TONES[t];
      for (var i = 0; i < COUNT; i++) {
        if (tone[i] !== t) continue;
        ctx.fillRect(px[i], py[i], DOT, DOT);
      }
    }
  }

  function step(now) {
    var drift = (now - t0) * 0.00022;
    for (var i = 0; i < COUNT; i++) {
      /* A slow wander of each origin, so the cloud breathes with no cursor. */
      var tx = ox[i] + Math.sin(drift + ph[i]) * 9;
      var ty = oy[i] + Math.cos(drift * 0.83 + ph[i]) * 9;

      var dx = px[i] - mx, dy = py[i] - my;
      var d2 = dx * dx + dy * dy;
      if (d2 < REPEL2 && d2 > 1) {
        var d = Math.sqrt(d2);
        var f = (1 - d / REPEL) * FORCE / d;
        vx[i] += dx * f;
        vy[i] += dy * f;
      }
      vx[i] += (tx - px[i]) * SPRING;
      vy[i] += (ty - py[i]) * SPRING;
      vx[i] *= DAMP;
      vy[i] *= DAMP;
      px[i] += vx[i];
      py[i] += vy[i];
    }
    draw();
    raf = window.requestAnimationFrame(step);
  }

  window.addEventListener('resize', resize, { passive: true });
  resize();

  if (still) return;

  window.addEventListener('pointermove', function (e) {
    var r = canvas.getBoundingClientRect();
    mx = e.clientX - r.left;
    my = e.clientY - r.top;
  }, { passive: true });
  window.addEventListener('pointerleave', function () { mx = -9999; my = -9999; }, { passive: true });

  t0 = performance.now();
  raf = window.requestAnimationFrame(step);
})();
`;

/** The homepage runs one script, and names it. Same rule as the stepped flow. */
export const HOME_CSP =
  `${MARKETING_CSP}; script-src 'sha256-` +
  createHash("sha256").update(HERO_JS, "utf8").digest("base64") +
  `'`;

/** Matches `MAX_ANSWER` in server.ts, which enforces it. */
const MAX_ANSWER = 1000;

/** What each question needs said underneath it before someone answers it. */
const HELP: Record<number, string> = {
  0: "A shop, a product, a marketing page, something you write on — whatever fits.",
  // True, and it is why this answer matters more than the others: `concerns[0]`
  // is what breaks the tie when more §3 spawn rules fire than the cap of four
  // allows. People write better answers when they know what the answer does.
  // "AI reviewers" and not "reviewers" because /start is its own surface: a
  // visitor can arrive here from a link without ever having read the homepage,
  // and this is the first and only place the flow names who does the work.
  1: "Lead with the thing that actually bothers you. It decides which AI reviewers we put on the page.",
  2: "The one action that matters most.",
  3: "If you know. A guess is fine, and so is not knowing.",
  4: "Constraints, history, a redesign you are halfway through.",
};

const START_CSS = `
  .flowbar { display:flex; align-items:center; gap:16px; padding:26px 34px; }
  .flowmark { font-size:11px; letter-spacing:.08em; text-transform:uppercase; text-decoration:none; }
  #count { margin-left:auto; font-size:11px; letter-spacing:.12em; text-transform:uppercase; color:var(--ink-soft); }
  .track { display:flex; gap:6px; padding:0 34px; }
  .seg { flex:1; height:2px; border-radius:2px; background:var(--plaster); transition:background .45s ease; }
  .seg.done { background:var(--ink); }
  .flowbody { max-width:560px; margin:0 auto; padding:72px 34px 60px; }
  .step h2 { font-size:34px; font-weight:300; line-height:1.2; letter-spacing:-.02em; margin:0 0 10px; }
  .step .help { font-size:14px; color:var(--ink-soft); line-height:1.65; margin:0 0 26px; }
  .step input, .step textarea { font-size:19px; }
  .nav { display:flex; align-items:center; gap:14px; margin-top:34px; }
  .nav button { margin-top:0; }
  #back { background:transparent; color:var(--ink-soft); padding:15px 4px; }
  #back:hover { background:transparent; color:var(--ink); }
  #skip { margin-left:auto; background:transparent; color:var(--ink-soft); font-size:13px; font-weight:400;
          padding:15px 2px; text-decoration:underline; text-decoration-color:var(--shade);
          text-underline-offset:4px; }
  #skip:hover { background:transparent; color:var(--ink); }
  #note { font-size:12px; color:var(--ink-soft); margin:16px 0 0; }
  /*
   * Everything above styles the stepped view. Without the script, the stepped
   * class is never added, so these rules never apply, every step shows at once,
   * and the page is the form this replaced. Kept as a CSS comment rather than a
   * JSDoc block because this is inside a template literal, and a backtick in
   * here silently ends the string.
   */
  form:not(.stepped) .track,
  form:not(.stepped) #count,
  form:not(.stepped) .nav button:not(#submit) { display:none; }
  form:not(.stepped) .step + .step { margin-top:44px; }
  form:not(.stepped) #note { display:none; }
  @media (max-width:600px) {
    .flowbar, .track { padding-left:22px; padding-right:22px; }
    .flowbody { padding:48px 22px 44px; }
    .step h2 { font-size:26px; }
  }
`;

/**
 * `/start` — the five questions, one at a time.
 *
 * Rendered whole, every time. `state` only ever fills values back in after
 * `/request` refuses something, so nobody retypes five answers over a mistyped
 * URL. This is the one page here built from a stranger's text, and every
 * interpolation of it goes through `escapeHtml`.
 */
export function questionsPage(
  state: { url?: string; answers?: Answers; error?: string; errorStep?: number } = {},
): string {
  const step = (n: number, heading: string, help: string, control: string) =>
    `<div class="step">
        <h2>${escapeHtml(heading)}</h2>
        <p class="help">${escapeHtml(help)}</p>
        ${control}
      </div>`;

  const urlStep = step(
    0,
    "What page should we look at?",
    "One page, not a whole site. We stop at any login wall.",
    `<input id="url" name="url" type="url" required inputmode="url"
              placeholder="https://yoursite.com/" value="${escapeHtml(state.url ?? "")}">`,
  );

  const questionSteps = QUESTIONS.map((q, i) =>
    step(
      i + 1,
      q,
      HELP[i] ?? "",
      `<textarea id="q${i}" name="q${i}" rows="2" maxlength="${MAX_ANSWER}"
                  placeholder="Type your answer…">${escapeHtml(state.answers?.[q] ?? "")}</textarea>`,
    ),
  ).join("\n      ");

  const segs = Array.from({ length: QUESTIONS.length + 1 }, () => `<div class="seg"></div>`).join("");

  /**
   * Which step to open on after a refusal.
   *
   * Not always 0. A rejected URL belongs on step 0, but an over-long answer
   * belongs on the step holding that answer — and the first draft of this sent
   * everyone to step 0 regardless, which would have shown someone the URL field
   * and an error about a question six screens away.
   *
   * Clamped, because the caller computes it from an index and a mistake there
   * should mis-aim the flow, not break it.
   */
  const openOn = Math.min(Math.max(state.errorStep ?? 0, 0), QUESTIONS.length);
  const errorStep = state.error ? ` data-error-step="${openOn}"` : "";

  return documentHtml(
    "Tell us about one page — The Usability Lab",
    START_CSS,
    `<form id="flow" method="post" action="/request"${errorStep}>
      <div class="flowbar">
        <a class="flowmark" href="/">The Usability Lab</a>
        <span id="count">Step 1 of ${QUESTIONS.length + 1}</span>
      </div>
      <div class="track">${segs}</div>
      <div class="flowbody">
        ${state.error ? `<p class="err">${escapeHtml(state.error)}</p>` : ""}
        ${urlStep}
      ${questionSteps}
        <div class="nav">
          <button type="button" id="next">Continue</button>
          <button type="submit" id="submit">Ask for the audit</button>
          <button type="button" id="back">Back</button>
          <button type="button" id="skip">Skip this one</button>
        </div>
        <p id="note">The only thing we actually need.</p>
      </div>
    </form>
<script>${STEPPER_JS}</script>`,
  );
}

/**
 * Sign in — the way back to an account, added 2026-08-25.
 *
 * Until now every credential this product issued opened one audit, so a
 * subscriber who closed the tab had no route back in. §1 sells monitoring for
 * three sites; there was nowhere to see three of anything.
 *
 * The response after a submission is deliberately the same whether or not we
 * hold anything for that address. A form that says "no audits for that email"
 * is a form that tells a stranger who our customers are.
 */
export function signInPage(opts: { error?: string; sent?: string } = {}): string {
  if (opts.sent) {
    return page(
      "Check your email",
      `<p class="lead">If we have audits for ${escapeHtml(opts.sent)}, a sign-in link is on its way.</p>
       <p class="hint">The link opens your audits and expires. Nothing else is sent to that address.</p>`,
    );
  }
  return page(
    "Sign in",
    `${opts.error ? `<p class="err">${escapeHtml(opts.error)}</p>` : ""}
     <p class="lead">Enter the address you used, and we'll send a link to your audits.</p>
     <form method="post" action="/signin">
       <label for="email">Email</label>
       <input id="email" name="email" type="email" autocomplete="email" required
              placeholder="you@company.com">
       <button type="submit">Send the link</button>
     </form>`,
  );
}

/**
 * The next thing this could do, shown rather than claimed.
 *
 * §0 already lists "scheduled change-detection monitoring" under *designed, not
 * built* — v0 re-audits are customer-triggered. This makes that visible on the
 * page where it would live, so the direction is legible to someone looking at
 * the product rather than the design doc.
 *
 * **Deliberately not a link and not a button.** A control that looks live and
 * does nothing is the failure this repo keeps correcting — the footer that said
 * a person had read an audit when nobody had was the same mistake with higher
 * stakes. Nothing here is clickable, so nothing can be clicked in hope.
 */

export interface AccountAudit {
  url: string;
  when: string;
  state: string;
  href: string | null;
}

/**
 * Three tabs, and the middle one is not built.
 *
 * ~~Two tabs, and deliberately not three. "Schedule audits" was proposed as a
 * third. It is the dotted box below the audit list instead, because a tab is a
 * promise that something is behind it — and a tab whose content is "not built
 * yet" makes the dashboard read one-third unfinished on every visit,
 * permanently, to a customer who is paying. Inline, the same box is an aside
 * next to real work, which is what it actually is.~~
 *
 * **Overruled by Kelly, 2026-08-25**, with a reason the argument above does not
 * answer: the tab is not there to deliver the feature, it is there to show that
 * the product is heading for full automation. A roadmap a customer can see is
 * worth a tab even before it does anything.
 *
 * The objection is met rather than dismissed — the tab carries a **Soon** badge,
 * so it announces itself as forthcoming before anyone clicks it, and the page
 * behind it says what it will do rather than apologising for what it does not.
 * A dead end is a tab that promises and then does not deliver; this one does not
 * promise.
 *
 * The dotted box has gone from the audits tab. It was the same words in the
 * same product two clicks apart, and the tab is the better home for them.
 */
const ACCOUNT_TABS: { href: string; label: string; soon?: boolean }[] = [
  { href: "/account", label: "Your audits" },
  { href: "/account/schedule", label: "Schedule audits", soon: true },
  { href: "/account/billing", label: "Your account" },
];

/**
 * `soon` is what makes a third tab honest rather than broken.
 *
 * The objection to it (recorded below, and it was mine) was that a tab whose
 * content is "not built yet" makes the dashboard read one-third unfinished on
 * every visit, permanently, to somebody who is paying. The badge answers it:
 * an unlabelled tab leading to "not built yet" is a dead end, and a tab that
 * says **Soon** before you click it is a roadmap. The difference is whether the
 * page keeps a promise it made a moment earlier.
 */
function tabs(current: string): string {
  const items = ACCOUNT_TABS.map((t) => {
    const label = t.soon ? `${t.label}<span class="soon-badge">Soon</span>` : t.label;
    return t.href === current
      ? `<span class="tab on" aria-current="page">${label}</span>`
      : `<a class="tab" href="${t.href}">${label}</a>`;
  }).join("");
  return `<nav class="tabs" aria-label="Account">${items}</nav>`;
}

const TABS_CSS = `.tabs { display:flex; gap:22px; margin:0 0 8px;
     border-bottom:1px solid var(--plaster); }
   .tabs .tab { display:inline-block; padding:0 0 10px; font-size:15px;
     text-decoration:none; color:var(--ink-soft); border-bottom:2px solid transparent;
     margin-bottom:-1px; }
   .tabs .tab.on { color:var(--ink); border-bottom-color:var(--ink); }
   .tabs a.tab:hover { color:var(--ink); }
   .soon-badge { display:inline-block; margin-left:7px; font-size:10px; letter-spacing:.08em;
     text-transform:uppercase; color:var(--shade); border:1px solid var(--sand);
     border-radius:100px; padding:2px 7px; vertical-align:1px; }
   /* Three tabs fit a 640px column and do not fit a narrow phone. Wrapping is
      the only option that keeps every label readable; shrinking the type makes
      the third tab look like an afterthought, which is the impression this
      badge exists to avoid. */
   @media (max-width:520px) {
     .tabs { flex-wrap:wrap; gap:16px; }
     .soon-badge { margin-left:5px; }
   }`;

export interface BillingView {
  /**
   * Null when no subscription row exists at all.
   *
   * Narrowed from `string` on 2026-08-25. It was the row's own union all along,
   * but typed loosely here — and the page paid for that by rendering whatever
   * arrived straight into the markup, which is how a customer came to be shown
   * the word `past_due`. Now each state must be given words on purpose, and a
   * status added to `SubscriptionStatus` without a branch here fails the build
   * instead of leaking a column value onto the page.
   */
  status: SubscriptionStatus | null;
  /** ISO, from the row. Null on a status that has no next date. */
  renewsAt: string | null;
  /** A Stripe customer exists to send them to. */
  manageable: boolean;
  csrf: string;
}

/**
 * What this product knows about a customer's money, which is deliberately not
 * much.
 *
 * `results.html` tells every reader "card details go to Stripe and never touch
 * us". That stays true only if this page never renders anything card-shaped —
 * so there is no last-four, no brand, no expiry, because we hold none of them
 * and a placeholder would imply we do. What is here is what our own row knows:
 * the plan, whether it is running, and the date access currently runs to.
 *
 * Everything else — cancelling, changing a card, past invoices — is one button
 * into Stripe's portal. See `createPortalSession` for why that is a redirect
 * rather than a cancel button of our own.
 */
export function billingPage(email: string, view: BillingView): string {
  const price = `$${PRICE_USD} a month`;
  const date = view.renewsAt ? view.renewsAt.slice(0, 10) : null;

  const facts = (status: string, dateLabel?: string) =>
    `<dl class="facts">
       <dt>Plan</dt><dd>Continuous monitoring &middot; ${price}</dd>
       <dt>Status</dt><dd>${status}</dd>
       ${dateLabel && date ? `<dt>${dateLabel}</dt><dd>${escapeHtml(date)}</dd>` : ""}
     </dl>`;

  /*
   * A switch rather than the ternary chain this was, because the chain ended in
   * `view.status ? <render it> : <no subscription>` — every state that was not
   * `active` rendered the column value into the page and told the reader there
   * was no subscription. That was one branch too few, and the missing one was
   * the failed renewal.
   *
   * The `never` in the default is the point: `SubscriptionStatus` gaining a
   * fourth member now fails the build here rather than shipping a database word
   * to a customer.
   */
  let body: string;
  switch (view.status) {
    case "active":
      body = facts("Active", "Runs to");
      break;

    /*
     * Proved against a real Stripe test clock on 2026-08-25 — a good card
     * swapped for a declining one and a month advanced. What the customer whose
     * card had just been refused was shown, live:
     *
     *     Status          past_due
     *     Access ran to   2026-10-25
     *     There is no active subscription on this address.
     *
     * Four wrong things. `past_due` is a column value, not English. The date is
     * in the *future* under a past-tense label — Stripe advances
     * `current_period_end` when it raises the invoice, so the row holds the end
     * of a month nobody has paid for. And the last line is flatly false: there
     * is a subscription, Stripe is still retrying the card, and the page denied
     * it existed while the customer was being charged for it.
     *
     * No date is rendered on purpose. The only one we hold is that unpaid
     * period end, and the date they would actually want — when the card was
     * refused — is not in the row. A sentence with no date is honest; the one
     * this page could build from what it has would not be.
     */
    case "past_due":
      body =
        facts("Payment failed") +
        `<p class="hint">Your card was refused, so re-audits are paused. Stripe will
            try it again over the next few days &mdash; if it goes through, everything
            comes back on its own and there is nothing for you to do. If it was the
            wrong card, update it below.</p>`;
      break;

    case "canceled":
      body =
        facts("Cancelled", "Access ran to") +
        `<p class="hint">There is no active subscription on this address.</p>`;
      break;

    case null:
      body = `<p class="lead">No subscription on this address.</p>
         <p class="hint">Audits you run stay free to start; the subscription is for
            re-audits and monitoring.</p>
         <p><a class="btn" href="/">Audit a page</a></p>`;
      break;

    default: {
      const unreachable: never = view.status;
      throw new Error(`unhandled subscription status: ${String(unreachable)}`);
    }
  }

  /**
   * A POST, not a link. The URL Stripe hands back lets its holder cancel a
   * subscription, and "a state change reachable by URL is one a link preview
   * can make" is the rule this codebase already applies one step down in
   * consequence, on the re-audit button.
   */
  // Same destination, different word. Stripe's portal does all of it, but a
  // customer sent here by a declined card has exactly one thing to do and
  // "Manage billing" makes them guess whether it is the right door.
  const action = view.status === "past_due" ? "Update your card" : "Manage billing";

  const manage = view.manageable
    ? `<form method="post" action="/account/billing">
         <input type="hidden" name="csrf" value="${escapeHtml(view.csrf)}">
         <button type="submit">${action}</button>
       </form>
       <p class="hint">Cancel, change your card, or read past invoices. This opens
          Stripe, who hold the card &mdash; we never have.</p>`
    : view.status
      ? `<p class="hint">This subscription was granted directly rather than bought,
            so there is no billing record to open. Email us and we will sort out
            anything you need.</p>`
      : "";

  return page(
    "Your account",
    `${tabs("/account/billing")}
     <p class="hint"><!--email_off-->${escapeHtml(email)}<!--email_on--></p>
     ${body}
     ${manage}`,
    `${TABS_CSS}
     .facts { margin:26px 0 24px; }
     .facts dt { font-size:13px; letter-spacing:.05em; text-transform:uppercase;
       color:var(--shade); margin-top:16px; }
     .facts dd { margin:3px 0 0; font-size:17px; }
     .facts dt:first-child { margin-top:0; }`,
  );
}

/**
 * The dashboard.
 *
 * `server.ts` has refused to index audits since it was written — "an index
 * would be a cross-customer surface, which §8 says a customer must never
 * reach". This is that index, so every row here came from a query scoped to a
 * verified address and there is no code path that renders an unscoped one.
 *
 * Running and held audits are listed rather than hidden. A dashboard that
 * showed only finished work would leave someone wondering where the audit they
 * just asked for went, which is the question it exists to answer.
 */
/**
 * @param sub `active` is `isActive` — paid and inside the period. `status` is
 * the row's own word, and both are needed: a row can say `active` with an
 * expired period end, which is not access.
 *
 * It was a single `subscribed: boolean` until 2026-08-25, which forced a
 * customer mid-dunning into "no subscription" — the same untruth the billing
 * tab was telling them one tab over, from the same missing distinction. A
 * failed payment is not the absence of a subscription.
 */
export function accountPage(
  email: string,
  audits: AccountAudit[],
  sub: { active: boolean; status: SubscriptionStatus | null },
): string {
  const standing = sub.active
    ? "subscribed"
    : sub.status === "past_due"
      ? "payment failed"
      : "no subscription";

  const rows = audits
    .map(
      (a) =>
        `<li class="rowitem">
           <div class="site">${a.href ? `<a href="${a.href}">${escapeHtml(a.url)}</a>` : escapeHtml(a.url)}</div>
           <div class="meta">${escapeHtml(a.state)} &middot; ${escapeHtml(a.when)}</div>
         </li>`,
    )
    .join("");

  const empty = `<p class="lead">No audits on this address yet.</p>
     <p><a class="btn" href="/">Audit a page</a></p>`;

  return page(
    "Your audits",
    // Cloudflare's Scrape Shield rewrites anything that looks like an address
    // into `[email protected]` plus a /cdn-cgi/ decode script — and this site's
    // CSP blocks that script, so a customer would see the placeholder for ever
    // on a page showing their OWN address. `email_off` is Cloudflare's own
    // per-page opt-out, and it lives here rather than in a dashboard toggle for
    // the reason deploy-runbook.md already learned the hard way: nothing in git
    // would know a dashboard setting existed. Inert if Cloudflare is not in
    // front — it is an HTML comment.
    `${tabs("/account")}
     <p class="hint"><!--email_off-->${escapeHtml(email)}<!--email_on--> &middot; ${standing}</p>
     ${audits.length === 0 ? empty : `<ul class="rows">${rows}</ul>`}
     ${audits.length === 0 ? "" : `<p><a class="btn" href="/">Audit another page</a></p>`}
`,
    `${TABS_CSS}
     .rows { list-style:none; margin:26px 0 30px; padding:0; }
     .rowitem { padding:16px 0; border-bottom:1px solid var(--plaster); }
     .site { font-size:17px; word-break:break-all; }
     .meta { color:var(--ink-soft); font-size:14px; margin-top:3px; }
`,
  );
}


/**
 * `/account/schedule` — the tab that says what is coming.
 *
 * Written as a placeholder for the feature rather than a holding page: the
 * three lines below are the shape the scheduling actually needs, so when this
 * is built the page is the spec it was already showing. That is also why it
 * states what a re-audit does *today* — a coming-soon page that does not say
 * what currently happens leaves the reader unsure whether they are missing
 * something that already exists.
 */
export function schedulePage(email: string): string {
  return page(
    "Schedule audits",
    `${tabs("/account/schedule")}
     <p class="hint"><!--email_off-->${escapeHtml(email)}<!--email_on--></p>

     <p class="lead">Re-check your pages on a schedule and get told what moved,
        without asking.</p>

     <ul class="plan">
       <li><strong>Weekly, or monthly.</strong> A re-audit on a fixed day, so a
           page you stopped looking at cannot quietly get worse.</li>
       <li><strong>After you ship.</strong> A re-audit triggered when the page
           changes, which is the moment the findings are worth most.</li>
       <li><strong>Only what moved.</strong> The diff, not the whole audit again
           &mdash; what got fixed, what appeared, what is unchanged.</li>
     </ul>

     <p class="hint">None of this is built yet. Today a re-audit happens when you
        press the button on an audit, and the diff against the previous run is
        already what you get when you do.</p>`,
    `${TABS_CSS}
     .plan { list-style:none; margin:26px 0 26px; padding:0; }
     .plan li { padding:16px 0; border-bottom:1px solid var(--plaster);
       font-size:15px; color:var(--ink-soft); line-height:1.6; }
     .plan li strong { display:block; color:var(--ink); font-weight:500;
       font-size:16px; margin-bottom:3px; }`,
  );
}
