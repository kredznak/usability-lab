/**
 * What the server checks before it agrees to be reachable from the internet.
 *
 * ## The two failures this exists for
 *
 * Both are invisible when wrong, which is the whole argument for a hard stop
 * rather than a printed warning.
 *
 * **A cookie without `Secure`.** `ul_full` is a bearer credential. Missing the
 * flag, it looks and behaves identically until somebody is on a network that
 * can read it, at which point it has already leaked. Nothing about the running
 * site says anything is wrong.
 *
 * **A collapsed rate limiter.** `asksByClient` allows five audit requests an
 * hour per client, keyed on the connecting address. Behind a TLS terminator
 * every request arrives from the proxy, so five an hour becomes the whole
 * site's budget. The symptom is a 429 for strangers and a working site for
 * whoever tests it first — it reads as a broken router, not a misconfiguration.
 *
 * ## Why refusing is in keeping rather than strict
 *
 * `server.ts` already says "whatever terminates TLS must set
 * `USABILITY_LAB_SECURE_COOKIES` because this file refuses to guess." Guessing
 * in the safe direction breaks every cookie on localhost; guessing the other
 * way puts a credential on the wire in clear. That reasoning was already
 * written down — it just had nothing enforcing it. This is that, with teeth.
 *
 * ## What triggers it
 *
 * Nothing here inspects the network. `USABILITY_LAB_BASE_URL` starting
 * `https://` **is the operator's own claim** that this is reachable over TLS,
 * and that claim is what makes the two variables mandatory. A local run sets no
 * base URL, trips nothing, and is unaffected — deliberately, because a
 * preflight that made `npm run serve` tiresome would be commented out inside a
 * week.
 */

/**
 * `USABILITY_LAB_BASE_URL`, parsed — or null when it is not an http(s) URL.
 *
 * Private on purpose: callers should ask one of the two functions below rather
 * than get a `URL` and decide for themselves what a missing scheme means.
 */
function parse(raw: string): URL | null {
  try {
    const u = new URL(raw);
    return u.protocol === "http:" || u.protocol === "https:" ? u : null;
  } catch {
    return null;
  }
}

/**
 * The one place `USABILITY_LAB_BASE_URL` is turned into an address, used by
 * `server.ts` for magic links and by `stripe.ts` for the return URL. It lived in
 * both until 2026-08-22, which is two copies of one rule and one of them tested.
 *
 * Trailing slashes go because a trailing slash here becomes a double slash in a
 * magic link, and Stripe rejects a return URL shaped like that.
 *
 * **This never throws.** `server.ts` reads it at module scope, and a constant
 * that throws during import kills the process before `preflight` can say a word
 * — which would be this file's own failure mode arriving through its front door.
 * An unparseable value is reported below, in the place built for saying why.
 */
export function baseUrlFrom(env: NodeJS.ProcessEnv = process.env): string {
  return (env.USABILITY_LAB_BASE_URL || `http://localhost:${env.PORT || 4000}`).replace(/\/+$/, "");
}

/**
 * The single host this site answers on, or **null** when the base URL does not
 * parse. Null means "canonicalise nothing" rather than "canonicalise to
 * garbage": the refusal below is what stops the boot, and a redirect loop to a
 * malformed host would be a worse way to find out.
 */
export function canonicalHost(baseUrl: string): string | null {
  const u = parse(baseUrl);
  return u ? u.host.toLowerCase() || null : null;
}

export interface Env {
  baseUrl: string | undefined;
  secureCookies: string | undefined;
  clientIpHeader: string | undefined;
  secret: string | undefined;
}

export interface Preflight {
  ok: boolean;
  /** Every reason at once — one problem per restart is a bad trade for a boot check. */
  refusals: string[];
  /** What the configuration actually is, for the operator to read back. */
  lines: string[];
}

/** Read from the process, so `main` does not have to know the variable names. */
export function envFromProcess(): Env {
  return {
    baseUrl: process.env.USABILITY_LAB_BASE_URL,
    secureCookies: process.env.USABILITY_LAB_SECURE_COOKIES,
    clientIpHeader: process.env.USABILITY_LAB_CLIENT_IP_HEADER,
    secret: process.env.USABILITY_LAB_SECRET,
  };
}

export function preflight(env: Env): Preflight {
  const isPublic = (env.baseUrl ?? "").toLowerCase().startsWith("https://");
  const refusals: string[] = [];
  const lines: string[] = [];

  /**
   * Checked before anything else, and **not** gated on `isPublic` — because the
   * value that fails here is precisely the one that cannot be public. Forget the
   * scheme and `theusabilitylab.com` is not https, so every check below stays
   * quiet while every absolute address the site hands out is built from a string
   * that is not an address.
   *
   * Added 2026-08-22, after `server.ts` began reading the base URL and a
   * schemeless value became `TypeError: Invalid URL` at import — a stack trace
   * where this file's whole purpose is a sentence saying which variable is wrong.
   */
  const raw = (env.baseUrl ?? "").trim();
  if (raw !== "" && parse(raw) === null) {
    refusals.push(
      `USABILITY_LAB_BASE_URL is "${raw}", which is not an http or https URL.\n` +
        `     Magic links, Stripe's return URL and the canonical host are all built\n` +
        `     from it, so this is not a cosmetic setting. The usual cause is a missing\n` +
        `     scheme: write https://theusabilitylab.com, not theusabilitylab.com.`,
    );
  }

  if (!isPublic) {
    lines.push(
      `  reachable at   ${env.baseUrl ?? "http://localhost"} — not public, so nothing below is enforced`,
    );
  } else {
    lines.push(`  reachable at   ${env.baseUrl}`);

    // `setCookie` compares against "1" exactly, so anything else is a config
    // that looks set and ships an insecure cookie regardless.
    if (env.secureCookies !== "1") {
      refusals.push(
        `USABILITY_LAB_SECURE_COOKIES is not "1", but the base URL is https.\n` +
          `     ul_full is a bearer credential and would go out without the Secure flag,\n` +
          `     which means it can travel over plain http and nothing on the page says so.\n` +
          `     Set USABILITY_LAB_SECURE_COOKIES=1 on whatever terminates TLS.`,
      );
    }

    if (!env.clientIpHeader) {
      refusals.push(
        `USABILITY_LAB_CLIENT_IP_HEADER is unset, but the base URL is https.\n` +
          `     Behind a proxy every request arrives from the same address, so the\n` +
          `     per-client rate limit of five audit requests an hour becomes five for\n` +
          `     the entire site — the sixth visitor of the hour is refused.\n` +
          `     Set it to the header your proxy writes (cf-connecting-ip for Cloudflare).`,
      );
    }
  }

  lines.push(`  secure cookie  ${env.secureCookies === "1" ? "yes" : "no"}`);
  lines.push(`  client address ${env.clientIpHeader ?? "the connecting socket"}`);

  /**
   * The silent, total failure mode, and the reason it is printed even when
   * everything passes.
   *
   * `tokens.ts` falls back to a generated `out/.secret`. On a host with no
   * persistent volume that file is new on every deploy, so every magic link and
   * every session ever issued stops verifying at once — and the only symptom is
   * customers reporting that links no longer work. Not a refusal, because on a
   * machine that keeps its disk the file is the correct answer; but it should
   * never be a surprise which one is in use.
   */
  lines.push(
    env.secret
      ? `  signing key    from the environment`
      : `  signing key    generated, in out/.secret — every link dies if that file does not persist`,
  );

  return { ok: refusals.length === 0, refusals, lines };
}

/** The block `npm run serve` prints, or the one it dies with. */
export function report(p: Preflight): string {
  if (p.ok) return p.lines.join("\n");
  return (
    `\n  REFUSING TO START — ${p.refusals.length} thing${p.refusals.length === 1 ? "" : "s"} ` +
    `about being public that this cannot guess:\n\n` +
    p.refusals.map((r, i) => `  ${i + 1}. ${r}`).join("\n\n") +
    `\n\n  See docs/deploy-runbook.md.\n`
  );
}

/**
 * The block `npm run serve` prints once it is listening.
 *
 * ## Why this is a function and not a template literal at the call site
 *
 * Because it was one, and for its whole life it printed a single line.
 *
 * ```js
 * console.log(
 *   `\n  The Usability Lab — http://${host}:${PORT}\n` +
 *     report(checks) + `\n` +
 *     `  bound to       ${BIND ?? "every interface"}\n` +
 *     `  ${ready} audit(s) reachable…\n` +
 *     mail
 *       ? `  Mail is on: links are sent, not printed.\n`
 *       : `  Magic links print here; no email is sent.\n`,
 * );
 * ```
 *
 * `+` binds tighter than `?:`, so the condition is not `mail` — it is the whole
 * concatenation *ending* in `mail`, which is a non-empty string and therefore
 * always truthy. The address, the preflight report, the bind line and the audit
 * count were all evaluated, concatenated, tested for truthiness and thrown
 * away. What printed was always the first branch:
 *
 *     Mail is on: links are sent, not printed.
 *
 * **It hid for as long as it did because it was accidentally right.** Once
 * `RESEND_API_KEY` was set the sentence matched reality, so the banner looked
 * terse rather than broken. With mail off it stated the exact opposite of the
 * truth — on the one line whose whole job is telling the operator whether a
 * magic link is about to be printed here or posted to a stranger.
 *
 * A function, so the branch can be asserted rather than eyeballed. The call
 * site now has no operators in it at all.
 */
export function bootBanner(input: {
  /** Where it is actually reachable, already formatted. */
  url: string;
  /** `report(preflight(...))` — the lines it would have printed. */
  preflightReport: string;
  /** `USABILITY_LAB_BIND`, or null for every interface. */
  bind: string | null;
  /** Published audits this server can serve. */
  ready: number;
  /** Whether `mailConfig()` returned anything. */
  mail: boolean;
}): string {
  const { url, preflightReport, bind, ready, mail } = input;
  return (
    `\n  The Usability Lab — ${url}\n` +
    `${preflightReport}\n` +
    `  bound to       ${bind ?? "every interface"}\n` +
    `  ${ready} audit${ready === 1 ? "" : "s"} reachable. Links are printed by \`npm run review\`.\n` +
    (mail
      ? `  Mail is on: links are sent, not printed.\n`
      : `  Magic links print here; no email is sent.\n`)
  );
}
