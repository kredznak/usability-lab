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
          --shade:#C9C0B2; --sage:#D6D8D0; --ink:#26221E; --ink-soft:#6E665C; }
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
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — The Usability Lab</title>
<style>${SHELL_CSS}${extraCss}</style></head>
<body><div class="wrap"><h1>${title}</h1>${body}</div></body></html>`;
}
