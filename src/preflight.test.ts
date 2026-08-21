import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { preflight, type Env } from "./preflight.js";

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
