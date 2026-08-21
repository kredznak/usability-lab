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
 */
export const STRICT_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";

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
export function page(title: string, body: string, extraCss = ""): string {
  return documentHtml(
    `${title} — The Usability Lab`,
    extraCss,
    `<div class="wrap"><h1>${title}</h1>${body}</div>`,
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
  /* inset -15% leaves room for HERO_JS to lean it 40px without exposing an edge. */
  .forms { position:absolute; inset:-15%; z-index:0; filter:blur(44px); pointer-events:none;
           will-change:transform; }
  .blob { position:absolute; border-radius:50%; mix-blend-mode:multiply; }
  /*
   * The forms have their own palette, deeper than the UI tokens they started
   * from. Reusing --plaster and --shade kept them at hairline strength, which
   * is right for a 1px rule and far too faint for a shape three feet across.
   * Kelly's call, 2026-08-20: more presence.
   */
  .b1 { width:54%; aspect-ratio:1.25; left:16%; top:2%;
        background:radial-gradient(circle at 38% 38%, #DCD2C0, transparent 76%); animation:d1 26s ease-in-out infinite; }
  .b2 { width:46%; aspect-ratio:1.05; left:40%; top:26%;
        background:radial-gradient(circle at 58% 42%, #C9BBA1, transparent 74%); animation:d2 34s ease-in-out infinite; }
  .b3 { width:42%; aspect-ratio:.9; left:24%; top:34%;
        background:radial-gradient(circle at 45% 55%, #BDC0B2, transparent 72%); animation:d3 30s ease-in-out infinite; }
  .b4 { width:34%; aspect-ratio:1.3; left:48%; top:8%;
        background:radial-gradient(circle at 50% 50%, #B3A48D, transparent 78%); animation:d1 40s ease-in-out infinite reverse; }
  .b5 { width:38%; aspect-ratio:1.15; left:6%; top:44%;
        background:radial-gradient(circle at 55% 45%, #CDC6B6, transparent 74%); animation:d2 44s ease-in-out infinite reverse; }
  @keyframes d1 { 0%,100%{transform:translate(0,0) scale(1)}    50%{transform:translate(-7%,5%) scale(1.10)} }
  @keyframes d2 { 0%,100%{transform:translate(0,0) scale(1.05)} 50%{transform:translate(6%,-6%) scale(.94)} }
  @keyframes d3 { 0%,100%{transform:translate(0,0) scale(.96)}  50%{transform:translate(4%,7%) scale(1.12)} }
  @media (prefers-reduced-motion: reduce) { .blob { animation:none !important; } }

  /*
   * 33px, up from 11. Kelly's call, 2026-08-20: three times larger.
   *
   * At that size the tracking has to come down — .08em was set for 11px small
   * caps, where letters need pushing apart to read; at 33px the same value
   * reads as a gap. And it wraps below ~430px, so the mobile rule scales it
   * rather than letting "THE USABILITY / LAB" break across two lines in the
   * corner of a hero.
   */
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
                     rgba(251,250,248,.97) 0%, rgba(251,250,248,.88) 34%,
                     rgba(251,250,248,.55) 56%, rgba(251,250,248,0) 74%);
          filter:blur(26px); }

  .brandmark { position:absolute; top:34px; left:38px; z-index:2;
               font-size:33px; font-weight:300; letter-spacing:-.005em;
               text-transform:uppercase; line-height:1; }
  .hero-in { position:relative; z-index:1; text-align:center; padding:0 32px; max-width:800px; }
  .hero-in h1 { font-size:56px; font-weight:300; line-height:1.14; letter-spacing:-.018em; margin:0 0 26px; }
  .hero-in .sub { font-size:15px; color:var(--ink-soft); margin:0 0 38px; letter-spacing:.005em; }
  /*
   * --ink, not --ink-soft. It sits below the veil's reach, on forms deep enough
   * to take the soft grey to 3.61:1 — under WCAG 1.4.3's 4.5. At 11px with this
   * much tracking the full ink still reads as a quiet label rather than a
   * heading, so the fix costs nothing the design wanted.
   */
  .scrollcue { position:absolute; bottom:30px; left:50%; transform:translateX(-50%); z-index:2;
               font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink);
               text-decoration:none; }

  .sec { max-width:720px; margin:0 auto; padding:130px 32px; text-align:center; }
  .eyebrow { font-size:11px; letter-spacing:.14em; text-transform:uppercase; color:var(--ink-soft); margin:0 0 26px; }
  .big { font-size:27px; line-height:1.42; font-weight:300; letter-spacing:-.012em; margin:0; }
  .big b { font-weight:500; }
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
  .shot .pinmark::after { content:"2"; position:absolute; inset:0; display:flex; align-items:center;
                          justify-content:center; color:var(--paper); font-size:13px; font-weight:500; }
  .finding { display:flex; gap:16px; margin-top:24px; }
  .finding .pin { flex:0 0 30px; height:30px; border-radius:50%; background:var(--ink); color:var(--paper);
                  font-size:13px; font-weight:500; display:flex; align-items:center; justify-content:center; }
  .finding h2 { margin:3px 0 8px; font-size:15px; font-weight:500; letter-spacing:-.01em; }
  .finding p { margin:0 0 8px; font-size:14px; line-height:1.62; color:var(--ink-soft); }
  .tag { display:inline-block; font-size:11px; letter-spacing:.06em; text-transform:uppercase; vertical-align:2px;
         background:var(--plaster); color:var(--ink-soft); padding:4px 10px; border-radius:100px; margin-left:8px; }
  .cite { font-size:12px; }
  .placeheld { font-size:12px; color:var(--ink-soft); font-style:italic; margin:18px 0 0; }

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
    .brandmark { top:24px; left:22px; font-size:19px; }
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
    <div class="forms" aria-hidden="true">
      <div class="blob b1"></div><div class="blob b2"></div>
      <div class="blob b3"></div><div class="blob b4"></div><div class="blob b5"></div>
    </div>
    <div class="veil" aria-hidden="true"></div>
    <div class="brandmark">The Usability Lab</div>
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
        <div class="pin">2</div>
        <div>
          <h2>Visibility of System Status<span class="tag">Moderate</span></h2>
          <p>The primary action gives no indication that anything happened between
             the click and the next screen loading.</p>
          <p class="cite">Cited: Nielsen Norman Group &mdash; Visibility of System Status</p>
        </div>
      </div>
      <p class="placeheld">This finding is a placeholder and says so. The real one lands when we
         run our own pipeline against this page, which is the only honest way to fill
         a slot like this before there are customers.</p>
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
 * The hero's one piece of interactivity: the forms lean toward the cursor.
 *
 * ## Why this is four lines of transform and not a particle system
 *
 * The component that started this design pushed 50,000 particles away from the
 * pointer, recomputing every one of them on the CPU each frame. This moves **one
 * element** — the container the four blurred forms already live in — by up to
 * 40px, eased. That is a single GPU-composited transform per frame, and the loop
 * stops the moment it settles rather than running forever.
 *
 * The parallax reads as depth because the forms are blurred and the text is not:
 * the background drifts under the headline and the headline stays put.
 *
 * ## What it refuses to do
 *
 * **Nothing at all under `prefers-reduced-motion`.** It returns before binding a
 * listener, so there is no pointer handler, no rAF loop, and no transform — the
 * same still frame the CSS already renders. Checked first, before any work.
 *
 * Written in plain `var`-and-`function` style for the same reason as the
 * stepper: this string is hashed into the page's Content-Security-Policy, so any
 * transform of the bytes would leave the browser silently refusing to run it.
 */
export const HERO_JS = `
(function () {
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  var forms = document.querySelector('.forms');
  if (!forms) return;

  var REACH = 40;
  var tx = 0, ty = 0, cx = 0, cy = 0, raf = null;

  function tick() {
    cx += (tx - cx) * 0.06;
    cy += (ty - cy) * 0.06;
    forms.style.transform = 'translate3d(' + (cx * REACH).toFixed(2) + 'px,' + (cy * REACH).toFixed(2) + 'px,0)';
    if (Math.abs(tx - cx) > 0.0005 || Math.abs(ty - cy) > 0.0005) {
      raf = window.requestAnimationFrame(tick);
    } else {
      raf = null;
    }
  }

  window.addEventListener('pointermove', function (e) {
    tx = (e.clientX / window.innerWidth - 0.5) * 2;
    ty = (e.clientY / window.innerHeight - 0.5) * 2;
    if (raf === null) raf = window.requestAnimationFrame(tick);
  }, { passive: true });
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
  1: "Lead with the thing that actually bothers you. It decides which reviewers we put on the page.",
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
