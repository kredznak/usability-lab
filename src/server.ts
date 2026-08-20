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
 * No HTTPS, and no index of audits. The first is a deploy blocker rather than a
 * task — the magic link is a bearer credential in a URL on its first use, and
 * whatever terminates TLS must set `USABILITY_LAB_SECURE_COOKIES=1` because this
 * file refuses to guess. The second is a rule, not an omission: an index would
 * be a cross-customer surface, which §8 says a customer must never reach.
 *
 * Rate limits arrived with B16 and a CSRF token with the re-audit button; the
 * paragraph that used to say otherwise outlived both by a commit each, which is
 * the ordinary way a file's header stops being true.
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  AuditStore,
  EventLog,
  EmailCaptureStore,
  SubscriptionStore,
  ReauditRequestStore,
  AuditRequestStore,
  type AuditRow,
  type AuditRequestRow,
} from "./db.js";
import { loadPublished, NotPublishable } from "./published.js";
import { publicHtml, escapeHtml, type PublishInput } from "./render.js";
import { STRICT_CSP } from "./marketing.js";
import { asset } from "./assets.js";
import { QUESTIONS, type Answers } from "./profile.js";
import { checkUrl } from "./urlcheck.js";
import { sign, verify, looksLikeEmail, csrfFor, csrfMatches } from "./tokens.js";
import { SlidingWindow, inMinutes } from "./ratelimit.js";
import { checkFairUse } from "./fairuse.js";
import {
  stripeConfig,
  liveStripe,
  verifyWebhook,
  mapStatus,
  readSubscription,
  type StripeClient,
} from "./stripe.js";

const PORT = Number(process.env.PORT || 4000);

/**
 * A POST body cap. §10 lists 10K-character answers as a hostile input we have
 * never tested; an unbounded read here is the same bug with no attacker
 * required — one long request would sit in memory until the process died.
 */
const MAX_BODY = 8 * 1024;

/**
 * The question flow posts five free-text answers, so it needs more room than an
 * email address — but not much more. Each answer is separately capped at
 * `MAX_ANSWER`; this bounds the request even when every character needs three
 * bytes of percent-encoding.
 */
const MAX_REQUEST_BODY = 32 * 1024;

/**
 * §10 lists a 10,000-character answer as a hostile input nobody has tested.
 * This is where that stops being untested. A thousand characters is longer than
 * anyone answers "where do they seem to drop off?" honestly, and short enough
 * that five of them cannot become a prompt of their own.
 */
const MAX_ANSWER = 1000;

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
  /**
   * The published page embeds its own CSS and no scripts at all. Saying so in a
   * header costs nothing and means an injected `<script>` — from a page we
   * captured, quoted into a finding — cannot execute in a customer's browser.
   *
   * Defaulted rather than hardcoded, because the marketing pages need a font and
   * the question flow needs one script, and neither of those is a reason to
   * loosen the policy on a page that quotes a stranger's site. A route that
   * needs more says so here; a route that says nothing gets the strict one.
   */
  csp = STRICT_CSP,
): void {
  res.writeHead(code, {
    ...extra,
    "content-type": type,
    "content-security-policy": csp,
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
  .lead { font-size:17px; margin:0 0 16px; }
  .hint { color:#6b6257; font-size:14px; margin:6px 0 22px; }
  .err { color:#a3301a; font-size:15px; margin:0 0 16px; }
  form label { display:block; font-weight:600; font-size:15px; margin:0 0 6px; }
  form input, form textarea { width:100%; box-sizing:border-box; padding:9px 11px;
        font:inherit; font-size:15px; border:1px solid #bbb; border-radius:3px;
        background:#fff; color:inherit; }
  form textarea { margin-bottom:20px; resize:vertical; }
  form button { padding:10px 18px; font:inherit; font-size:15px; cursor:pointer;
        border:0; border-radius:3px; background:#E4572E; color:#fff; }
</style></head>
<body><div class="wrap"><h1>${title}</h1>${body}</div></body></html>`;
}

async function readBody(req: IncomingMessage, max = MAX_BODY): Promise<string | null> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > max) return null;
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const store = new AuditStore();
const captures = new EmailCaptureStore();
const events = new EventLog();
const subs = new SubscriptionStore();
const requests = new ReauditRequestStore();
const asks = new AuditRequestStore();

/**
 * Where §1's "prefer to talk it through?" goes.
 *
 * The founder's own address, because at nine published audits the person on the
 * other end of that link is Kelly and pretending otherwise with a
 * `hello@`-shaped alias would be the first untrue thing on the page. Overridable
 * the day that stops being true.
 */
const TALK_TO = process.env.USABILITY_LAB_CONTACT ?? "kredznak@gmail.com";

/**
 * Stripe, or honestly nothing.
 *
 * Read once at startup rather than per request, so the page and the webhook
 * route can never disagree about whether checkout exists. `null` here is not an
 * error state — it is today's state, and every surface below is written to say
 * so out loud rather than to half-work.
 */
const stripe = stripeConfig();
const billing: StripeClient | null = stripe ? liveStripe(stripe) : null;

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

/**
 * The question flow's two, and the order they are checked in is the same lesson
 * B16 taught: the **global** allowance is peeked first, so the per-client map
 * cannot gain a key until the whole server has spent its hourly budget. Checked
 * the other way round, anyone with a script and a spoofed source could grow an
 * unbounded map for free.
 *
 * They key on the connecting socket's address, which is honest on localhost and
 * becomes a proxy's address the moment anything sits in front. **`X-Forwarded-For`
 * is deliberately not read** — trusting a header the client sets is how a
 * per-client limit becomes a per-header-value limit, which is no limit at all.
 * Whatever terminates TLS will have to be taught to us explicitly, alongside
 * `USABILITY_LAB_SECURE_COOKIES`.
 */
const asksGlobally = new SlidingWindow(50, 60 * MINUTE);
const asksByClient = new SlidingWindow(5, 60 * MINUTE);

/**
 * §0's question flow, over HTTP — five questions and a URL.
 *
 * The same five `QUESTIONS` the CLI asks. `profile.ts` has said "the CLI asks
 * these; the web flow will ask the same ones" since the profiler was written,
 * and a second list here would be two products' worth of questions feeding one
 * schema.
 *
 * Every answer is optional. The CLI lets you press enter past any of them and
 * the profile comes back honest about the gap; a web form that demanded all five
 * would be collecting worse data, not more.
 *
 * Typed values are echoed back on an error so nobody retypes five answers over
 * a mistyped URL — which makes this the first page here rendered from a
 * stranger's text, and every interpolation below goes through `escapeHtml`.
 */
function questionForm(state: { url?: string; answers?: Answers; error?: string } = {}): string {
  const fields = QUESTIONS.map(
    (q, i) => `      <label for="q${i}">${escapeHtml(q)}</label>
      <textarea id="q${i}" name="q${i}" rows="2" maxlength="${MAX_ANSWER}">${escapeHtml(
        state.answers?.[q] ?? "",
      )}</textarea>`,
  ).join("\n");

  return `<form method="post" action="/request">
      <label for="url">The page you want looked at</label>
      <input id="url" name="url" type="url" required inputmode="url"
             placeholder="https://yoursite.com/" value="${escapeHtml(state.url ?? "")}">
      <p class="hint">One page. We stop at any login wall.</p>
${fields}
      ${state.error ? `<p class="err">${escapeHtml(state.error)}</p>` : ""}
      <button type="submit">Ask for an audit</button>
      <p class="hint">Five questions, all optional. Skipping them means a general
         review instead of one aimed at what you are worried about.</p>
    </form>`;
}

/**
 * §6's "your team is assembling", told honestly.
 *
 * The honesty is the point, and F1 is why. A capture that failed must say so
 * — "retry ×3 then PARKED; **visitor notified honestly**" is the row in the
 * failure catalogue, and until this page existed there was no visitor-facing
 * place for that sentence to go. A spinner that never resolves is the version
 * of this page that lies.
 *
 * There is a gap between a request being claimed and the audit row existing,
 * because the queue runner stamps the id before it shells out. That gap gets
 * its own wording rather than being folded into "queued", which would tell
 * someone their audit had not started when it had.
 */
function statusPage(row: AuditRequestRow): string {
  const audit = row.audit_id ? store.get(row.audit_id) : null;
  const site = escapeHtml(row.url);

  const body = (state: string, extra = "") =>
    page(
      "Your audit",
      `<p class="lead">${site}</p><p>${state}</p>${extra}
       <p class="hint">This page is yours &mdash; keep the address. It updates as we go.</p>`,
    );

  if (!row.audit_id) {
    return body(
      `In the queue. We look at these in the order they arrive, and yours has not started yet.`,
    );
  }
  if (!audit) return body(`Starting now.`);

  switch (audit.status) {
    case "PUBLISHED":
    case "AUTO_PUBLISHED":
      return body(
        `Ready.`,
        `<p><a href="/a/${escapeHtml(audit.audit_id)}/">Read the results</a></p>`,
      );
    case "REVIEW_PENDING":
      return body(
        `The audit is done and a person is reading it before it goes out. ` +
          `That is the slowest part and the reason we stand behind what it says.`,
      );
    case "CAPTURE_FAILED":
    case "PARKED":
      // F1, said out loud.
      return body(
        `We could not load that page well enough to audit it &mdash; some sites block ` +
          `automated browsers, and some need a login we will not go past. Nothing was ` +
          `published and nothing was charged.`,
        `<p><a href="/">Try a different page</a></p>`,
      );
    case "FAILED":
      return body(
        `This one broke on our side. It has been logged and nothing half-finished was ` +
          `published, which is the part we care about most.`,
        `<p><a href="/">Start another</a></p>`,
      );
    default:
      return body(`Your team is assembling. Reviewers are on the page now.`);
  }
}

/** The URL a re-audit of this audit would capture. */
function targetUrl(audit: AuditRow): string {
  return audit.final_url ?? audit.url;
}

/**
 * What the offer block should say to this reader, right now.
 *
 * Every branch is a read of stored state rather than anything passed in from the
 * request, so a reader who reloads sees the same thing they saw — including the
 * refusal. `justRequested` is the one exception, and it is the one fact a reload
 * genuinely cannot reproduce: "you just did that."
 */
function notSubscribed(
  audit: AuditRow,
  sessionToken: string,
  justPaid = false,
): PublishInput["offer"] {
  return stripe
    ? {
        subscribed: false,
        talkTo: TALK_TO,
        checkoutLive: true,
        action: `/a/${audit.audit_id}/subscribe`,
        csrf: csrfFor(sessionToken),
        justPaid,
      }
    : { subscribed: false, talkTo: TALK_TO, checkoutLive: false, justPaid };
}

function offerFor(
  audit: AuditRow,
  email: string,
  sessionToken: string,
  justRequested = false,
  justPaid = false,
): PublishInput["offer"] {
  if (!subs.isActive(email)) return notSubscribed(audit, sessionToken, justPaid);
  const fair = checkFairUse(requests.forEmail(email), targetUrl(audit));
  return {
    subscribed: true,
    talkTo: TALK_TO,
    action: `/a/${audit.audit_id}/reaudit`,
    csrf: csrfFor(sessionToken),
    queued: requests.pending(audit.audit_id, email),
    justRequested,
    refusal: fair.reason,
  };
}

/** Renders a published audit, gated or revealed. */
function render(
  audit: AuditRow,
  opts: {
    reveal: boolean;
    asked?: boolean;
    again?: boolean;
    error?: string;
    offer?: PublishInput["offer"];
  },
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
    offer: opts.offer,
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

  // --- static assets -------------------------------------------------------
  /**
   * One name, one buffer, one year.
   *
   * `immutable` because the bytes behind `/s/inter.woff2` cannot change without
   * a deploy, so revalidating on every page view would be a round trip to be
   * told nothing. If the font is ever re-subset it gets a new name, not new
   * bytes at the old one.
   *
   * Not routed through `send()`: that writes a string and stamps a text
   * content-type. A Buffer with its own headers is clearer than a branch inside
   * a function whose whole job is HTML.
   */
  if (parts[0] === "s" && parts.length === 2) {
    const found = asset(parts[1]!);
    if (!found) return notFound(res);
    res.writeHead(200, {
      "content-type": found.type,
      "cache-control": "public, max-age=31536000, immutable",
      "content-security-policy": STRICT_CSP,
      "x-content-type-options": "nosniff",
    });
    return void res.end(found.body);
  }

  // --- the question flow ---------------------------------------------------
  if (url.pathname === "/") {
    events.record({ audit_id: null, type: "question.started", data: {} });
    return send(
      res,
      200,
      page(
        "The Usability Lab",
        `<p class="lead">Tell us about one page and we will audit it &mdash; with the
            element each finding is about, so you can check us.</p>${questionForm()}
         <p class="hint">Audits live at their own address and there is no directory of
            them, on purpose. If you already have a results link, open it.</p>`,
      ),
    );
  }

  if (url.pathname === "/request") {
    if (req.method !== "POST") return notFound(res);

    const body = await readBody(req, MAX_REQUEST_BODY);
    if (body === null) {
      return send(res, 413, page("Too long", questionForm({ error: "That was more than we can take in one go." })));
    }
    const form = new URLSearchParams(body);
    const answers: Answers = {};
    for (const [i, q] of QUESTIONS.entries()) {
      const value = (form.get(`q${i}`) ?? "").trim();
      if (value) answers[q] = value;
    }
    const typed = (form.get("url") ?? "").trim();
    const again = (error: string, code = 400) =>
      send(res, code, page("The Usability Lab", questionForm({ url: typed, answers, error })));

    const tooLong = Object.values(answers).some((a) => a.length > MAX_ANSWER);
    if (tooLong) {
      return again(`One of those answers is longer than ${MAX_ANSWER} characters. A sentence or two is plenty.`);
    }

    const now = Date.now();
    const client = req.socket.remoteAddress ?? "unknown";

    /**
     * Global first, then per client — B16's ordering lesson, applied to a map
     * whose keys an attacker chooses. See the limiter declarations above.
     */
    const overall = asksGlobally.peek("all", now);
    if (!overall.allowed) {
      events.record({ audit_id: null, type: "request.throttled", data: { key: "global" } });
      res.setHeader("retry-after", String(Math.ceil(overall.retryAfterMs / 1000)));
      return again(`More audits have been asked for than we can look at right now. Try again in ${inMinutes(overall.retryAfterMs)}.`, 429);
    }
    const mine = asksByClient.hit(client, now);
    if (!mine.allowed) {
      events.record({ audit_id: null, type: "request.throttled", data: { key: "client" } });
      res.setHeader("retry-after", String(Math.ceil(mine.retryAfterMs / 1000)));
      return again(`That is more audits than one person can ask for at once. Try again in ${inMinutes(mine.retryAfterMs)}.`, 429);
    }

    /**
     * The URL check, and it is the reason this route was the careful one.
     *
     * Until this form existed we chose every URL we ever captured. Now a
     * stranger does, and `capture()` runs a real browser on our network — see
     * urlcheck.ts on what that makes it. The refusal never echoes the address
     * back, and the event records the *reason*, never the URL: §8 makes events
     * permanent, and a rejected URL is somebody else's data we decided not to
     * hold.
     */
    const verdict = await checkUrl(typed);
    if (!verdict.ok) {
      events.record({ audit_id: null, type: "request.rejected", data: { reason: verdict.reason } });
      return again(verdict.message);
    }

    // Spend the global allowance only once the request is one we would act on,
    // so a hundred typos do not lock the door for the next real visitor.
    asksGlobally.hit("all", now);

    const requestId = randomUUID();
    asks.create(requestId, verdict.url, answers);
    events.record({
      audit_id: null,
      type: "question.completed",
      // How many of the five they answered, and nothing they wrote. The answers
      // are in the request row; §8 makes events permanent and the answers are a
      // visitor's words about their own business.
      data: { answered: Object.keys(answers).length },
    });

    // 303, so a refresh of the status page is not a resubmission.
    res.writeHead(303, { location: `/r/${requestId}` });
    return void res.end();
  }

  // --- Stripe's webhook ----------------------------------------------------
  if (url.pathname === "/stripe/webhook") {
    /**
     * Public, and authenticated by a signature and nothing else.
     *
     * No cookie is read, so there is no CSRF token — there is no session to
     * ride. What stands in its place is `verifyWebhook`, and it is the single
     * most dangerous function in the repo: get it wrong and anyone on the
     * internet can grant themselves a subscription by POSTing JSON here.
     *
     * The route 404s when Stripe is not configured rather than 400ing, so an
     * unconfigured deployment does not advertise an endpoint it cannot check.
     */
    if (req.method !== "POST" || !stripe) return notFound(res);

    const raw = await readBody(req, MAX_REQUEST_BODY);
    if (raw === null) return send(res, 413, "too large", "text/plain; charset=utf-8");

    const check = verifyWebhook(raw, req.headers["stripe-signature"] as string | undefined, stripe.webhookSecret);
    if (!check.ok) {
      // The reason, never the body. §8 makes events permanent, and an unverified
      // body is whatever a stranger chose to send.
      events.record({ audit_id: null, type: "webhook.rejected", data: { reason: check.reason } });
      return send(res, 400, check.reason, "text/plain; charset=utf-8");
    }

    const object = check.event.data.object;
    /**
     * The address is ours, not the payer's.
     *
     * Stripe's checkout form lets whoever is paying type any email they like.
     * Believing it would mean a card grants access to an arbitrary address —
     * the whole authorization model handed to anyone willing to spend $29. So
     * the only address considered is the one this server wrote into metadata
     * when it created the session, from a signed results-page session.
     */
    const metadata = (object.metadata as Record<string, string> | undefined) ?? {};
    const email = metadata.ul_email ?? null;

    if (!email) {
      // Acknowledged, not acted on. A 200 stops Stripe retrying something that
      // will never succeed; recording it means we find out it happened.
      events.record({ audit_id: null, type: "webhook.unattributed", data: { type: check.event.type } });
      return send(res, 200, "no ul_email", "text/plain; charset=utf-8");
    }

    if (check.event.type === "checkout.session.completed") {
      // The session says a payment succeeded but carries no period end; the
      // subscription events that follow carry the dates. Marking `past_due`
      // here would lock out a customer who just paid, and marking `active` with
      // no end date grants nothing (see db.ts), so this waits — Stripe sends
      // `customer.subscription.created`/`updated` within the same breath, and
      // reconciliation is the backstop if it does not.
      events.record({ audit_id: null, type: "checkout.completed", data: {} });
      return send(res, 200, "ok", "text/plain; charset=utf-8");
    }

    if (check.event.type.startsWith("customer.subscription.")) {
      const sub = readSubscription(object);
      const status =
        check.event.type === "customer.subscription.deleted" ? "canceled" : mapStatus(sub.status);
      subs.upsert(email, {
        status,
        stripeCustomerId: sub.customerId || null,
        stripeSubscriptionId: sub.id || null,
        currentPeriodEnd: status === "canceled" ? null : sub.currentPeriodEnd,
      });
      events.record({ audit_id: null, type: "subscription.changed", data: { status } });
      return send(res, 200, "ok", "text/plain; charset=utf-8");
    }

    // Everything else Stripe sends is acknowledged and ignored. A 200 for an
    // event we do not handle is the difference between "we chose not to care"
    // and an endpoint Stripe retries forever.
    return send(res, 200, "ignored", "text/plain; charset=utf-8");
  }

  // --- where is my audit ---------------------------------------------------
  if (parts[0] === "r" && parts.length === 2 && parts[1]) {
    // Whole id, never a prefix. The same 122-bit reasoning as an audit URL, and
    // here it is the only thing between one visitor's request and another's.
    const row = asks.get(parts[1]);
    if (!row) return notFound(res);
    return send(res, 200, statusPage(row));
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

    // `?paid=1` is Stripe's `success_url` coming back. It is a hint from a
    // redirect and nothing more — it grants nothing, it only changes what the
    // page says while the webhook is in flight.
    const justPaid = url.searchParams.get("paid") === "1";
    return send(
      res,
      200,
      render(audit, {
        reveal: true,
        offer: offerFor(audit, check.claims.email, token, false, justPaid),
      }),
    );
  }

  // --- starting a subscription ---------------------------------------------
  if (rest.length === 1 && rest[0] === "subscribe") {
    if (req.method !== "POST") return notFound(res);

    // Cookie only, same reasoning as the re-audit button: a state change
    // reachable by URL is one a link preview can make.
    const token = cookie(req, COOKIE) ?? "";
    const check = verify(token, audit.audit_id);
    if (!check.ok) {
      events.record({
        audit_id: audit.audit_id,
        type: "token.rejected",
        data: { reason: check.reason, source: "cookie", route: "subscribe" },
      });
      return send(
        res,
        403,
        page(
          "Not this page",
          `<p>That session is no longer valid.</p>
           <p><a href="/a/${audit.audit_id}">Ask for a new link</a>.</p>`,
        ),
      );
    }

    const body = await readBody(req);
    if (body === null) return send(res, 413, page("Too long", `<p>That request was too large.</p>`));
    if (!csrfMatches(token, new URLSearchParams(body).get("csrf") ?? "")) {
      events.record({ audit_id: audit.audit_id, type: "csrf.rejected", data: { route: "subscribe" } });
      return send(
        res,
        403,
        page(
          "That request did not come from this page",
          `<p>Open the results again and use the button there.</p>
           <p><a href="/a/${audit.audit_id}/full">Back to the results</a>.</p>`,
        ),
      );
    }

    const email = check.claims.email;
    // Already paying. Sending them to Checkout again would sell a second
    // subscription to somebody who has one, which Stripe would happily do.
    if (subs.isActive(email)) {
      return send(res, 200, render(audit, { reveal: true, offer: offerFor(audit, email, token) }));
    }
    if (!billing) {
      return send(res, 503, render(audit, { reveal: true, offer: notSubscribed(audit, token) }));
    }

    try {
      const session = await billing.createCheckoutSession({ email, auditId: audit.audit_id });
      if (!session.url) throw new Error("no checkout url");
      events.record({ audit_id: audit.audit_id, type: "checkout.started", data: {} });
      // 303 to Stripe. This is the one redirect here that leaves our origin,
      // and it carries no credential — the session id is Stripe's.
      res.writeHead(303, { location: session.url });
      return void res.end();
    } catch (err) {
      // The message can carry Stripe's own error text; it goes to our console
      // and not to the visitor, and the event records only that it happened.
      console.error(`  checkout failed for ${audit.audit_id}: ${String(err)}`);
      events.record({ audit_id: audit.audit_id, type: "checkout.failed", data: {} });
      return send(
        res,
        502,
        page(
          "That did not go through",
          `<p>We could not start checkout just now. Nothing was charged.</p>
           <p><a href="/a/${audit.audit_id}/full">Back to the results</a>, or
              <a href="mailto:${escapeHtml(TALK_TO)}">email us</a>.</p>`,
        ),
      );
    }
  }

  // --- asking for a re-audit -----------------------------------------------
  if (rest.length === 1 && rest[0] === "reaudit") {
    if (req.method !== "POST") return notFound(res);

    /**
     * The cookie only — no `?t=` fallback, unlike `/full`.
     *
     * A state change reachable by URL is a state change a link preview can
     * make. Slack, iMessage and every mail client fetch what you paste at
     * them, and this route's job is to queue work that costs ~$0.65 to act on.
     * `/full` accepts a token in the query because reading a page is safe to
     * do by accident; this is not.
     */
    const token = cookie(req, COOKIE) ?? "";
    const check = verify(token, audit.audit_id);
    if (!check.ok) {
      events.record({
        audit_id: audit.audit_id,
        type: "token.rejected",
        data: { reason: check.reason, source: "cookie", route: "reaudit" },
      });
      return send(
        res,
        403,
        page(
          "Not this page",
          `<p>That session is no longer valid.</p>
           <p><a href="/a/${audit.audit_id}">Ask for a new link</a>.</p>`,
        ),
      );
    }

    const body = await readBody(req);
    if (body === null) return send(res, 413, page("Too long", `<p>That request was too large.</p>`));

    /**
     * The CSRF check, and the rule it settles.
     *
     * `server.ts` has carried one instruction since the cookie was introduced:
     * **if a state-changing route ever reads this cookie, it needs a CSRF token
     * that day.** This is that route and this is that day. The token is derived
     * from the session rather than stored, so it needs no table and cannot
     * outlive the session it belongs to — see tokens.ts.
     *
     * Checked *after* the session and *before* anything is read out of the
     * body, so a forged post learns nothing except that it was forged.
     */
    if (!csrfMatches(token, new URLSearchParams(body).get("csrf") ?? "")) {
      events.record({ audit_id: audit.audit_id, type: "csrf.rejected", data: { route: "reaudit" } });
      return send(
        res,
        403,
        page(
          "That request did not come from this page",
          `<p>Open the results again and use the button there.</p>
           <p><a href="/a/${audit.audit_id}/full">Back to the results</a>.</p>`,
        ),
      );
    }

    const email = check.claims.email;
    const full = (offer: PublishInput["offer"], code = 200) =>
      send(res, code, render(audit, { reveal: true, offer }));

    // Not subscribed: the page says so in its own words rather than 403-ing at
    // someone who is only looking at a button we rendered.
    if (!subs.isActive(email)) {
      events.record({ audit_id: audit.audit_id, type: "reaudit.refused", data: { why: "not-subscribed" } });
      return full(notSubscribed(audit, token), 403);
    }

    /**
     * The cap is checked here, on the write, and not only where the button is
     * drawn. A rendered form is a suggestion; this is the refusal. §11's claim
     * that worst-case subscriber cost is structural rests on this line and not
     * on the one in `render.ts`.
     */
    const fair = checkFairUse(requests.forEmail(email), targetUrl(audit));
    if (!fair.allowed) {
      events.record({
        audit_id: audit.audit_id,
        type: "reaudit.refused",
        data: { why: "fair-use", limit: fair.limit },
      });
      return full(offerFor(audit, email, token), 429);
    }

    // A second click records nothing. Nothing visible happens for hours, so the
    // second click is the expected behaviour rather than the abusive one — and
    // two rows would be two captures for one decision.
    if (requests.pending(audit.audit_id, email)) {
      return full(offerFor(audit, email, token));
    }

    requests.request(audit.audit_id, email, targetUrl(audit));
    // No address in the event; the row above holds it. §8 makes events
    // permanent and captures expire at 90 days.
    events.record({ audit_id: audit.audit_id, type: "reaudit.requested", data: {} });
    return full(offerFor(audit, email, token, true));
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
