import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  preflight,
  domainOf,
  dmarcPolicy,
  siteDomain,
  DKIM_SELECTOR,
  SEND_SUBDOMAIN,
  type MailDns,
} from "./mail-check.js";

const DOMAIN = "theusabilitylab.com";

/** Nothing published. What this domain looked like on 2026-08-25. */
const bare: MailDns = { sendTxt: [], dkimTxt: [], dmarcTxt: [], sendMx: [] };

/**
 * The registrar's leftover — GoDaddy publishes this on domains it sells, and it
 * predates every line of this project. `p=quarantine` with nothing to satisfy
 * it is the standing hazard the DMARC check reasons about.
 */
const quarantine = ["v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;"];

/** Everything Resend asks for, present. */
const configured: MailDns = {
  sendTxt: ["v=spf1 include:amazonses.com ~all"],
  dkimTxt: ["p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQC"],
  dmarcTxt: quarantine,
  sendMx: [{ exchange: "feedback-smtp.us-east-1.amazonses.com", priority: 10 }],
};

const run = (from: string, dns: MailDns) => preflight({ from, domain: DOMAIN, dns });
const blocking = (from: string, dns: MailDns) => run(from, dns).filter((c) => !c.ok && !c.warn);
const named = (from: string, dns: MailDns, name: string) =>
  run(from, dns).find((c) => c.name.startsWith(name));

/**
 * The whole file in one idea: what fails here fails invisibly — but not the
 * thing this was first written to catch.
 *
 * The original premise was an ordering trap: move the From to this domain
 * before the DNS exists, and its inherited `p=quarantine` junks every magic
 * link. It was measured on 2026-08-25 with one API call and refuted — Resend
 * returns 403 for an unverified sending domain, so that mistake is loud and
 * stops at the API. The silent one runs the other way, after verification has
 * already passed.
 */
describe("the state that fails without telling anyone", () => {
  test("a verified domain that loses its records still sends, unsigned", () => {
    /**
     * Verification is something Resend checks once. Afterwards the sends are
     * accepted, so records pruned out of Cloudflare later — or a zone rebuilt
     * without them — leave mail going out unsigned against a published
     * `p=quarantine`. Resend accepts it, the server logs a success, the queue
     * empties, and the link is in a spam folder.
     *
     * Nothing else in this system can see that. It is the only reason this file
     * exists, and it is not the reason it was started.
     */
    const drifted = { ...bare, dmarcTxt: quarantine };
    const dmarc = named(`hello@${DOMAIN}`, drifted, "DMARC")!;
    assert.equal(dmarc.ok, false);
    assert.ok(!dmarc.warn, "this one is a refusal, not a warning");
    assert.match(dmarc.detail, /still\s+accepting the sends/i);
  });

  test("sending as an unverified domain is reported as broken, because it is", () => {
    // Measured: `403 The theusabilitylab.com domain is not verified.` So this
    // state is not subtle — but it is still a refusal rather than a warning,
    // because in it not one message goes out.
    const fails = blocking(`hello@${DOMAIN}`, bare).map((c) => c.name);
    assert.ok(fails.some((n) => n.startsWith("SPF")), "no SPF");
    assert.ok(fails.some((n) => n.startsWith("DKIM")), "no DKIM");
  });

  test("the same DNS is not a problem while the From is elsewhere", () => {
    // Nothing about the domain changed — only who the mail claims to be from.
    // Reporting this state as broken would be crying wolf, and a preflight that
    // does that gets ignored on the day it is right.
    assert.deepEqual(blocking("onboarding@resend.dev", { ...bare, dmarcTxt: quarantine }), []);
  });

  test("with the records in place the From can move", () => {
    assert.deepEqual(blocking(`hello@${DOMAIN}`, configured), []);
    assert.match(named(`hello@${DOMAIN}`, configured, "DMARC")!.detail, /SPF and DKIM/);
  });

  test("DMARC passes on DKIM alone, because that is what DMARC asks", () => {
    /**
     * The bug this test was added for. `aligned` was `spf && dkim`, which would
     * have called a domain delivering perfectly well on DKIM alignment a
     * failure — stricter than the spec, and wrong in the direction that makes
     * an operator distrust the tool.
     *
     * SPF is still reported missing above. It is simply not what decides
     * whether DMARC is satisfied.
     */
    const dkimOnly = { ...configured, sendTxt: [] };
    const dmarc = named(`hello@${DOMAIN}`, dkimOnly, "DMARC")!;
    assert.equal(dmarc.ok, true, "one aligned mechanism is enough for DMARC");
    assert.equal(named(`hello@${DOMAIN}`, dkimOnly, "SPF")!.ok, false, "and SPF still says so");
  });

  test("a policy of none does not block, because it instructs nothing", () => {
    // p=none asks receivers to report and take no action, so unaligned mail
    // under it is untidy rather than junked. The DMARC line specifically must
    // not refuse — whatever the records around it are doing.
    const none = { ...bare, dmarcTxt: ["v=DMARC1; p=none;"] };
    assert.equal(named(`hello@${DOMAIN}`, none, "DMARC")!.ok, true);
  });
});

describe("what each record is checked for", () => {
  test("SPF on the apex does not count as SPF", () => {
    /**
     * The specific wrong answer. Resend's return-path lives in the `send`
     * subdomain, so an apex SPF authorises nothing it uses — and it looks
     * exactly like having done the work. The lookup only ever asks about
     * `send.<domain>`, so this test is really asserting that the checker never
     * learns to accept the apex as a substitute.
     */
    const apexOnly: MailDns = { ...bare, sendTxt: [] };
    const spf = named(`hello@${DOMAIN}`, apexOnly, "SPF")!;
    assert.equal(spf.ok, false);
    assert.match(spf.detail, new RegExp(`${SEND_SUBDOMAIN} subdomain`));
  });

  test("an SPF that authorises somebody else is not an SPF for us", () => {
    const wrong: MailDns = { ...bare, sendTxt: ["v=spf1 include:_spf.google.com ~all"] };
    const spf = named(`hello@${DOMAIN}`, wrong, "SPF")!;
    assert.equal(spf.ok, false);
    assert.match(spf.detail, /does not include amazonses/);
  });

  test("DKIM is looked for where Resend publishes it", () => {
    assert.match(named(`hello@${DOMAIN}`, bare, "DKIM")!.name, new RegExp(DKIM_SELECTOR));
    assert.match(named(`hello@${DOMAIN}`, bare, "DKIM")!.detail, /cannot be derived/);
  });

  test("a missing bounce MX never blocks anything", () => {
    /**
     * Deliberately the weakest of the four. Mail authenticates without it; what
     * is lost is Resend hearing about bounces and complaints, which costs
     * reputation over months. Making it a refusal would mean a domain that is
     * correctly configured for delivery cannot send, which is a worse failure
     * than the one it prevents.
     */
    const noMx = { ...configured, sendMx: [] };
    assert.deepEqual(blocking(`hello@${DOMAIN}`, noMx), []);
    assert.equal(named(`hello@${DOMAIN}`, noMx, "bounce MX")!.warn, true);
  });

  test("DMARC reports going to a stranger are flagged, not fatal", () => {
    const c = named(`hello@${DOMAIN}`, configured, "DMARC reports")!;
    assert.equal(c.ok, false, "onsecureserver.net is not ours");
    assert.equal(c.warn, true);

    const ours = {
      ...configured,
      dmarcTxt: [`v=DMARC1; p=quarantine; rua=mailto:dmarc@${DOMAIN};`],
    };
    assert.equal(named(`hello@${DOMAIN}`, ours, "DMARC reports")!.ok, true);
  });

  test("no rua at all produces no line about reports", () => {
    const noRua = { ...configured, dmarcTxt: ["v=DMARC1; p=quarantine;"] };
    assert.equal(named(`hello@${DOMAIN}`, noRua, "DMARC reports"), undefined);
  });
});

describe("reading the addresses and the policy", () => {
  test("a display-name From still yields its domain", () => {
    assert.equal(domainOf("The Usability Lab <hello@theusabilitylab.com>"), "theusabilitylab.com");
    assert.equal(domainOf("hello@theusabilitylab.com"), "theusabilitylab.com");
    assert.equal(domainOf("HELLO@TheUsabilityLab.COM"), "theusabilitylab.com");
  });

  test("things that are not addresses are not domains", () => {
    for (const bad of ["", "hello", "@nope.com", "hello@", "hello@ ".trim()]) {
      assert.equal(domainOf(bad), null, JSON.stringify(bad));
    }
  });

  test("the policy is read from the record, not assumed", () => {
    assert.deepEqual(dmarcPolicy(quarantine), {
      p: "quarantine",
      rua: "mailto:dmarc_rua@onsecureserver.net",
    });
    // No `p` tag means `none` by the spec, which is the permissive reading —
    // and the permissive reading is the safe one here, because it produces a
    // warning rather than a refusal.
    assert.deepEqual(dmarcPolicy(["v=DMARC1; rua=mailto:x@y.com"]), {
      p: "none",
      rua: "mailto:x@y.com",
    });
    assert.equal(dmarcPolicy([]), null);
    assert.equal(dmarcPolicy(["v=spf1 include:amazonses.com"]), null, "not a DMARC record");
  });

  test("the domain comes from the base URL, so another deployment checks its own", () => {
    assert.equal(siteDomain("https://theusabilitylab.com"), "theusabilitylab.com");
    assert.equal(siteDomain("https://www.theusabilitylab.com/"), "theusabilitylab.com");
    assert.equal(siteDomain("http://localhost:4000"), "localhost");
    assert.equal(siteDomain(""), null);
  });
});
