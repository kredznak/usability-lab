import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkUrl, isPrivateAddress } from "./urlcheck.js";

/**
 * The guard that faces strangers.
 *
 * Every other check in this codebase protects a customer from a bad audit. This
 * one protects *us* from a URL, and it is the only place where being wrong once
 * means a stranger reads our cloud metadata. So the address table gets tested
 * range by range rather than by a couple of representative examples — the whole
 * failure mode of a check like this is the one row somebody typed slightly wrong.
 */

describe("addresses that point inward", () => {
  test("loopback, in every spelling it has", () => {
    for (const ip of ["127.0.0.1", "127.1.2.3", "127.255.255.254", "::1", "::ffff:127.0.0.1"]) {
      assert.ok(isPrivateAddress(ip), ip);
    }
  });

  test("cloud metadata", () => {
    // The single most-attacked address on the internet. If one line of this
    // file has to be right, it is this one.
    assert.ok(isPrivateAddress("169.254.169.254"));
  });

  test("the RFC 1918 ranges, at their edges", () => {
    for (const ip of [
      "10.0.0.0", "10.255.255.255",
      "172.16.0.0", "172.31.255.255",
      "192.168.0.0", "192.168.255.255",
    ]) {
      assert.ok(isPrivateAddress(ip), ip);
    }
  });

  test("172.16/12 stops at 172.31, and 172.32 is public", () => {
    // The range people get wrong. 172.15 and 172.32 are ordinary internet.
    assert.ok(isPrivateAddress("172.20.1.1"));
    assert.ok(!isPrivateAddress("172.15.255.255"));
    assert.ok(!isPrivateAddress("172.32.0.1"));
  });

  test("carrier NAT, link-local, multicast, reserved", () => {
    for (const ip of ["100.64.0.1", "169.254.1.1", "224.0.0.1", "255.255.255.255", "0.0.0.0"]) {
      assert.ok(isPrivateAddress(ip), ip);
    }
  });

  test("IPv6 unique-local, link-local and multicast", () => {
    for (const ip of ["fc00::1", "fd12:3456::1", "fe80::1", "fe80::1%eth0", "ff02::1", "::"]) {
      assert.ok(isPrivateAddress(ip), ip);
    }
  });

  test("an IPv4 address wearing a v6 hat is still that address", () => {
    assert.ok(isPrivateAddress("::ffff:10.0.0.1"));
    assert.ok(isPrivateAddress("::ffff:169.254.169.254"));
    assert.ok(!isPrivateAddress("::ffff:93.184.216.34"));
  });

  test("ordinary public addresses are allowed through", () => {
    for (const ip of ["93.184.216.34", "8.8.8.8", "1.1.1.1", "2606:2800:220:1:248:1893:25c8:1946"]) {
      assert.ok(!isPrivateAddress(ip), ip);
    }
  });

  test("something that is not an address at all is refused, not guessed at", () => {
    for (const junk of ["", "not-an-ip", "999.1.1.1", "10.0.0"]) {
      assert.ok(isPrivateAddress(junk), junk);
    }
  });
});

describe("what a visitor is allowed to submit", () => {
  test("a literal private address is refused without a DNS round trip", async () => {
    for (const url of [
      "http://127.0.0.1:4000/",
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]:8080/",
      "https://10.0.0.5/admin",
    ]) {
      const verdict = await checkUrl(url);
      assert.equal(verdict.ok, false, url);
      assert.equal(verdict.ok === false && verdict.reason, "private-host", url);
    }
  });

  test("only http and https", async () => {
    for (const url of ["file:///etc/passwd", "javascript:alert(1)", "ftp://example.com/", "data:text/html,x"]) {
      const verdict = await checkUrl(url);
      assert.equal(verdict.ok, false, url);
      assert.equal(verdict.ok === false && verdict.reason, "scheme", url);
    }
  });

  test("credentials in the URL are refused", async () => {
    // Playwright would send them. They are also the oldest way to make an
    // address read as one host while resolving as another.
    const verdict = await checkUrl("http://user:pass@example.com/");
    assert.equal(verdict.ok === false && verdict.reason, "credentials");
  });

  test("nonsense is not a URL", async () => {
    for (const junk of ["", "   ", "example.com", "just some words"]) {
      const verdict = await checkUrl(junk);
      assert.equal(verdict.ok, false, JSON.stringify(junk));
      assert.equal(verdict.ok === false && verdict.reason, "not-a-url", JSON.stringify(junk));
    }
  });

  test("a name is refused if ANY of its addresses points inward", async () => {
    /**
     * The bypass this is really about. A name that answers with a public
     * address first and a loopback second passes a `[0]` check most of the
     * time — and "most of the time" is worse than never, because it survives
     * every manual check somebody thinks to run.
     */
    const both = async () => [{ address: "93.184.216.34" }, { address: "127.0.0.1" }];
    const verdict = await checkUrl("https://sneaky.example/", both);
    assert.equal(verdict.ok, false);
    assert.equal(verdict.ok === false && verdict.reason, "private-host");
  });

  test("a name that resolves only to public addresses is allowed", async () => {
    const publicOnly = async () => [{ address: "93.184.216.34" }, { address: "8.8.8.8" }];
    assert.equal((await checkUrl("https://ordinary.example/", publicOnly)).ok, true);
  });

  test("a name that resolves to nothing at all is refused", async () => {
    const empty = async () => [];
    const verdict = await checkUrl("https://ghost.example/", empty);
    assert.equal(verdict.ok === false && verdict.reason, "unresolvable");
  });

  test("a name that does not resolve is refused, not attempted", async () => {
    // `.invalid` is reserved by RFC 2606 precisely so it can never resolve,
    // which makes this the one DNS assertion here that cannot go flaky.
    const verdict = await checkUrl("https://nothing.invalid/");
    assert.equal(verdict.ok === false && verdict.reason, "unresolvable");
  });

  test("what comes back is what would be fetched, not what was typed", async () => {
    const verdict = await checkUrl("  HTTP://93.184.216.34  ");
    assert.equal(verdict.ok, true);
    assert.equal(verdict.ok && verdict.url, "http://93.184.216.34/");
  });

  test("no refusal echoes the address back", async () => {
    // A message that quotes the URL is a reflection point, and this one is
    // rendered into HTML on a page a stranger controls the input to.
    const verdict = await checkUrl("javascript:alert('<img src=x onerror=1>')");
    assert.equal(verdict.ok, false);
    assert.ok(verdict.ok === false && !verdict.message.includes("<"));
    assert.ok(verdict.ok === false && !verdict.message.includes("alert"));
  });
});
