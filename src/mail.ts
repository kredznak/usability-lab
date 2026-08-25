/**
 * Sending mail, and the seam that lets everything below it be tested.
 *
 * Two links this product issues are bearer credentials addressed to a person —
 * the magic link that opens a full audit, and the sign-in link that opens an
 * account index. For their whole life both were `console.log`, with a comment
 * in `server.ts` explaining why they were not faked: *"a page that says 'check
 * your email' while nothing was sent is a lie we would then have to remember
 * was a lie."* The page told the truth and the product did not work.
 *
 * ## Resend, because §4 already chose it
 *
 * `design.md`'s trust-boundary table names `resend_send` and a Resend webhook.
 * This follows that rather than shopping, and it is a plain HTTPS POST, so
 * there is no dependency to add — the same reasoning that kept `liveStripe`
 * hand-written.
 *
 * ## Why the console backend stays
 *
 * With no `RESEND_API_KEY` this prints, exactly as before. A fresh clone works,
 * the test suite runs with no account, and a developer is never blocked on a
 * credential to see the flow. The seam is `RESEND_API_BASE`, the same shape as
 * `STRIPE_API_BASE`, which is what lets the tests send real requests over real
 * HTTP to a server they control.
 */

export interface MailConfig {
  apiKey: string;
  from: string;
  apiBase: string;
}

export interface Mail {
  to: string;
  subject: string;
  text: string;
}

/**
 * Unverified Resend accounts may send only from this address, and only to the
 * account owner's own. That is enough to prove the whole flow before touching
 * DNS, which is why it is the default rather than an error.
 */
export const DEFAULT_FROM = "onboarding@resend.dev";

/**
 * What a Resend key looks like, and why this is checked at all.
 *
 * On 2026-08-25 `RESEND_API_KEY` was filled in three times running with an
 * Anthropic key — once plain, once with `re_` typed in front of it. The second
 * one passed a naive prefix check, went out in an `Authorization: Bearer`
 * header to a third party, and came back 401. The credential was rejected
 * rather than used, which is luck rather than design: nothing here stopped a
 * model key being handed to a mail provider.
 *
 * So the shape is checked before the key can leave the process. `preflight.ts`
 * already refuses to boot on a base URL that does not parse; a secret in the
 * right slot with the wrong contents deserves the same treatment, and it is
 * worse than a missing one — missing prints to the console and works.
 *
 * Length is part of it deliberately. `re_` alone was the check that failed.
 */
const RESEND_KEY = /^re_[A-Za-z0-9_-]{20,60}$/;

export class BadMailKey extends Error {
  constructor(detail: string) {
    super(
      `RESEND_API_KEY does not look like a Resend key (${detail}). ` +
        `Resend keys start "re_" and are about 36 characters — get one at ` +
        `https://resend.com/api-keys. Nothing was sent. Remove the line entirely ` +
        `to go back to printing links to the console.`,
    );
    this.name = "BadMailKey";
  }
}

export function mailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig | null {
  const apiKey = (env.RESEND_API_KEY ?? "").trim();
  if (!apiKey) return null;

  /**
   * Never the value, and never a fragment of it. The whole point is that this
   * might be somebody's model credential, and a "helpful" excerpt in a log is
   * how a secret ends up somewhere permanent.
   */
  if (!RESEND_KEY.test(apiKey)) {
    throw new BadMailKey(
      apiKey.startsWith("re_")
        ? `right prefix, ${apiKey.length} characters`
        : `starts ${JSON.stringify(apiKey.slice(0, 3))}, ${apiKey.length} characters`,
    );
  }
  return {
    apiKey,
    from: (env.USABILITY_LAB_MAIL_FROM ?? "").trim() || DEFAULT_FROM,
    apiBase: (env.RESEND_API_BASE ?? "").trim() || "https://api.resend.com",
  };
}

export type SendResult = { ok: true; id: string } | { ok: false; error: string };

/**
 * One send, and it never throws.
 *
 * A failed send must not take down the request that triggered it: the visitor
 * has already been told a link is coming, and a 500 at that point would tell
 * them the opposite of what happened — the audit is fine, the mail is not. The
 * caller decides what to say; this reports.
 */
export async function sendMail(mail: Mail, config: MailConfig): Promise<SendResult> {
  let res: Response;
  try {
    res = await fetch(`${config.apiBase}/emails`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: config.from,
        to: [mail.to],
        subject: mail.subject,
        text: mail.text,
      }),
    });
  } catch (err) {
    return { ok: false, error: `mail transport failed: ${(err as Error).message}` };
  }

  const body = await res.text();

  if (!res.ok) {
    /**
     * The response is echoed because a provider's own message is the only
     * useful diagnosis — but never the request, which carries the key in a
     * header, and never the mail body, which carries the credential we just
     * minted. A log line is not a place for either.
     */
    return { ok: false, error: `mail rejected (${res.status}): ${body.slice(0, 300)}` };
  }

  try {
    const parsed = JSON.parse(body) as { id?: string };
    return { ok: true, id: parsed.id ?? "" };
  } catch {
    // Accepted, but not in a shape we recognise. Reporting it as sent is the
    // honest reading — the provider took it — and the id is what we lose.
    return { ok: true, id: "" };
  }
}

/**
 * Send if configured; otherwise print, exactly as this did before mail existed.
 *
 * The link is printed **only** on the console path. Once mail is real, writing
 * a bearer credential into a log file is a leak rather than a convenience, and
 * the two behaviours must not both be on.
 */
export async function deliver(mail: Mail, config: MailConfig | null): Promise<SendResult> {
  if (!config) {
    console.log(`\n  ${mail.subject} for ${mail.to}\n  ${mail.text.trim()}\n`);
    return { ok: true, id: "console" };
  }
  const result = await sendMail(mail, config);
  if (!result.ok) console.error(`  ${result.error}`);
  return result;
}
