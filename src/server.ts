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
  type AuditStatus,
} from "./db.js";
import { loadPublished, NotPublishable } from "./published.js";
import { publicHtml, escapeHtml, type PublishInput } from "./render.js";
import {
  STRICT_CSP,
  MARKETING_CSP,
  STEPPED_CSP,
  HOME_CSP,
  page,
  homePage,
  questionsPage,
  signInPage,
  accountPage,
} from "./marketing.js";
import { asset } from "./assets.js";
import { mailConfig, deliver } from "./mail.js";
import { clientIp } from "./clientip.js";
import { preflight, envFromProcess, report, baseUrlFrom, canonicalHost } from "./preflight.js";
import { QUESTIONS, type Answers } from "./profile.js";
import { checkUrl } from "./urlcheck.js";
import {
  sign,
  verify,
  signAccount,
  verifyAccount,
  looksLikeEmail,
  csrfFor,
  csrfMatches,
} from "./tokens.js";
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
 * The address this site is reachable at — and the only host it will answer on.
 *
 * **Why this exists at all.** Until 2026-08-22 nothing in this file read the
 * base URL, and the magic link below was built from `http://localhost:${PORT}`
 * unconditionally. On a laptop that is correct. The day the site went onto
 * `theusabilitylab.com` it stopped being correct and started being a bearer
 * credential addressed to a machine the recipient does not have — and, once mail
 * is actually sent, one that would arrive over plain http.
 *
 * Both of these come from `preflight.ts`, which owns what the variable means and
 * refuses to boot when it does not parse. Neither throws here: a module-scope
 * constant that throws would kill the process before the preflight could print
 * the sentence explaining which variable is wrong.
 */
const BASE_URL = baseUrlFrom();

/**
 * Host canonicalisation applies only when the operator has claimed a public
 * address, which is `preflight.ts`'s rule exactly: a base URL beginning `https://`
 * **is** that claim. A local run sets nothing, matches nothing, and is untouched.
 *
 * `CANONICAL_HOST` is null when the base URL is unparseable, and the redirect
 * below then does nothing — the preflight has already refused the boot, and
 * bouncing every request at a malformed host would be a worse way to find out.
 */
const ENFORCE_HOST = (process.env.USABILITY_LAB_BASE_URL ?? "").toLowerCase().startsWith("https://");
const CANONICAL_HOST = canonicalHost(BASE_URL);

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

/**
 * The requests this browser has made, so a resubmission can find its own audit.
 *
 * ## Why a cookie and not the URL
 *
 * Four times in one afternoon a visitor could not tell whether anything was
 * happening, went back to the form and submitted the same URL again. Each
 * resubmit minted a new request, orphaned the previous one, and would have
 * spent a second $0.55 on an identical audit.
 *
 * The obvious fix — match on the URL — hands the second person to ask about a
 * popular site the **first person's** request id, and that id is the only
 * credential guarding an audit before the email gate. Their findings are shaped
 * by their answers about their own business. So the match is scoped to the
 * browser that made the request, and a stranger asking about the same URL gets
 * their own audit.
 *
 * ## What this is not
 *
 * Not a credential, and nothing is authorised by it. It holds ids the visitor
 * was already sent to in a `Location` header, and every one of them is checked
 * against the database before it is used — so a forged cookie can at most point
 * at a request that already exists, which its holder could visit anyway.
 * `ul_full` is the cookie that grants something, and the CSRF rule attached to
 * it is untouched here.
 */
const MINE = "ul_mine";
const MINE_KEEP = 5;
const MINE_TTL_SECONDS = 7 * 24 * 60 * 60;
/** Shape only — every id is looked up before it means anything. */
const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function mineIds(req: IncomingMessage): string[] {
  const raw = cookie(req, MINE);
  // Bounded before parsing: the value is attacker-settable and ends up in a
  // loop of database lookups.
  if (!raw || raw.length > (36 + 1) * MINE_KEEP) return [];
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => REQUEST_ID.test(s))
    .slice(0, MINE_KEEP);
}

function remember(req: IncomingMessage, requestId: string): string {
  const ids = [requestId, ...mineIds(req).filter((id) => id !== requestId)].slice(0, MINE_KEEP);
  const secure = process.env.USABILITY_LAB_SECURE_COOKIES === "1" ? "; Secure" : "";
  return `${MINE}=${ids.join(",")}; Path=/; Max-Age=${MINE_TTL_SECONDS}; HttpOnly; SameSite=Lax${secure}`;
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
  sendPage(res, 404, page("Not found", `<p>No audit at this address.</p>`));
}

/**
 * Every non-audit surface goes out through here, and every audit page does not.
 *
 * The split is the rule, made structural. `page()` output needs `font-src` for
 * the self-hosted typeface; `publicHtml()` output must keep the strict policy,
 * because an audit page quotes text captured from a stranger's site. Two
 * functions rather than a remembered argument means the wrong one is a
 * misspelling rather than an omission.
 */
function sendPage(
  res: ServerResponse,
  code: number,
  html: string,
  extra: Record<string, string> = {},
  /**
   * `/start` is the one page here that runs a script, and it passes the policy
   * naming that script by hash. Everything else takes the default, which
   * authorises a font and nothing more.
   */
  csp = MARKETING_CSP,
): void {
  send(res, code, html, "text/html; charset=utf-8", extra, csp);
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
/**
 * Null when no key is set, and then every link is printed instead of sent —
 * see mail.ts. Read once at boot like the Stripe config, so a half-configured
 * process cannot send some mail and print the rest.
 */
const mail = mailConfig();

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
 * Sign-in's own pair, and they are not the question flow's.
 *
 * `/signin` shipped with only the per-address limit, which bounds how often one
 * person can be mailed and not how many people can be. While the link was
 * printed to a terminal that was harmless. With real mail behind it, one script
 * walking a list of addresses mails every customer we have, five times an hour
 * each, for free — a mail-bomb surface built out of a login form.
 *
 * Separate windows from the question flow's so a sign-in flood cannot exhaust
 * the allowance real audit requests need, and vice versa. Same order as B16
 * taught: the global one is peeked first, so the per-client map cannot gain a
 * key until the whole server has spent its budget.
 */
const signinGlobally = new SlidingWindow(100, 60 * MINUTE);
const signinByClient = new SlidingWindow(10, 60 * MINUTE);

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
/**
 * Where an audit stops. Everything else is still moving, including
 * `REVIEW_PENDING` — the work is done there but nothing is published, and that
 * is the state the visitor was in when they resubmitted, so it is exactly the
 * case a second run would waste the most money on.
 */
const FINISHED = new Set<AuditStatus>([
  "PUBLISHED",
  "AUTO_PUBLISHED",
  "CAPTURE_FAILED",
  "PARKED",
  // A declined audit is done with. Matching a new request to it would hand a
  // visitor the progress page of something that will never publish.
  "DECLINED",
  "FAILED",
]);

/**
 * This browser's own unfinished request for `url`, if it has one.
 *
 * A published or failed audit is deliberately not a match: someone who fixed
 * what we found and wants to see whether it worked is asking a new question,
 * and that is the thing the subscription sells.
 */
function inFlightFor(req: IncomingMessage, url: string): string | null {
  for (const id of mineIds(req)) {
    const row = asks.get(id);
    if (!row || row.url !== url) continue;
    if (!row.audit_id) return row.request_id;
    const audit = store.get(row.audit_id);
    if (audit && !FINISHED.has(audit.status)) return row.request_id;
  }
  return null;
}

interface Status {
  html: string;
  /** Seconds until the page should fetch itself again, or null when this is the end. */
  refresh: number | null;
}

/**
 * The one moving thing on this page, and the argument for keeping it small.
 *
 * A visitor asked for "a loader animation to show the system is working", and
 * they were right that the page gave no sign of life. But the comment above
 * `statusPage` already had the other half: "a spinner that never resolves is
 * the version of this page that lies." So this is not decoration shown
 * whenever the page is unfinished — it marks machine work actually in flight,
 * and it is absent in the queue and at the founder gate, where the honest
 * report is that nothing is running and a person has it.
 *
 * `prefers-reduced-motion` stops it rather than hiding it: the dot still marks
 * the running step, it just stops breathing.
 */
const WORKING_CSS = `
  .pulse { display:inline-block; width:7px; height:7px; border-radius:50%;
           background:var(--ink-soft); margin-right:9px; vertical-align:middle;
           animation:breathe 2.4s ease-in-out infinite; }
  @keyframes breathe { 0%,100% { opacity:.18; } 50% { opacity:1; } }
  @media (prefers-reduced-motion:reduce) {
    .pulse { animation:none; opacity:.55; }
  }
`;

/**
 * How often a page in each state comes back, in seconds.
 *
 * Paced to what the state can actually change on, not to look busy. The gap
 * between a claim and the subprocess starting is seconds; a step is tens of
 * seconds; the founder gate is a person, and might be tomorrow.
 */
const REFRESH = { queued: 30, starting: 5, running: 10, review: 60 } as const;

/** Machine states in a customer's words. Anything unlisted reads "In progress". */
const ACCOUNT_STATE: Record<string, string> = {
  PUBLISHED: "Ready",
  AUTO_PUBLISHED: "Ready",
  REVIEW_PENDING: "Being checked",
  DECLINED: "Not published",
  FAILED: "Did not finish",
  CAPTURE_FAILED: "Could not load the page",
  PARKED: "Could not load the page",
};

/**
 * The road ahead, because the page has never shown one.
 *
 * Every state here says what is happening now and none of them said what the
 * *sequence* is, so "In the queue" read as either one step from done or one of
 * six, with nothing on the page to tell them apart. The first visitor to see it
 * without knowing the answer in advance asked whether it had stalled.
 *
 * Four stages, because four is what actually happens. "A person reads it" is
 * listed rather than hidden: it is the slowest stage, it is the one nobody
 * expects, and a wait that has been named reads differently from one that has
 * not.
 */
/**
 * The human stage is shown only to audits that actually have one.
 *
 * Since 2026-08-24 an audit publishes itself unless `claims.ts` disputes a
 * finding, so most requests never see a person at all. Listing "A person checks
 * it" for everyone would describe a stage that ~96% of them skip — the same
 * class of untruth as the refresh this page promised for its whole life and
 * never performed, and this file has been rewritten once already for it.
 */
function stagesFor(reviewed: boolean): readonly string[] {
  return reviewed
    ? ["In the queue", "Auditing your page", "A person checks it", "Published"]
    : ["In the queue", "Auditing your page", "Published"];
}

const STAGES_CSS = `
  .road { list-style:none; margin:22px 0 26px; padding:0; }
  .road li { position:relative; padding:0 0 0 26px; margin:0 0 9px;
             font-size:15px; color:var(--shade); }
  .road li::before { content:""; position:absolute; left:0; top:.52em;
                     width:8px; height:8px; border-radius:50%;
                     background:var(--sand); }
  .road .done { color:var(--ink-soft); }
  .road .done::before { background:var(--ink-soft); }
  .road .now { color:var(--ink); font-weight:500; }
  .road .now::before { background:var(--ink); }
  .road .stopped { color:var(--ink); }
  .road .stopped::before { background:#8C3A22; }
`;

/**
 * @param current which stage the request is in, as an index into STAGES.
 * @param stopped the sequence ended here — a failure, or a decision not to
 * publish. Everything after `current` is dropped rather than greyed out,
 * because listing "Published" under an audit that never will be is the kind of
 * decorated untruth this page keeps being rewritten to remove.
 */
function roadAhead(current: number, stopped = false, reviewed = false): string {
  const stages = stagesFor(reviewed);
  const shown = stopped ? stages.slice(0, current + 1) : stages;
  const items = shown.map((label, i) => {
    const cls = i < current ? "done" : i === current ? (stopped ? "stopped" : "now") : "";
    return `<li class="${cls}">${label}</li>`;
  });
  return `<ol class="road">${items.join("")}</ol>`;
}


/**
 * What is happening *now*, keyed on the last step that finished.
 *
 * ## Why "finished" and not "running"
 *
 * `timed()` records `step.<name>` after the work returns, so the newest event
 * is the thing that just ended and the sentence has to be about what follows
 * it. Read the other way round this page would tell someone we were capturing
 * their site at the exact moment we stopped.
 *
 * ## Why a map and not an ordered list
 *
 * The pipeline skips steps. `profile` only runs when the visitor answered at
 * least one question, and the first audit ever submitted through the web flow
 * skipped it — so "the next entry in the sequence" would have named the wrong
 * step on the very first real run. Keying on what finished is correct whatever
 * was skipped before it.
 *
 * An unfamiliar name falls through to `STILL_WORKING`, so a step renamed in
 * index.ts costs this page its detail and never its honesty.
 */
const NOW_DOING: Record<string, string> = {
  capture: `Deciding which reviewers your page needs.`,
  profile: `Deciding which reviewers your page needs.`,
  orchestrate: `Reviewers are reading your page now. This is the long part.`,
  review: `Bringing what the reviewers found into one account.`,
  synthesize: `Checking each finding against the research.`,
  research: `Last checks before a person reads it.`,
  lint: `Last checks before a person reads it.`,
  annotate: `Marking the screenshot up.`,
  render: `Putting your results page together.`,
};

/** Before any step has finished, the browser is still opening the page. */
const OPENING = `Opening your page in a real browser.`;
const STILL_WORKING = `Your team is on it.`;

/**
 * Where this request sits in the line, and who is going to start it.
 *
 * ## Why the wait is not a duration
 *
 * `npm run audit -- --queue` is a person deciding to spend money — "no HTTP
 * request may spend money" is why the form writes a row and stops. So there is
 * nothing on the hook for a turnaround, and a page saying "about eight minutes"
 * would be quoting the audit's *runtime* as though it were the wait. That is
 * the same class of untruth as the refresh this page promised for its whole
 * life and never performed.
 *
 * The position is real, read from the same ordering the runner takes them in.
 */
function queued(requestId: string): string {
  const line = asks.queue();
  const ahead = line.findIndex((r) => r.request_id === requestId);

  // -1 means it was claimed between the row read and this call. The next
  // refresh will say so; claiming it is strictly forward progress.
  const place =
    ahead <= 0
      ? `In the queue, and yours is next.`
      : `In the queue, with ${ahead} ahead of it. We take them in the order they arrive.`;

  return (
    `${place} A person starts each audit by hand, so it does not begin the moment ` +
    `you ask &mdash; but this page moves on its own when it does.`
  );
}

function whatIsHappening(auditId: string): string {
  const steps = events.all(auditId).filter((e) => e.type.startsWith("step."));
  const last = steps[steps.length - 1];
  if (!last) return OPENING;
  return NOW_DOING[last.type.slice("step.".length)] ?? STILL_WORKING;
}

function statusPage(row: AuditRequestRow): Status {
  const audit = row.audit_id ? store.get(row.audit_id) : null;
  const site = escapeHtml(row.url);

  /**
   * One place decides both, and that is the point.
   *
   * The promise "It updates as we go" is derived from `refresh` rather than
   * written alongside it, because for its whole life this page carried that
   * sentence while being a single static render — true of the design, false of
   * the code, and invisible to anyone reading either one on its own. A visitor
   * watched it for fourteen minutes and then submitted the same URL again.
   * Making the copy a function of the behaviour is what stops that recurring:
   * there is no longer a version of this file where one moves without the other.
   */
  const at = (
    refresh: number | null,
    state: string,
    stage: { at: number; stopped?: boolean; reviewed?: boolean },
    extra = "",
  ): Status => {
    /**
     * The fast cadences are exactly the states where a step is running, so the
     * dot is derived from the refresh interval rather than passed in beside it
     * — the same reason the "updates as we go" sentence is. Queued (30s) and
     * the founder gate (60s) refresh without anything of ours working.
     */
    const working = refresh === REFRESH.running || refresh === REFRESH.starting;
    return {
      refresh,
      html: page(
        "Your audit",
        `<p class="lead">${site}</p>
         <p>${working ? `<span class="pulse"></span>` : ""}${state}</p>${extra}
         ${roadAhead(stage.at, stage.stopped, stage.reviewed)}
         <p class="hint">This page is yours &mdash; keep the address.${
           // "As we go" described work; this describes the page. A motionless
           // render is ambiguous between waiting and broken, and the thing
           // that resolves it is knowing the page is doing the checking.
           //
           // Deliberately without the interval. The first version said "every
           // 30 seconds" and `server.test.ts` refused it: any duration on the
           // queued page reads as a turnaround, and nobody is on the hook for
           // one. The number was for the page; a reader would take it for the
           // wait.
           refresh === null ? "" : " It updates on its own &mdash; nothing to reload."
         }</p>`,
        STAGES_CSS + (working ? WORKING_CSS : ""),
      ),
    };
  };

  if (!row.audit_id) return at(REFRESH.queued, queued(row.request_id), { at: 0 });
  if (!audit) return at(REFRESH.starting, `Starting now.`, { at: 1 });

  switch (audit.status) {
    case "PUBLISHED":
    case "AUTO_PUBLISHED":
      return at(
        null,
        `Ready.`,
        // Two different roads, and the row records which one this took: a
        // person published PUBLISHED, and nothing disputed AUTO_PUBLISHED.
        audit.status === "PUBLISHED" ? { at: 3, reviewed: true } : { at: 2 },
        `<p><a href="/a/${escapeHtml(audit.audit_id)}/">Read the results</a></p>`,
      );
    case "REVIEW_PENDING":
      return at(
        REFRESH.review,
        `The audit is done and a person is reading it before it goes out. ` +
          `That is the slowest part and the reason we stand behind what it says.`,
        { at: 2, reviewed: true },
      );
    case "CAPTURE_FAILED":
    case "PARKED":
      // F1, said out loud. Terminal for this request: a retry is a new one.
      return at(
        null,
        `We could not load that page well enough to audit it &mdash; some sites block ` +
          `automated browsers, and some need a login we will not go past. Nothing was ` +
          `published and nothing was charged.`,
        { at: 1, stopped: true },
        `<p><a href="/">Try a different page</a></p>`,
      );
    case "FAILED":
      return at(
        null,
        `This one broke on our side. It has been logged and nothing half-finished was ` +
          `published, which is the part we care about most.`,
        { at: 1, stopped: true },
        `<p><a href="/">Start another</a></p>`,
      );
    case "DECLINED":
      /**
       * The audit ran and we chose not to publish it — the founder gate's
       * second exit, added 2026-08-23.
       *
       * Without this case DECLINED fell to `default:`, which tells the visitor
       * reviewers are still working and refreshes every few seconds against a
       * state that is terminal. A decision presented as a hang.
       *
       * It says the choice was ours. A page that reads "we decided not to
       * publish this" invites "why?"; a page that implies the site was the
       * problem is worse, because it is not true and cannot be argued with.
       */
      return at(
        null,
        `We looked at this one and decided not to publish it. That is a call on our ` +
          `side rather than anything wrong with the page &mdash; nothing was published ` +
          `and nothing was charged.`,
        // Stopped at the gate, not before it: a person did read this one.
        { at: 2, stopped: true, reviewed: true },
        `<p><a href="/">Audit a different page</a></p>`,
      );
    default:
      // Was one fixed sentence for every live state, which claimed reviewers
      // were on the page during the seconds when the only thing running was a
      // headless browser opening the URL.
      return at(REFRESH.running, whatIsHappening(audit.audit_id), { at: 1 });
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
    decidedBy: loaded.decidedBy,
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
  /**
   * HSTS — set here rather than in `send()` so that it reaches **every**
   * response: the 404s, the 403s, and the host redirect below, none of which go
   * through the page helpers. `setHeader` before any `writeHead` survives,
   * because nothing downstream names this header.
   *
   * Only when the operator has claimed https, which is `preflight.ts`'s rule
   * again. A browser ignores this header over plain http anyway, so gating it is
   * about not writing something misleading into a local response rather than
   * about safety.
   *
   * A year, and `includeSubDomains` because `www` is the only subdomain and it
   * is served over the same tunnel. **No `preload`**: that is a submission to a
   * list baked into browser binaries, and it is materially hard to undo.
   *
   * This is defence in depth, not a hole being closed — the tunnel serves https
   * only. It matters because the product mails a bearer credential inside a URL,
   * and the one request HSTS protects is the first one, before any of our
   * headers have ever been seen.
   */
  if (ENFORCE_HOST) {
    res.setHeader("strict-transport-security", "max-age=31536000; includeSubDomains");
  }

  // --- one host, one site --------------------------------------------------
  /**
   * The tunnel routes `www.theusabilitylab.com` here too, and without this the
   * app would answer on both. Two hostnames serving one site is not a cosmetic
   * problem: `ul_full` is scoped to the host that set it, so a visitor who signs
   * in on `www` and then follows a magic link — which is built from `BASE_URL`,
   * always the apex — arrives without the cookie they just earned.
   *
   * **The redirect target is `BASE_URL`, never `req.headers.host`.** The Host
   * header is attacker-controlled; echoing it back in a `Location` is an open
   * redirect. Here it is only ever compared, never repeated.
   */
  if (
    ENFORCE_HOST &&
    CANONICAL_HOST !== null &&
    (req.headers.host ?? "").toLowerCase() !== CANONICAL_HOST
  ) {
    /**
     * 308 and not 301, for every method alike.
     *
     * The two say the same thing about permanence, and search engines treat them
     * the same for canonicalisation. They differ in one place: a 301 permits the
     * client to rewrite the method to GET, so a misaddressed POST arrives as a
     * GET and its body is gone. That is not a redirect, it is a silent drop, and
     * F21 is what a silently dropped webhook is called here.
     *
     * This started as a conditional — 301 for GET, 308 otherwise — which was a
     * branch written for a case that cannot currently occur, since Stripe is
     * configured on the canonical host. One status is correct for both.
     */
    res.writeHead(308, { location: `${BASE_URL}${req.url ?? "/"}` });
    return void res.end();
  }

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

  // --- the marketing page --------------------------------------------------
  /**
   * A view, and only a view. This used to be the form, and the event recorded
   * here used to be `question.started` — which the funnel prints as "form
   * opened". Leaving that name on this route would have kept the number
   * printing while it counted a different thing, and the ratio between it and
   * `question.completed` — the form's completion rate — would quietly have
   * become a whole-site conversion rate.
   */
  if (url.pathname === "/") {
    events.record({ audit_id: null, type: "home.viewed", data: {} });
    return sendPage(res, 200, homePage(), {}, HOME_CSP);
  }

  // --- the question flow ---------------------------------------------------
  /**
   * `question.started` keeps its name here because it keeps its meaning: the
   * form was opened. Only the address changed, so the series spans the
   * redesign and stays comparable to every row recorded before it.
   */
  if (url.pathname === "/start") {
    events.record({ audit_id: null, type: "question.started", data: {} });
    return sendPage(res, 200, questionsPage(), {}, STEPPED_CSP);
  }

  /**
   * Sign in, and the dashboard behind it — the way back to an account.
   *
   * Every credential this file issued before today opened exactly one audit,
   * which meant a subscriber who lost the email lost the product. These two
   * routes are the smallest thing that fixes that without weakening the rest:
   * the account token opens **an index and nothing else**, and each row still
   * links through a per-audit token minted here. A leaked account token
   * discloses which pages someone audited; it cannot read one.
   */
  if (url.pathname === "/signin") {
    if (req.method === "GET") return sendPage(res, 200, signInPage(), {}, MARKETING_CSP);
    if (req.method !== "POST") return notFound(res);

    const body = await readBody(req);
    if (body === null) {
      return sendPage(res, 413, signInPage({ error: "That was too long." }), {}, MARKETING_CSP);
    }
    const email = (new URLSearchParams(body).get("email") ?? "").trim().toLowerCase();
    if (!looksLikeEmail(email)) {
      return sendPage(
        res,
        400,
        signInPage({ error: "That does not look like an email address." }),
        {},
        MARKETING_CSP,
      );
    }

    /**
     * Spent before the lookup, and the answer is the same either way.
     *
     * Rate limiting after a "do we know this address" check would make the
     * limiter itself the oracle — a stranger would learn who our customers are
     * from which submissions are throttled. And the page below says the same
     * sentence whether or not anything was sent, so the form cannot be used to
     * enumerate customers at any speed.
     */
    const now = Date.now();
    const client = clientIp(req);
    const overall = signinGlobally.peek("all", now);
    const mine = overall.allowed ? signinByClient.hit(client, now) : { allowed: false };
    if (overall.allowed) signinGlobally.hit("all", now);

    const allowed = overall.allowed && mine.allowed && byEmail.hit(`signin|${email}`, now).allowed;

    if (allowed && captures.auditsFor(email).length > 0) {
      const link = `${BASE_URL}/account?t=${signAccount(email)}`;
      void deliver(
        {
          to: email,
          subject: "Your audits",
          text: `Here are your audits:\n\n${link}\n\nThe link opens them and expires.`,
        },
        mail,
      );
      events.record({ audit_id: null, type: "signin.requested", data: {} });
    }

    return sendPage(res, 200, signInPage({ sent: email }), {}, MARKETING_CSP);
  }

  if (url.pathname === "/account") {
    const token = url.searchParams.get("t") ?? "";
    const check = verifyAccount(token);
    if (!check.ok) {
      // No detail. "Expired" and "forged" look identical to a stranger, and the
      // person who owns the address gets the same next step either way.
      return sendPage(
        res,
        401,
        signInPage({ error: "That link is not valid any more. Ask for a new one." }),
        {},
        MARKETING_CSP,
      );
    }

    // The address comes from the verified token and never from the request.
    // This is the whole of the cross-customer rule, in one line.
    const email = check.email;
    const rows = captures.auditsFor(email).map((r) => {
      const ready = r.status === "PUBLISHED" || r.status === "AUTO_PUBLISHED";
      return {
        url: r.url,
        when: r.created_at.slice(0, 10),
        state: ACCOUNT_STATE[r.status] ?? "In progress",
        // A per-audit token, minted per row. The account token is not accepted
        // by `verify`, so this is the only thing that opens an audit.
        href: ready ? `/a/${r.audit_id}/full?t=${sign(r.audit_id, email)}` : null,
      };
    });

    events.record({ audit_id: null, type: "account.viewed", data: {} });
    return sendPage(
      res,
      200,
      accountPage(email, rows, subs.isActive(email)),
      { "cache-control": "no-store" },
      MARKETING_CSP,
    );
  }

  if (url.pathname === "/request") {
    if (req.method !== "POST") return notFound(res);

    const body = await readBody(req, MAX_REQUEST_BODY);
    if (body === null) {
      return sendPage(
        res,
        413,
        questionsPage({ error: "That was more than we can take in one go." }),
        {},
        STEPPED_CSP,
      );
    }
    const form = new URLSearchParams(body);
    const answers: Answers = {};
    for (const [i, q] of QUESTIONS.entries()) {
      const value = (form.get(`q${i}`) ?? "").trim();
      if (value) answers[q] = value;
    }
    const typed = (form.get("url") ?? "").trim();
    /**
     * Re-render the whole flow with what they typed still in it.
     *
     * `errorStep` decides which step the stepper opens on. A refused URL belongs
     * on step 0; an over-long answer belongs on the step holding that answer,
     * because showing someone the URL field under an error about question four
     * is worse than not helping at all.
     */
    const again = (error: string, code = 400, errorStep = 0) =>
      sendPage(res, code, questionsPage({ url: typed, answers, error, errorStep }), {}, STEPPED_CSP);

    // Which one, not whether — so the flow can reopen on the answer at fault.
    // Step 0 is the URL, so question `i` is step `i + 1`.
    const tooLong = QUESTIONS.findIndex((q) => (answers[q]?.length ?? 0) > MAX_ANSWER);
    if (tooLong >= 0) {
      return again(
        `One of those answers is longer than ${MAX_ANSWER} characters. A sentence or two is plenty.`,
        400,
        tooLong + 1,
      );
    }

    const now = Date.now();
    /**
     * Not the socket address directly — see clientip.ts. Behind a TLS
     * terminator every request arrives from the proxy, and this limit would
     * become five audits an hour for the entire internet.
     */
    const client = clientIp(req);

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

    /**
     * Already asked, and still running — send them to it rather than starting
     * a second one. Checked after the URL is normalised, so the match is on
     * what we would actually capture rather than on what was typed, and before
     * the global allowance is spent, because this costs nothing.
     */
    const already = inFlightFor(req, verdict.url);
    if (already) {
      events.record({ audit_id: null, type: "question.deduped", data: {} });
      res.writeHead(303, { location: `/r/${already}`, "set-cookie": remember(req, already) });
      return void res.end();
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

    // 303, so a refresh of the status page is not a resubmission. The cookie is
    // what makes the *next* submission of this URL find this request.
    res.writeHead(303, {
      location: `/r/${requestId}`,
      "set-cookie": remember(req, requestId),
    });
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
      /**
       * B22. Applied in Stripe's order, not the socket's.
       *
       * Stripe retries and reorders delivery, so an `updated` delayed behind a
       * `deleted` arrives after it — and the write used to be last-writer-wins,
       * which handed a cancelled customer their access back until the next
       * reconciliation noticed. The failure direction is free access, which
       * nobody reports.
       */
      const applied = subs.upsert(
        email,
        {
          status,
          stripeCustomerId: sub.customerId || null,
          stripeSubscriptionId: sub.id || null,
          currentPeriodEnd: status === "canceled" ? null : sub.currentPeriodEnd,
        },
        { eventAt: check.event.created },
      );

      if (!applied) {
        // 200, because delivery succeeded — we chose not to apply it, and a
        // non-200 would have Stripe redeliver this same stale event forever.
        // Recorded rather than dropped: a write that silently does nothing is
        // the shape B27 is about.
        events.record({
          audit_id: null,
          type: "webhook.stale",
          data: { type: check.event.type, created: check.event.created ?? null },
        });
        return send(res, 200, "stale", "text/plain; charset=utf-8");
      }

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
    const status = statusPage(row);
    return sendPage(res, 200, status.html, {
      // A page whose entire job is to change must never be served from a cache.
      "cache-control": "no-store",
      ...(status.refresh === null ? {} : { refresh: String(status.refresh) }),
    });
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

    const link = `${BASE_URL}/a/${audit.audit_id}/full?t=${sign(audit.audit_id, email)}`;

    /**
     * The send this comment used to describe as missing. It is not awaited:
     * the visitor has already been told a link is coming, and holding the
     * response open for a third party's API would make our page as slow as
     * their worst day. A failure is logged by `deliver` and the link is not
     * reissued — the cooldown above already refuses that.
     */
    void deliver(
      {
        to: email,
        subject: "Your full audit",
        text: `Your full audit is here:\n\n${link}\n\nThe link opens it and expires.`,
      },
      mail,
    );

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
      return sendPage(
        res,
        403,
        page(
          "Not this page",
          `<p>${explain[check.reason]}</p>
           <p><a href="/a/${audit.audit_id}">Ask for a new one</a>.</p>`,
        ),
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
      return sendPage(
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
    if (body === null) return sendPage(res, 413, page("Too long", `<p>That request was too large.</p>`));
    if (!csrfMatches(token, new URLSearchParams(body).get("csrf") ?? "")) {
      events.record({ audit_id: audit.audit_id, type: "csrf.rejected", data: { route: "subscribe" } });
      return sendPage(
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
      return sendPage(
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
      return sendPage(
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
    if (body === null) return sendPage(res, 413, page("Too long", `<p>That request was too large.</p>`));

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
      return sendPage(
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
    sendPage(res, 500, page("Something broke", `<p>That is ours, not yours. It has been logged.</p>`));
  });
});

/**
 * Checked before the socket opens, so a refusal is not a server that briefly
 * served real traffic with the wrong headers and then quit.
 */
const checks = preflight(envFromProcess());
if (!checks.ok) {
  console.error(report(checks));
  process.exit(2);
}

/**
 * `listen(PORT)` alone accepts connections on every interface, which is right
 * on a laptop and wrong behind a tunnel: the app would also answer on the LAN,
 * on plain http, with the Secure cookie flag set and therefore no cookie at all.
 * `USABILITY_LAB_BIND=127.0.0.1` makes the proxy the only way in. Default
 * unchanged, because changing it would break every existing local setup.
 */
const BIND = process.env.USABILITY_LAB_BIND;

server.listen(...((BIND ? [PORT, BIND] : [PORT]) as [number, string?]), () => {
  const ready = store.list("PUBLISHED").length + store.list("AUTO_PUBLISHED").length;
  console.log(
    `\n  The Usability Lab — http://${BIND ?? "localhost"}:${PORT}\n` +
      report(checks) + `\n` +
      `  bound to       ${BIND ?? "every interface"}\n` +
      `  ${ready} audit${ready === 1 ? "" : "s"} reachable. Links are printed by \`npm run review\`.\n` +
      mail
        ? `  Mail is on: links are sent, not printed.\n`
        : `  Magic links print here; no email is sent.\n`,
  );
});
