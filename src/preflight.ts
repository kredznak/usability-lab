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
