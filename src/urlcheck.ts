/**
 * Is this a URL we are willing to point a browser at?
 *
 * ## Why this file did not need to exist until now
 *
 * Every URL this system has ever captured was typed by Kelly into a terminal.
 * The question flow changes that: a stranger picks the address, and `capture()`
 * fetches it with a real browser, from our machine, on our network. That makes
 * the capture step a **server-side request forgery sink** — the classic one.
 * `http://169.254.169.254/` is the cloud metadata service on AWS, GCP and Azure;
 * `http://127.0.0.1:4000/` is this server; `http://10.0.0.1/` is whatever is on
 * the LAN. Playwright would fetch any of them happily, and the findings would
 * then be published on a page.
 *
 * So the rule is: **resolve the host first, and refuse anything that points
 * inward.**
 *
 * ## What this does not stop, stated plainly
 *
 * DNS rebinding. This resolves the name once, here, and Playwright resolves it
 * again when it navigates — a name whose answer changes between the two passes
 * both checks and then connects somewhere else. The real fix is to pin the
 * address we validated and make the browser use that one, which means teaching
 * `capture.ts` about resolved IPs. That is not in this slice, and writing this
 * comment as if the hole were closed is how it stays open. **Recorded in the
 * backlog rather than only here.**
 *
 * Nor does it stop a public host that is merely unpleasant to fetch. It is a
 * guard against reaching *inward*, not a reputation service.
 *
 * ## Ports are deliberately not restricted
 *
 * Refusing anything but 80 and 443 would block the staging site on `:8080` that
 * a founder most wants looked at. With the address check above in place, the
 * remaining abuse is slow port-scanning of *public* hosts — and since a person
 * runs the queue by hand, every one of those costs an operator's decision. That
 * is the bound, and it is the thing that changes if the queue ever becomes a
 * cron.
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export type UrlRejection =
  | "not-a-url"
  | "scheme"
  | "credentials"
  | "no-host"
  | "unresolvable"
  | "private-host";

export type UrlVerdict =
  | { ok: true; url: string }
  | { ok: false; reason: UrlRejection; message: string };

/** What a visitor is told. Never echoes the URL — see `server.ts` on reflected input. */
const MESSAGES: Record<UrlRejection, string> = {
  "not-a-url": "That does not look like a web address. It should start with https://",
  scheme: "We can only audit pages served over http or https.",
  credentials: "Please give the address without a username or password in it.",
  "no-host": "That address has no site in it.",
  unresolvable: "We could not find that site. Check the spelling and try again.",
  "private-host": "That address points at a private network, so we cannot reach it from here.",
};

function refuse(reason: UrlRejection): UrlVerdict {
  return { ok: false, reason, message: MESSAGES[reason] };
}

/**
 * Every IPv4 range that is not a public host on the internet.
 *
 * Written as ranges rather than as a regex over dotted quads, because the bug
 * this file exists to prevent is an address slipping through a pattern that
 * looked right. `172.16.0.0/12` in particular is the one people get wrong —
 * it is 172.16 through 172.31, not 172.16 through 172.16.
 */
const V4_BLOCKS: [string, number][] = [
  ["0.0.0.0", 8], // "this network"
  ["10.0.0.0", 8], // private
  ["100.64.0.0", 10], // carrier-grade NAT
  ["127.0.0.0", 8], // loopback
  ["169.254.0.0", 16], // link-local — cloud metadata lives here
  ["172.16.0.0", 12], // private
  ["192.0.0.0", 24], // IETF protocol assignments
  ["192.0.2.0", 24], // documentation
  ["192.168.0.0", 16], // private
  ["198.18.0.0", 15], // benchmarking
  ["198.51.100.0", 24], // documentation
  ["203.0.113.0", 24], // documentation
  ["224.0.0.0", 4], // multicast
  ["240.0.0.0", 4], // reserved, includes 255.255.255.255
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let out = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    out = out * 256 + n;
  }
  return out;
}

/**
 * Loopback, private, link-local, multicast or reserved — for v4 and v6.
 *
 * Exported because it is the whole security property of this file, and a
 * property that only runs after a DNS round trip is a property nobody tests.
 */
export function isPrivateAddress(ip: string): boolean {
  const version = isIP(ip);
  if (version === 0) return true; // not an address at all: refuse rather than guess

  if (version === 4) {
    const value = v4ToInt(ip);
    if (value === null) return true;
    return V4_BLOCKS.some(([base, bits]) => {
      const mask = bits === 0 ? 0 : (-1 << (32 - bits)) >>> 0;
      return (value & mask) >>> 0 === (v4ToInt(base)! & mask) >>> 0;
    });
  }

  const normalised = ip.toLowerCase().split("%")[0]!; // drop any zone id
  // An IPv4-mapped or IPv4-compatible address is an IPv4 address wearing a hat.
  // `::ffff:127.0.0.1` reaches loopback, and reading it as "some v6 address"
  // is exactly how this check gets bypassed.
  const mapped = normalised.match(/^::(?:ffff:)?(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return isPrivateAddress(mapped[1]!);

  if (normalised === "::" || normalised === "::1") return true;
  if (/^f[cd][0-9a-f]{2}:/.test(normalised)) return true; // fc00::/7 unique local
  if (/^fe[89ab][0-9a-f]:/.test(normalised)) return true; // fe80::/10 link local
  if (/^ff[0-9a-f]{2}:/.test(normalised)) return true; // ff00::/8 multicast
  return false;
}

/**
 * How a hostname becomes addresses. Injected for the same reason `SlidingWindow`
 * takes a clock: the interesting cases here are ones a real resolver will not
 * produce on demand — a name answering with a public address *and* a private
 * one, which is how a DNS-based bypass actually looks. A rule that only runs
 * against whatever DNS happens to say is a rule nobody has tested.
 */
export type Resolver = (hostname: string) => Promise<{ address: string }[]>;

const realResolver: Resolver = (hostname) => lookup(hostname, { all: true });

/**
 * Parse, then resolve, then judge.
 *
 * Returns the URL as parsed rather than as typed, so what gets stored is what
 * would actually be fetched — `HTTPS://Example.COM` and `https://example.com/`
 * must not become two different rows describing one page.
 *
 * **Every** address a name resolves to is checked, not the first. A host with
 * one public and one loopback answer is a host that reaches loopback whenever
 * the resolver feels like it, and checking `[0]` would let it through most of
 * the time — which is worse than letting it through always, because it would
 * pass every manual test somebody ran.
 */
export async function checkUrl(raw: string, resolve: Resolver = realResolver): Promise<UrlVerdict> {
  const trimmed = raw.trim();
  if (!trimmed) return refuse("not-a-url");

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return refuse("not-a-url");
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return refuse("scheme");
  if (parsed.username || parsed.password) return refuse("credentials");
  if (!parsed.hostname) return refuse("no-host");

  // A literal address skips DNS entirely — and must, because `lookup` on
  // "127.0.0.1" happily returns 127.0.0.1 and would otherwise be a round trip
  // to learn what we were already told.
  const literal = parsed.hostname.replace(/^\[|\]$/g, "");
  if (isIP(literal)) {
    return isPrivateAddress(literal) ? refuse("private-host") : { ok: true, url: parsed.toString() };
  }

  let addresses: { address: string }[];
  try {
    addresses = await resolve(parsed.hostname);
  } catch {
    return refuse("unresolvable");
  }
  if (addresses.length === 0) return refuse("unresolvable");
  if (addresses.some((a) => isPrivateAddress(a.address))) return refuse("private-host");

  return { ok: true, url: parsed.toString() };
}
