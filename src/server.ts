/**
 * `npm run serve` — §6's preview / email gate / full results, over HTTP.
 *
 * The first served surface in this repo. Everything before it was a CLI writing
 * files, which meant the sentence "free preview → email gate → full results"
 * had no implementation anywhere: `results.html` was a file, and a file has no
 * gate.
 *
 * ## What it is not
 *
 * Not Vercel, not Supabase, not a mail sender. §6 names all three and this uses
 * none of them — Kelly's call, 2026-08-18: prove the flow against the SQLite db
 * we already have, then swap the transport. The parts that would be dangerous
 * to get wrong later are the parts that are real here: the token is signed and
 * verified, and it is scoped to one audit.
 *
 * ## The four things it refuses
 *
 * 1. **An audit nobody published.** Only PUBLISHED and AUTO_PUBLISHED are
 *    reachable; a REVIEW_PENDING audit 404s exactly like a made-up id, because
 *    "this exists but you may not see it" is itself information.
 * 2. **A prefix.** `AuditStore.find` matches on prefix so the CLI can take
 *    eight characters. Eight hex characters is 32 bits and enumerable in an
 *    afternoon; the URL takes the whole UUID and uses `get`.
 * 3. **A token for a different audit.** `verify` takes the audit id as an
 *    argument for this reason — see tokens.ts.
 * 4. **Any file it was not asked to serve.** Images are matched against an
 *    allowlist built from the audit id, not sanitised for `..`.
 *
 * ## What it deliberately does not have
 *
 * No rate limit, no CSRF token, no HTTPS, no index of audits. The first three
 * are wrong to build against localhost and wrong to skip in front of the
 * public — B17 in the backlog says so with the cost. The fourth is a rule, not
 * an omission: an index would be a cross-customer surface, which §8 says a
 * customer must never reach.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { AuditStore, EventLog, EmailCaptureStore, type AuditRow } from "./db.js";
import { loadPublished, NotPublishable } from "./published.js";
import { publicHtml } from "./render.js";
import { sign, verify, looksLikeEmail, TOKEN_TTL_MS } from "./tokens.js";
import { SlidingWindow, inMinutes } from "./ratelimit.js";

const PORT = Number(process.env.PORT || 4000);

/**
 * A POST body cap. §10 lists 10K-character answers as a hostile input we have
 * never tested; an unbounded read here is the same bug with no attacker
 * required — one long request would sit in memory until the process died.
 */
const MAX_BODY = 8 * 1024;

/** Only these two states have a page a visitor is allowed to see. */
function published(audit: AuditRow | null): audit is AuditRow {
  return !!audit && (audit.status === "PUBLISHED" || audit.status === "AUTO_PUBLISHED");
}

const COOKIE = "ul_full";

/**
 * Scoped to one audit's path, so a reader of two audits holds two cookies and
 * neither can be presented for the other. The audit id is in the signature too;
 * this is the belt to that braces.
 *
 * `Secure` is set from an env flag rather than guessed. Guessing wrong in the
 * safe direction breaks every cookie on localhost; guessing wrong in the other
 * puts a bearer credential on the wire in clear. Whatever terminates TLS sets
 * `USABILITY_LAB_SECURE_COOKIES=1`, and B16 records that as part of the deploy,
 * not as a thing this file can decide.
 */
function setCookie(auditId: string, token: string, expiresAt: number): string {
  const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
  const secure = process.env.USABILITY_LAB_SECURE_COOKIES === "1" ? "; Secure" : "";
  return `${COOKIE}=${token}; Path=/a/${auditId}/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax${secure}`;
}

function clearCookie(auditId: string): string {
  return `${COOKIE}=; Path=/a/${auditId}/; Max-Age=0; HttpOnly; SameSite=Lax`;
}

function cookie(req: IncomingMessage, name: string): string | null {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

function send(
  res: ServerResponse,
  code: number,
  body: string,
  type = "text/html; charset=utf-8",
  extra: Record<string, string> = {},
): void {
  res.writeHead(code, {
    ...extra,
    "content-type": type,
    // The published page embeds its own CSS and no scripts at all. Saying so in
    // a header costs nothing and means an injected `<script>` — from a page we
    // captured, quoted into a finding — cannot execute in a customer's browser.
    "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'",
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}

/**
 * One 404 for everything, deliberately.
 *
 * A distinct "not published yet" would tell a stranger which audit ids are
 * real. The founder finds out what state an audit is in from `npm run review`,
 * where they are already authenticated by having the machine.
 */
function notFound(res: ServerResponse): void {
  send(res, 404, page("Not found", `<p>No audit at this address.</p>`));
}

/** The frame for the handful of pages that are not a rendered audit. */
function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — The Usability Lab</title>
<style>
  body { margin:0; background:#fbfaf8; color:#1a1a1a;
         font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  .wrap { max-width:640px; margin:0 auto; padding:64px 24px; }
  h1 { font-size:22px; margin:0 0 12px; }
  a { color:#E4572E; }
  code { background:#f0eeea; padding:2px 5px; border-radius:3px; font-size:14px; }
</style></head>
<body><div class="wrap"><h1>${title}</h1>${body}</div></body></html>`;
}

async function readBody(req: IncomingMessage): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const store = new AuditStore();
const captures = new EmailCaptureStore();
const events = new EventLog();

/**
 * B16's limits. The numbers are guesses and should be read as such — nobody has
 * used this yet, so they are set where a real visitor cannot plausibly reach
 * them and an automated one hits them in seconds.
 */
const MINUTE = 60_000;
/** One link per address per audit per five minutes. A double-click is not abuse. */
const recently = new SlidingWindow(1, 5 * MINUTE);
/** One results URL cannot mail twenty different people in an hour. */
const byAudit = new SlidingWindow(20, 60 * MINUTE);
/** One address cannot be mailed five times in an hour, across every audit. */
const byEmail = new SlidingWindow(5, 60 * MINUTE);

/** Renders a published audit, gated or revealed. */
function render(
  audit: AuditRow,
  opts: { reveal: boolean; asked?: boolean; again?: boolean; error?: string },
): string {
  const loaded = loadPublished(audit);
  const corrections = events
    .all(audit.audit_id)
    .filter((e) => e.type === "audit.corrected")
    .map((e) => ({ at: e.at, reason: String(e.data.reason ?? "") }));

  return publicHtml({
    capture: loaded.capture,
    kept: loaded.kept,
    allFindings: loaded.allFindings,
    annotatedImage: loaded.annotatedImage,
    summary: loaded.summary,
    corrections,
    reveal: opts.reveal,
    gate: opts.reveal
      ? undefined
      : {
          action: `/a/${audit.audit_id}/email`,
          asked: opts.asked,
          again: opts.again,
          error: opts.error,
        },
  });
}

async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const parts = url.pathname.split("/").filter(Boolean);

  if (url.pathname === "/") {
    return send(
      res,
      200,
      page(
        "The Usability Lab",
        `<p>Audits live at their own address. There is no directory — that is on purpose.</p>
         <p>If you have a results link, open it. If you are the founder, the links are printed by
            <code>npm run review</code>.</p>`,
      ),
    );
  }

  if (parts[0] !== "a" || !parts[1]) return notFound(res);
  const auditId = parts[1];

  // `get`, not `find`. A prefix lookup here would make a 122-bit id an 8-bit
  // one for anybody willing to type.
  const audit = store.get(auditId);
  if (!published(audit)) return notFound(res);

  const rest = parts.slice(2);

  // --- the annotated screenshot -------------------------------------------
  if (rest.length === 1 && rest[0]?.endsWith(".png")) {
    /**
     * An allowlist, and it is worth being precise about what it does.
     *
     * It is **not** what stops `../../../etc/passwd`: `new URL()` resolves
     * dot-segments before this code runs, and a segment holding a literal `/`
     * would have split into two parts and missed this branch entirely. Writing
     * the comment the other way round — as if this line were the traversal
     * defence — is how a test gets written that passes for the wrong reason,
     * and the first version of `server.test.ts` did exactly that.
     *
     * What it does do is bound the route to the two files an audit is allowed
     * to expose. Everything else in that folder — the raw screenshot, anything
     * a future step drops there — stays unreachable by name, and stays
     * unreachable when someone adds a third PNG without thinking about HTTP.
     */
    const wanted = rest[0];
    const allowed = [`${audit.audit_id}-annotated.png`, `${audit.audit_id}-page.png`];
    const name = allowed.find((a) => a === wanted);
    if (!name) return notFound(res);
    const file = path.join(loadPublished(audit).dir, name);
    if (!existsSync(file)) return notFound(res);
    res.writeHead(200, { "content-type": "image/png", "cache-control": "private, max-age=300" });
    return void res.end(await readFile(file));
  }

  // --- the email gate ------------------------------------------------------
  if (rest.length === 1 && rest[0] === "email") {
    if (req.method !== "POST") return notFound(res);

    const body = await readBody(req);
    if (body === null) {
      return send(res, 413, render(audit, { reveal: false, error: "That was too long to be an email." }));
    }
    const email = (new URLSearchParams(body).get("email") ?? "").trim().toLowerCase();
    if (!looksLikeEmail(email)) {
      return send(res, 400, render(audit, { reveal: false, error: "That does not look like an email address." }));
    }

    const now = Date.now();

    const throttle = (verdict: { retryAfterMs: number }, key: string) => {
      events.record({ audit_id: audit.audit_id, type: "gate.throttled", data: { key } });
      res.setHeader("retry-after", String(Math.ceil(verdict.retryAfterMs / 1000)));
      return send(
        res,
        429,
        render(audit, {
          reveal: false,
          error: `That is more requests than this page sends. Try again in ${inMinutes(
            verdict.retryAfterMs,
          )}.`,
        }),
      );
    };

    /**
     * The per-audit allowance is checked **first**, and the order is the whole
     * point.
     *
     * The cooldown below is keyed on (audit, address), so every new address
     * makes a new key. Checked first, it would be an unbounded map that any
     * stranger with one results URL could grow for free — the limiter becoming
     * the denial of service it was added to prevent. Peeked here, no map can
     * gain a key until the audit's twenty-an-hour has been spent, which bounds
     * all three of them together.
     *
     * `peek` rather than `hit`, so a visitor who is only inside the cooldown
     * does not also spend the audit's allowance.
     */
    const gate = byAudit.peek(audit.audit_id, now);
    if (!gate.allowed) return throttle(gate, "audit");

    /**
     * The cooldown, and it is the friendly one.
     *
     * A visitor who clicks twice has done nothing wrong, and telling them "too
     * many requests" for it would be both rude and untrue. It also matters that
     * this path issues **no new link and records no new event** — otherwise a
     * double-click would put two `email.captured` events in a permanent log for
     * one person deciding once.
     */
    if (!recently.hit(`${audit.audit_id}|${email}`, now).allowed) {
      return send(res, 200, render(audit, { reveal: false, asked: true, again: true }));
    }

    /**
     * Now spend the allowances. Per audit is the mail-bomb defence — one
     * results URL, ten thousand different recipients. Per address is the
     * narrower one, the same person targeted through several audits.
     */
    const perAudit = byAudit.hit(audit.audit_id, now);
    if (!perAudit.allowed) return throttle(perAudit, "audit");
    const perEmail = byEmail.hit(email, now);
    if (!perEmail.allowed) return throttle(perEmail, "email");

    captures.capture(audit.audit_id, email);
    // The address is not in the event. §8 makes events permanent while captures
    // expire at 90 days, and an address is exactly the kind of thing that must
    // not outlive the deletion policy that covers it. The funnel needs the
    // count; the count is in `email_captures`.
    events.record({ audit_id: audit.audit_id, type: "email.captured", data: {} });

    const link = `http://localhost:${PORT}/a/${audit.audit_id}/full?t=${sign(audit.audit_id, email)}`;
    // Where the mail send goes. Until it does, the link is printed rather than
    // faked — a page that says "check your email" while nothing was sent is a
    // lie we would then have to remember was a lie.
    console.log(`\n  magic link for ${email}\n  ${link}\n`);

    return send(res, 200, render(audit, { reveal: false, asked: true }));
  }

  // --- the full results ----------------------------------------------------
  if (rest.length === 1 && rest[0] === "full") {
    /**
     * The query string first, then the cookie.
     *
     * A magic link is a bearer credential, and one in a query string lives on
     * in browser history, in a screenshot of a shared screen, and in the access
     * log of anything between us and the reader — for the seven days it stays
     * valid. So the first visit trades it for a cookie and redirects to a clean
     * URL; every later visit uses the cookie and the link is spent.
     *
     * This adds no CSRF surface. The cookie is read by exactly this route,
     * which changes nothing, and the one route that does change something —
     * the email form — never reads it. The rule to keep: **if a
     * state-changing route ever reads this cookie, it needs a CSRF token that
     * day.**
     */
    const fromQuery = url.searchParams.get("t");
    const token = fromQuery ?? cookie(req, COOKIE) ?? "";
    const check = verify(token, audit.audit_id);

    if (!check.ok) {
      /**
       * Recorded, not punished — the withdrawn half of B16.
       *
       * The entry originally called for locking an audit after N bad tokens.
       * That is a denial of service anyone holding the results URL could
       * trigger against the customer whose audit it is, and it would defend a
       * 256-bit HMAC against guessing, which is not a thing that happens. So
       * the attempt becomes visible and nothing gets locked.
       *
       * The token itself is not in the event — it is a credential, and §8
       * makes events permanent.
       */
      events.record({
        audit_id: audit.audit_id,
        type: "token.rejected",
        data: { reason: check.reason, source: fromQuery ? "link" : "cookie" },
      });

      // The reason is shown because every one of them is the visitor's problem
      // to solve — an expired link needs re-requesting, a wrong-audit link
      // needs the right one. None of them tell a stranger anything they could
      // not learn by trying.
      const explain: Record<string, string> = {
        malformed: "That link is incomplete.",
        "bad-signature": "That link has been altered.",
        expired: "That link has expired. Links last seven days.",
        "wrong-audit": "That link is for a different audit.",
      };
      const headers: Record<string, string> = {};
      // A cookie that no longer verifies is cleared, so a stale one cannot keep
      // producing this page every time the reader comes back.
      if (!fromQuery && token) headers["set-cookie"] = clearCookie(audit.audit_id);
      return send(
        res,
        403,
        page(
          "Not this page",
          `<p>${explain[check.reason]}</p>
           <p><a href="/a/${audit.audit_id}">Ask for a new one</a>.</p>`,
        ),
        "text/html; charset=utf-8",
        headers,
      );
    }

    captures.markVerified(audit.audit_id, check.claims.email);
    events.record({ audit_id: audit.audit_id, type: "full.viewed", data: {} });

    if (fromQuery) {
      // 303, not 301: the browser must not cache "this URL is a redirect", or a
      // later visit with a fresh token would skip the exchange.
      res.writeHead(303, {
        location: `/a/${audit.audit_id}/full`,
        "set-cookie": setCookie(audit.audit_id, fromQuery, check.claims.expiresAt),
      });
      return void res.end();
    }

    return send(res, 200, render(audit, { reveal: true }));
  }

  // --- the preview ---------------------------------------------------------
  if (rest.length === 0) {
    /**
     * The trailing slash is load-bearing.
     *
     * `publicHtml` points at the screenshot with a bare filename, because on
     * disk the page and the image sit in one folder. Served from `/a/<id>`
     * that resolves to `/a/<id>-annotated.png` — a sibling, not a child — and
     * the page renders with a broken image and no error anywhere. From
     * `/a/<id>/` it resolves correctly, and so does `/a/<id>/full`.
     */
    if (!url.pathname.endsWith("/")) {
      res.writeHead(301, { location: `${url.pathname}/${url.search}` });
      return void res.end();
    }
    events.record({ audit_id: audit.audit_id, type: "preview.viewed", data: {} });
    return send(res, 200, render(audit, { reveal: false }));
  }

  return notFound(res);
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    // A missing artifact is the expected failure — an audit whose `out/` folder
    // was cleaned. It is a 404 to the visitor and a line to us; anything else
    // is a bug and says so, without putting a stack trace on a customer's page.
    if (err instanceof NotPublishable) {
      console.error(`  ${err.auditId}: ${err.reason} — artifacts missing, served 404`);
      return notFound(res);
    }
    console.error(err);
    send(res, 500, page("Something broke", `<p>That is ours, not yours. It has been logged.</p>`));
  });
});

server.listen(PORT, () => {
  const ready = store.list("PUBLISHED").length + store.list("AUTO_PUBLISHED").length;
  console.log(
    `\n  The Usability Lab — http://localhost:${PORT}\n` +
      `  ${ready} audit${ready === 1 ? "" : "s"} reachable. Links are printed by \`npm run review\`.\n` +
      `  Magic links print here; no email is sent.\n`,
  );
});
