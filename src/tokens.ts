/**
 * The magic link, minus the mail.
 *
 * §6 puts the full results behind "the magic-link session for the capturing
 * email". There is no Supabase and no mail sender in this repo, so the link is
 * generated, signed and *verified* here, and printed to the terminal instead of
 * posted. The token is real — swapping `console.log` for a send later touches
 * one function in `server.ts` and nothing in this file.
 *
 * The property that matters is not "the visitor proved they own the address".
 * A printed link proves nothing about an inbox. It is that **a token issued for
 * one audit cannot open another** — the audit id is inside the signature, so a
 * customer who receives a link to their own results cannot walk it sideways
 * into someone else's. That is the leak the gate exists to prevent, and it is
 * fully testable without an email server.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import path from "node:path";
import { OUT_ROOT } from "./paths.js";

/** Seven days. Long enough to be useful, short enough that a leaked link dies. */
export const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** What the signature covers. Every field is load-bearing; see `verify`. */
export interface TokenClaims {
  /** The audit this token opens, and only this one. */
  auditId: string;
  /**
   * The address that asked for it.
   *
   * Inside the signature rather than alongside it, so the row this marks
   * verified is the row that asked — a link cannot be edited to credit a
   * different address. The page itself never displays it.
   */
  email: string;
  /** Expiry, epoch milliseconds. */
  expiresAt: number;
}

/**
 * The signing key.
 *
 * From `USABILITY_LAB_SECRET` if set. Otherwise generated once and written to
 * `out/.secret` with 0600, because the alternative — a constant fallback — is
 * how a signing key ends up in a git history. A generated key means restarting
 * with the file deleted invalidates every outstanding link, which is the right
 * failure: links stop working, rather than a stranger's link starting to.
 */
function secret(): Buffer {
  const fromEnv = process.env.USABILITY_LAB_SECRET;
  if (fromEnv) return Buffer.from(fromEnv, "utf8");

  const file = path.join(OUT_ROOT, ".secret");
  if (existsSync(file)) return Buffer.from(readFileSync(file, "utf8").trim(), "hex");

  const generated = randomBytes(32);
  mkdirSync(OUT_ROOT, { recursive: true });
  writeFileSync(file, generated.toString("hex"), { mode: 0o600 });
  chmodSync(file, 0o600);
  return generated;
}

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString("base64url");
}

function mac(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url");
}

/** `<payload>.<signature>`, both base64url. */
export function sign(auditId: string, email: string, now = Date.now()): string {
  const claims: TokenClaims = { auditId, email, expiresAt: now + TOKEN_TTL_MS };
  const payload = b64url(JSON.stringify(claims));
  return `${payload}.${mac(payload)}`;
}

export type VerifyFailure = "malformed" | "bad-signature" | "expired" | "wrong-audit";

export type VerifyResult =
  | { ok: true; claims: TokenClaims }
  | { ok: false; reason: VerifyFailure };

/**
 * Verify a token, **for a named audit**.
 *
 * `auditId` is not optional on purpose. A `verify(token)` that returned the
 * claims and left the caller to compare them is a check every future caller
 * can forget, and forgetting it is exactly the cross-audit leak this exists to
 * stop. Making the audit an argument means the only way to use this function is
 * the safe way.
 */
export function verify(token: string, auditId: string, now = Date.now()): VerifyResult {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: "malformed" };
  const [payload, signature] = parts;

  // Compare before parsing. An unsigned payload is attacker-controlled JSON,
  // and there is no reason to hand it to a parser.
  const expected = Buffer.from(mac(payload), "utf8");
  const given = Buffer.from(signature, "utf8");
  if (expected.length !== given.length) return { ok: false, reason: "bad-signature" };
  if (!timingSafeEqual(expected, given)) return { ok: false, reason: "bad-signature" };

  let claims: TokenClaims;
  try {
    claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as TokenClaims;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims?.auditId !== "string" || typeof claims?.email !== "string") {
    return { ok: false, reason: "malformed" };
  }
  if (typeof claims.expiresAt !== "number" || now >= claims.expiresAt) {
    return { ok: false, reason: "expired" };
  }
  if (claims.auditId !== auditId) return { ok: false, reason: "wrong-audit" };

  return { ok: true, claims };
}

/**
 * A CSRF token, bound to the session it was rendered into.
 *
 * ## Why now
 *
 * The rule written into `server.ts` when the cookie was introduced: **if a
 * state-changing route ever reads this cookie, it needs a CSRF token that day.**
 * The re-audit button is that route. It reads `ul_full` to learn who is asking,
 * and it writes a row that costs money to act on.
 *
 * ## Why it is derived rather than stored
 *
 * `HMAC(secret, "csrf:" + sessionToken)`. No table, no session store, no
 * expiry of its own — it dies exactly when the session does, because the session
 * token is its input. A forged form cannot carry a valid value without already
 * knowing the cookie, and anything that knows the cookie does not need a forged
 * form.
 *
 * `SameSite=Lax` already blocks a cross-site POST from carrying the cookie at
 * all, so this is the second lock rather than the first. It is worth having
 * anyway: `SameSite` is a browser's promise, this is ours, and the day someone
 * relaxes the cookie to `None` for an embed, this is what still holds.
 *
 * The `csrf:` prefix is domain separation. Without it a value signed here and a
 * signature from `sign` are the same construction over overlapping inputs, and
 * "these two things could never collide" stops being something you can check by
 * reading.
 */
export function csrfFor(sessionToken: string): string {
  return mac(`csrf:${sessionToken}`);
}

/** Constant-time, and false for an absent session — no session, no writes. */
export function csrfMatches(sessionToken: string, given: string): boolean {
  if (!sessionToken || !given) return false;
  const expected = Buffer.from(csrfFor(sessionToken), "utf8");
  const supplied = Buffer.from(given, "utf8");
  if (expected.length !== supplied.length) return false;
  return timingSafeEqual(expected, supplied);
}

/**
 * The loosest check that still rejects nonsense.
 *
 * Deliberately not RFC 5322. A stricter pattern here rejects real addresses —
 * plus-tags, new TLDs, unicode locals — and the cost of a wrong reject is a
 * customer who cannot read the audit they just paid attention to. The cost of a
 * wrong accept is a row in a table.
 */
export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim()) && value.trim().length <= 254;
}
