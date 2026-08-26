import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { preflight, baseUrlFrom, canonicalHost, type Env, bootBanner } from "./preflight.js";

/**
 * What `npm run serve` checks before it agrees to be public.
 *
 * ## Why refuse rather than warn
 *
 * Both conditions below are invisible when wrong. A cookie missing `Secure`
 * looks identical to one that has it until somebody is on a hostile network; a
 * collapsed rate limiter looks like a broken router. Neither produces an error
 * anyone would connect to its cause, and a warning printed at boot is read once
 * and never again.
 *
 * `server.ts` already refuses to guess about TLS — "whatever terminates TLS
 * must set `USABILITY_LAB_SECURE_COOKIES` because this file refuses to guess."
 * This is the same rule with teeth: state what is in front, or do not start.
 *
 * ## The trigger is the operator's own claim
 *
 * Nothing here inspects the network. `USABILITY_LAB_BASE_URL` beginning
 * `https://` is the operator saying *this is reachable over TLS*, and that
 * claim is what makes the two variables mandatory. Local development sets no
 * base URL, changes nothing, and is unaffected — which matters, because a
 * preflight that made `npm run serve` annoying would be turned off.
 */

/** Only the four variables the preflight actually reads. */
function env(over: Partial<Env> = {}): Env {
  return { baseUrl: undefined, secureCookies: undefined, clientIpHeader: undefined, secret: undefined, ...over };
}

const PUBLIC = { baseUrl: "https://lab.example", secureCookies: "1", clientIpHeader: "cf-connecting-ip" };

describe("locally, nothing is required", () => {
  test("no base URL means no claim to be public, so it starts", () => {
    const r = preflight(env());
    assert.equal(r.ok, true);
    assert.deepEqual(r.refusals, []);
  });

  test("an http base URL is still local, and still fine", () => {
    assert.equal(preflight(env({ baseUrl: "http://localhost:4000" })).ok, true);
  });
});

describe("claiming https makes two things mandatory", () => {
  test("https without secure cookies is refused, and the variable is named", () => {
    const r = preflight(env({ ...PUBLIC, secureCookies: undefined }));
    assert.equal(r.ok, false);
    assert.equal(r.refusals.length, 1);
    assert.match(r.refusals[0]!, /USABILITY_LAB_SECURE_COOKIES/, "say which variable to set");
    assert.match(r.refusals[0]!, /Secure/, "and why it matters");
  });

  test("https without a named client-IP header is refused", () => {
    // The one that looks like a broken site rather than a misconfiguration:
    // five audit requests an hour, shared by everyone.
    const r = preflight(env({ ...PUBLIC, clientIpHeader: undefined }));
    assert.equal(r.ok, false);
    assert.match(r.refusals[0]!, /USABILITY_LAB_CLIENT_IP_HEADER/);
    assert.match(r.refusals[0]!, /rate limit|five|per client/i);
  });

  test("both missing gives both reasons, not the first one", () => {
    // A preflight that reports one problem per run turns a two-minute fix into
    // two restarts.
    const r = preflight(env({ baseUrl: "https://lab.example" }));
    assert.equal(r.ok, false);
    assert.equal(r.refusals.length, 2);
  });

  test("with both set, it starts", () => {
    const r = preflight(env(PUBLIC));
    assert.equal(r.ok, true, r.refusals.join(" / "));
  });

  test("secure cookies set to anything but 1 does not count", () => {
    // setCookie tests `=== "1"` exactly. A preflight that accepted "true" would
    // pass a config that still ships an insecure cookie.
    assert.equal(preflight(env({ ...PUBLIC, secureCookies: "true" })).ok, false);
  });

  test("HTTPS in capitals is still a claim to be public", () => {
    assert.equal(preflight(env({ baseUrl: "HTTPS://lab.example" })).ok, false);
  });
});

describe("what it reports when it does start", () => {
  test("it says where the signing key came from", () => {
    /**
     * The silent total failure. `USABILITY_LAB_SECRET` falls back to a generated
     * `out/.secret`, so on a host without a persistent volume every magic link
     * and every session dies on each redeploy — and the only symptom is
     * customers saying links stopped working.
     */
    assert.match(preflight(env(PUBLIC)).lines.join("\n"), /signing key.*out\/\.secret/is);
    assert.match(preflight(env({ ...PUBLIC, secret: "x" })).lines.join("\n"), /signing key.*environment/is);
  });

  test("it prints the public URL, the trusted header and the cookie flag", () => {
    const out = preflight(env(PUBLIC)).lines.join("\n");
    assert.match(out, /lab\.example/);
    assert.match(out, /cf-connecting-ip/);
    assert.match(out, /secure/i);
  });

  test("a local run says plainly that it is not public", () => {
    assert.match(preflight(env()).lines.join("\n"), /not public|local/i);
  });
});

/**
 * A base URL that is not a URL.
 *
 * Added 2026-08-22. `server.ts` began reading this variable for magic links and
 * the canonical host, both at module scope — so a value `new URL()` rejects
 * became `TypeError: Invalid URL` during import, printed as a stack trace, with
 * the process dead before this file could name the variable. A boot check that
 * can be skipped by the thing it checks is not a boot check.
 *
 * The refusal is deliberately **not** gated on the https branch above, because
 * the value that fails here is exactly the one that cannot be https: forget the
 * scheme and `theusabilitylab.com` is not public, so every other check stays
 * quiet while every absolute address the site issues is built from it.
 */
describe("a base URL that is not a URL", () => {
  const reason = (baseUrl: string) => preflight(env({ baseUrl })).refusals.join("\n");

  test("a missing scheme is refused, and the fix is spelled out", () => {
    // The typo this exists for.
    const r = preflight(env({ baseUrl: "theusabilitylab.com" }));
    assert.equal(r.ok, false);
    assert.match(r.refusals.join("\n"), /USABILITY_LAB_BASE_URL/);
    assert.match(r.refusals.join("\n"), /https:\/\/theusabilitylab\.com/, "show the corrected value");
  });

  test("a scheme with no host is refused", () => {
    // `new URL("https://")` throws too, and reads as complete at a glance.
    //
    // Asserting `ok === false` here would pass for the wrong reason: "https://"
    // starts with "https://", so the secure-cookie and client-IP refusals fire
    // regardless and the suite goes green with this check deleted. Measured —
    // it did. The assertion has to name the refusal it is actually about.
    const r = preflight(env({ ...PUBLIC, baseUrl: "https://" }));
    assert.equal(r.ok, false);
    assert.equal(r.refusals.length, 1, "the two https refusals are satisfied; only this one is left");
    assert.match(r.refusals[0]!, /not an http or https URL/);
  });

  test("a scheme we do not serve over is refused", () => {
    // Parses fine, and would silently produce ftp:// magic links.
    assert.match(reason("ftp://lab.example"), /USABILITY_LAB_BASE_URL/);
  });

  test("unset is not a malformed value", () => {
    // The local case, which must stay silent — see the first suite.
    assert.deepEqual(preflight(env()).refusals, []);
    assert.deepEqual(preflight(env({ baseUrl: "   " })).refusals, []);
  });

  test("the refusal names the variable rather than quoting a parser", () => {
    assert.doesNotMatch(reason("theusabilitylab.com"), /TypeError|ERR_INVALID_URL/);
  });
});

describe("one reading of the base URL, shared by everything that builds an address", () => {
  test("a trailing slash is dropped, however many there are", () => {
    // A trailing slash becomes a double slash in a magic link, and Stripe
    // rejects a return URL shaped like that.
    assert.equal(baseUrlFrom({ USABILITY_LAB_BASE_URL: "https://lab.example///" }), "https://lab.example");
  });

  test("unset falls back to localhost on the configured port", () => {
    assert.equal(baseUrlFrom({ PORT: "4321" }), "http://localhost:4321");
    assert.equal(baseUrlFrom({}), "http://localhost:4000");
  });

  test("it never throws, whatever it is handed", () => {
    // The whole point: server.ts reads this at module scope, and a constant that
    // throws during import kills the process before the refusal can be printed.
    for (const bad of ["theusabilitylab.com", "https://", "", "   ", "::::"]) {
      assert.doesNotThrow(() => baseUrlFrom({ USABILITY_LAB_BASE_URL: bad }));
    }
  });

  test("the canonical host is the host, lowercased", () => {
    assert.equal(canonicalHost("https://TheUsabilityLab.com"), "theusabilitylab.com");
    assert.equal(canonicalHost("http://localhost:4000"), "localhost:4000");
  });

  test("an unparseable base URL has no canonical host, rather than a wrong one", () => {
    // null means "canonicalise nothing". A malformed host would send every
    // request to a redirect that cannot resolve.
    assert.equal(canonicalHost("theusabilitylab.com"), null);
    assert.equal(canonicalHost("https://"), null);
  });
});

/**
 * The banner that discarded itself.
 *
 * It was a template literal at the call site, and `+` binds tighter than `?:` —
 * so the condition was not `mail`, it was the whole concatenation ending in
 * `mail`, which is a non-empty string and always truthy. Every line before the
 * mail branch was built, concatenated, tested for truthiness and thrown away.
 * `npm run serve` printed exactly one line for its whole life:
 *
 *     Mail is on: links are sent, not printed.
 *
 * Nothing caught it because it was accidentally correct. Once `RESEND_API_KEY`
 * was set the sentence was true, and a terse banner reads as a design choice.
 * With mail off it said the opposite of the truth, on the one line whose entire
 * job is telling the operator whether the next magic link prints to this
 * terminal or goes to a stranger's inbox.
 *
 * Which is why these are branch assertions and not a snapshot: a snapshot of
 * the broken version would have looked like a perfectly good snapshot.
 */
describe("the boot banner says all of it, and the right half of the branch", () => {
  const banner = (over: Partial<Parameters<typeof bootBanner>[0]> = {}) =>
    bootBanner({
      url: "http://localhost:4000",
      preflightReport: "  PREFLIGHT-LINES",
      bind: null,
      ready: 3,
      mail: false,
      ...over,
    });

  test("mail off says links print here", () => {
    const b = banner({ mail: false });
    assert.match(b, /Magic links print here; no email is sent/);
    assert.doesNotMatch(b, /Mail is on/, "the exact sentence the bug always printed");
  });

  test("mail on says links are sent", () => {
    const b = banner({ mail: true });
    assert.match(b, /Mail is on: links are sent, not printed/);
    assert.doesNotMatch(b, /no email is sent/);
  });

  test("nothing before the branch is discarded", () => {
    /**
     * The other half, and the half that is easy to forget once the ternary is
     * parenthesised. Each of these was evaluated and thrown away: the address
     * an operator needs to open the site, the preflight report, the bind line
     * that says whether the LAN can reach it, and the audit count.
     */
    const b = banner({ mail: true });
    assert.match(b, /http:\/\/localhost:4000/, "the address");
    assert.match(b, /PREFLIGHT-LINES/, "the preflight report");
    assert.match(b, /bound to\s+every interface/, "the bind line");
    assert.match(b, /3 audits reachable/, "the audit count");
  });

  test("a named bind is reported instead of every interface", () => {
    assert.match(banner({ bind: "127.0.0.1" }), /bound to\s+127\.0\.0\.1/);
  });

  test("one audit is not one audits", () => {
    assert.match(banner({ ready: 1 }), /1 audit reachable/);
    assert.match(banner({ ready: 0 }), /0 audits reachable/);
  });
});
