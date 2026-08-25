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

export function mailConfig(env: NodeJS.ProcessEnv = process.env): MailConfig | null {
  const apiKey = (env.RESEND_API_KEY ?? "").trim();
  if (!apiKey) return null;
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
