/**
 * `npm run mail:check` — the same idea as `stripe:check`, for the other thing
 * that fails silently.
 *
 * ## Why mail needs a preflight at all
 *
 * A magic link is the only way into a paid account. If it does not arrive there
 * is no error anywhere: Resend accepts the send and returns an id, the server
 * logs a success, the queue is empty, and the customer sits looking at "check
 * your email". **Every part of this system reports that it worked.** The
 * failure is entirely on the receiving side, in a spam folder nobody here can
 * see.
 *
 * ## The failure it guards, which is not the one it was written for
 *
 * The first draft of this file was built around an ordering trap: move
 * `USABILITY_LAB_MAIL_FROM` to this domain before the DNS exists, and the
 * domain's inherited `p=quarantine` would tell every receiver to junk its own
 * magic links. Plausible, and wrong. Measured on 2026-08-25 by sending one
 * request with an unverified From:
 *
 *     403  The theusabilitylab.com domain is not verified.
 *          Please, add and verify your domain on https://resend.com/domains
 *
 * Resend refuses outright, so that mistake is loud and cannot reach a customer.
 * Good news, and it cost one API call to find out instead of an argument.
 *
 * **What is actually silent is drift the other way.** Verification is a check
 * Resend performs once. Once a domain is verified, sends are accepted — so
 * records pruned out of Cloudflare months later, or a zone rebuilt without
 * them, leave mail going out unsigned against a published `p=quarantine`. Then
 * every part of this system reports success: Resend accepts the send and
 * returns an id, the server logs it, the queue empties, and the customer sits
 * looking at "check your email" while their link is in a spam folder nobody
 * here can see.
 *
 * That is the state this exists to notice, and nothing else would.
 *
 * ## What DMARC actually requires
 *
 * One of SPF or DKIM, aligned — not both. This file checked for both and called
 * the result alignment, which would have reported a correctly-delivering domain
 * as broken. Both are still worth having and both are still reported; only the
 * DMARC verdict takes the looser, correct reading.
 *
 * ## Why the checks are separate from the printing
 *
 * `preflight` takes records and returns results, so every interesting case — a
 * From that outruns the DNS, a DKIM key that never got added, a DMARC policy
 * pointed at somebody else's mailbox — is testable without touching DNS or
 * sending anything. Same split, and the same reason, as `stripe-check.ts`.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTxt, resolveMx } from "node:dns/promises";
import { DEFAULT_FROM } from "./mail.js";
import type { Check } from "./stripe-check.js";

/**
 * Resend's own selector. Their setup flow publishes the DKIM public key at
 * `resend._domainkey.<domain>`; the key itself is generated per domain, which
 * is why this file can check that one exists but can never generate one.
 */
export const DKIM_SELECTOR = "resend._domainkey";

/**
 * Resend sends with a return-path inside a subdomain, so SPF and the bounce MX
 * belong on `send.<domain>` rather than the apex. This is the part people get
 * wrong by putting `v=spf1 include:amazonses.com` on the apex, where it
 * authorises nothing that Resend actually uses and quietly collides with
 * whatever else the apex is doing.
 */
export const SEND_SUBDOMAIN = "send";

export interface MailDns {
  /** TXT at `send.<domain>` — where the SPF record belongs. */
  sendTxt: string[];
  /** TXT at `resend._domainkey.<domain>`. */
  dkimTxt: string[];
  /** TXT at `_dmarc.<domain>`. */
  dmarcTxt: string[];
  /** MX at `send.<domain>`, for bounce and complaint feedback. */
  sendMx: { exchange: string; priority: number }[];
}

/** The domain part of an address, lowercased. Null if it is not an address. */
export function domainOf(from: string): string | null {
  // `Name <user@host>` is a legal From, and the bare form is what .env holds.
  const addr = from.includes("<") ? (from.match(/<([^>]*)>/)?.[1] ?? "") : from;
  const at = addr.lastIndexOf("@");
  return at > 0 && at < addr.length - 1 ? addr.slice(at + 1).trim().toLowerCase() : null;
}

/** `v=DMARC1; p=quarantine; ...` parsed far enough to reason about. */
export function dmarcPolicy(txt: string[]): { p: string; rua: string | null } | null {
  const rec = txt.find((t) => /^v=DMARC1\b/i.test(t.trim()));
  if (!rec) return null;
  const tag = (name: string) =>
    rec.match(new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*([^;]+)`, "i"))?.[1]?.trim() ?? null;
  return { p: (tag("p") ?? "none").toLowerCase(), rua: tag("rua") };
}

export function preflight(input: {
  /** `USABILITY_LAB_MAIL_FROM`, or the default when it is unset. */
  from: string;
  /** The domain we intend to send as — the site's own, not Resend's. */
  domain: string;
  dns: MailDns;
}): Check[] {
  const { from, domain, dns } = input;
  const checks: Check[] = [];

  const fromDomain = domainOf(from);
  const sendingAsUs = fromDomain === domain;

  const spf = dns.sendTxt.find((t) => /^v=spf1\b/i.test(t.trim())) ?? null;
  const spfAuthorises = spf !== null && /include:amazonses\.com/i.test(spf);
  const dkim = dns.dkimTxt.find((t) => /\bp=/.test(t)) ?? null;
  const dmarc = dmarcPolicy(dns.dmarcTxt);
  const enforcing = dmarc !== null && dmarc.p !== "none";

  checks.push({
    name: "from address",
    // `warn` pairs with `ok: false` here, as it does in stripe-check.ts — it
    // downgrades a failure rather than annotating a success. The first draft
    // set `ok: true` alongside a detail explaining what was wrong with it, and
    // a line that says "ok" next to its own bad news is the kind of thing this
    // product files bugs about on other people's sites.
    ok: sendingAsUs,
    warn: !sendingAsUs,
    detail: sendingAsUs
      ? `${from} — this domain, so SPF, DKIM and DMARC below all apply.`
      : `${from} — not ${domain}. Mail authenticates as ${fromDomain ?? "an unparseable address"}, ` +
        `so nothing below is in force yet and only addresses you own will receive it.`,
  });

  checks.push({
    name: `SPF on ${SEND_SUBDOMAIN}.${domain}`,
    ok: spfAuthorises,
    // A warning while the From is elsewhere: nothing is broken for anyone today,
    // it is simply not built yet. It becomes a refusal the moment it matters.
    warn: !spfAuthorises && !sendingAsUs,
    detail: spfAuthorises
      ? `authorises amazonses.com.`
      : spf
        ? `present but does not include amazonses.com: ${spf}`
        : `missing. Resend's SPF belongs on the ${SEND_SUBDOMAIN} subdomain, not the apex.`,
  });

  checks.push({
    name: `DKIM at ${DKIM_SELECTOR}`,
    ok: dkim !== null,
    warn: dkim === null && !sendingAsUs,
    detail:
      dkim !== null
        ? `a public key is published.`
        : `missing. The key is generated per domain — copy it out of Resend, it cannot be derived.`,
  });

  checks.push({
    name: `bounce MX on ${SEND_SUBDOMAIN}.${domain}`,
    ok: dns.sendMx.length > 0,
    // Never a refusal. Mail authenticates without it; what is lost is Resend
    // hearing about bounces and complaints, which costs reputation slowly
    // rather than costing this customer their link today.
    warn: true,
    detail:
      dns.sendMx.length > 0
        ? `${dns.sendMx.map((m) => m.exchange).join(", ")}`
        : `missing. Bounces and complaints will not reach Resend; sender reputation decays quietly.`,
  });

  /*
   * The one this file exists for.
   *
   * A quarantine policy with neither SPF nor DKIM is not a neutral state, it is
   * an instruction to receivers to treat this domain's mail as suspect. Today
   * it is harmless because the From is somebody else's domain and Resend would
   * refuse to send as ours anyway.
   *
   * It stops being harmless if a verified domain loses its records — Resend
   * goes on accepting the sends, and this is the only thing that would say so.
   */
  // DMARC passes on SPF *or* DKIM, aligned — not both. Written as `&&` first,
  // which would have called a domain delivering perfectly well on DKIM alone a
  // failure. Both records are still checked and reported above; this is only
  // the question DMARC itself asks.
  const aligned = spfAuthorises || dkim !== null;
  checks.push({
    name: "DMARC",
    ok: !(sendingAsUs && enforcing && !aligned),
    warn: !enforcing && sendingAsUs,
    detail: !dmarc
      ? `no policy published.`
      : sendingAsUs && enforcing && !aligned
        ? `p=${dmarc.p} with ${!spfAuthorises ? "no SPF" : "SPF"} and ${dkim ? "DKIM" : "no DKIM"}. ` +
          `This domain is telling receivers to quarantine its own mail, and Resend is still ` +
          `accepting the sends. Check the records against resend.com/domains.`
        : enforcing && !aligned
          ? // The state the domain is in today, and the reason this file exists.
            // Reported while it is still harmless, because the moment it stops
            // being harmless is the moment nobody can tell.
            `p=${dmarc.p}, with neither SPF nor DKIM in place. Harmless while the From is ` +
            `elsewhere; Resend refuses to send as an unverified domain (403), so this cannot ` +
            `reach a customer by accident.`
          : `p=${dmarc.p}${aligned ? ", and both SPF and DKIM are in place." : "."}`,
  });

  if (dmarc?.rua) {
    checks.push({
      name: "DMARC reports",
      ok: dmarc.rua.includes(domain),
      warn: !dmarc.rua.includes(domain),
      detail: dmarc.rua.includes(domain)
        ? `${dmarc.rua}`
        : `${dmarc.rua} — an address nobody here reads. Failure reports about this ` +
          `domain's mail are being sent somewhere else.`,
    });
  }

  return checks;
}

/** TXT records arrive as arrays of chunks; a long DKIM key is split across them. */
async function txt(name: string): Promise<string[]> {
  try {
    return (await resolveTxt(name)).map((chunks) => chunks.join(""));
  } catch {
    // NXDOMAIN and "no records" are the same answer to the only question here.
    return [];
  }
}

async function mx(name: string): Promise<{ exchange: string; priority: number }[]> {
  try {
    return await resolveMx(name);
  } catch {
    return [];
  }
}

export async function lookup(domain: string): Promise<MailDns> {
  const [sendTxt, dkimTxt, dmarcTxt, sendMx] = await Promise.all([
    txt(`${SEND_SUBDOMAIN}.${domain}`),
    txt(`${DKIM_SELECTOR}.${domain}`),
    txt(`_dmarc.${domain}`),
    mx(`${SEND_SUBDOMAIN}.${domain}`),
  ]);
  return { sendTxt, dkimTxt, dmarcTxt, sendMx };
}

/**
 * The domain this product is. Taken from the base URL rather than typed, so a
 * deployment somewhere else checks its own DNS instead of ours.
 */
export function siteDomain(baseUrl: string): string | null {
  try {
    return new URL(baseUrl).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const from = (process.env.USABILITY_LAB_MAIL_FROM ?? "").trim() || DEFAULT_FROM;
  const domain = siteDomain(process.env.USABILITY_LAB_BASE_URL ?? "");

  if (!domain) {
    console.error(
      `\nUSABILITY_LAB_BASE_URL is not set to a URL, so there is no domain to check.\n` +
        `  This check is about the domain mail is sent *as*, which is the site's own.\n`,
    );
    process.exit(2);
  }

  console.log(`\nmail:check — ${domain}\n`);
  const checks = preflight({ from, domain, dns: await lookup(domain) });

  // Same three states, and the same order of tests, as stripe-check.ts. Written
  // the other way round first, which printed every not-yet-built record as FAIL
  // and then told the operator mail "would be quarantined" while it was going
  // out over resend.dev and arriving fine. A preflight that cries wolf about
  // the state you are actually in is one that gets ignored on the day it is
  // right.
  const width = Math.max(...checks.map((c) => c.name.length)) + 2;
  for (const c of checks) {
    const mark = c.ok ? "ok  " : c.warn ? "warn" : "FAIL";
    console.log(`  ${mark}  ${c.name.padEnd(width)} ${c.detail}`);
  }

  const failed = checks.filter((c) => !c.ok && !c.warn);
  const pending = checks.filter((c) => !c.ok && c.warn);
  console.log(
    failed.length > 0
      ? `\n  ${failed.length} blocking problem(s). Mail would be sent, accepted, and quarantined.\n`
      : pending.length > 0
        ? // Deliberately no count. An earlier version said "3 record(s) still to
          // add" while one of the three was the From address, which is not a
          // record — a summary line that miscounts its own list is worse than
          // one that points at the list.
          `\n  Nothing blocking, because nothing is in force yet: mail goes out as\n` +
          `  ${from}. Add what is marked warn above, then move\n` +
          `  USABILITY_LAB_MAIL_FROM to this domain — last, and not before.\n`
        : `\n  Nothing blocking. This does not prove a message arrives — only a real\n` +
          `  send to an address outside this account does that, and the headers on it\n` +
          `  are the evidence: Authentication-Results should say dkim=pass and spf=pass.\n`,
  );
  process.exit(failed.length === 0 ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
