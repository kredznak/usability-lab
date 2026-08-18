/**
 * §6's fair-use cap: **3 sites, 10 audits/mo**.
 *
 * ## Why this is a spend control and not a policy line
 *
 * §11 leans on these two numbers to claim worst-case subscriber cost is
 * "structural, same argument as the spawn cap". That claim is only true if
 * something refuses. A re-audit costs ~$0.30 cache-hot and ~$0.65 cold against
 * $29/mo, so an uncapped subscriber who clicks the button hourly is the one
 * customer who can make gross margin negative — and they would not have to mean
 * any harm by it. The cap is the same shape as the spawn cap and the rate
 * limiter: a number that says no before the money moves.
 *
 * ## Two clocks, deliberately different
 *
 * **10 audits/mo** resets, because it is a rate — a month is what the price is
 * quoted against. **3 sites** does not reset, because it is what the
 * subscription *is*: §1 sells monitoring for up to three sites, and a limit that
 * cleared every month would sell something else. The cost of that reading is
 * that a customer who wants to swap one site for another has to ask us, and at
 * this scale that is a founder deleting a row. If Kelly would rather sites were
 * monthly too, this is the one function to change and the tests say so.
 *
 * ## Why it takes rows and a clock rather than a database
 *
 * Both limits are arithmetic over a list. Passing the rows in keeps every case
 * — the month boundary, the third site, the eleventh audit — testable without a
 * fixture that has to be aged, and keeps the boundary condition from being
 * hidden inside a SQL string where nobody reads it.
 */

import type { ReauditRequestRow } from "./db.js";

/** §1: monitoring for up to three sites. Standing, not monthly — see above. */
export const SITE_LIMIT = 3;

/** §6/§11: ten re-audits a month is what $29 buys. */
export const AUDITS_PER_MONTH = 10;

export interface Allowance {
  allowed: boolean;
  /** Present only when refused. Written to be read by the customer, not by us. */
  reason?: string;
  /**
   * Which limit refused, as a word rather than the sentence above.
   *
   * The event log gets this and not `reason`. §8 makes events permanent, and
   * prose that names the customer's own sites is both PII-adjacent and useless
   * to count — "sites" is the fact worth keeping for a year.
   */
  limit?: "audits" | "sites";
}

/**
 * The site a URL belongs to.
 *
 * Host, lowercased, `www.` dropped — so `www.example.com/pricing` and
 * `example.com/` are one site and not two. Path is ignored on purpose: §1's
 * monitoring promise is about a site, and counting `/` and `/pricing` as two of
 * the three would make the limit depend on which page someone happened to audit
 * first.
 *
 * An unparseable URL falls back to the trimmed string. Every URL reaching this
 * has already been captured by a real browser, so the fallback exists to stay
 * total rather than to handle a case that occurs.
 */
export function siteOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return url.trim().toLowerCase();
  }
}

/** UTC calendar month, as the `YYYY-MM` prefix an ISO timestamp already starts with. */
function monthOf(iso: string): string {
  return iso.slice(0, 7);
}

/**
 * May this address ask for a re-audit of this URL?
 *
 * `history` is every request that address has ever made, completed or not — a
 * request that has been acted on has still been paid for, so both limits count
 * it. This is why the queue marks failures complete rather than deleting them:
 * a re-audit that failed still spent a capture, and quietly refunding it would
 * make the cap something an attacker could reset by supplying a URL that breaks.
 */
export function checkFairUse(
  history: ReauditRequestRow[],
  url: string,
  now: Date = new Date(),
): Allowance {
  const thisMonth = monthOf(now.toISOString());
  const used = history.filter((r) => monthOf(r.requested_at) === thisMonth).length;
  if (used >= AUDITS_PER_MONTH) {
    return {
      allowed: false,
      limit: "audits",
      reason:
        `That is ${AUDITS_PER_MONTH} re-audits this month, which is what the plan covers. ` +
        `The count resets on the 1st.`,
    };
  }

  const site = siteOf(url);
  const sites = new Set(history.map((r) => siteOf(r.url)));
  if (!sites.has(site) && sites.size >= SITE_LIMIT) {
    return {
      allowed: false,
      limit: "sites",
      reason:
        `The plan covers ${SITE_LIMIT} sites and you are already monitoring ` +
        `${[...sites].join(", ")}. Reply to any of our email and we will swap one out.`,
    };
  }

  return { allowed: true };
}
