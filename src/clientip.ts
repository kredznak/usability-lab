/**
 * Which address a request should be rate limited against.
 *
 * ## Why this is not just `req.socket.remoteAddress`
 *
 * It was, and it was right, for as long as nothing sat in front of the server.
 * `asksByClient` allows five audit requests an hour per client and keys on the
 * connecting socket — honest on localhost, and **the proxy's address** the
 * moment anything terminates TLS in front. Every visitor then shares one
 * bucket, and the sixth request from anyone on earth is refused. A per-client
 * limit becomes a per-site one without changing shape or looking wrong.
 *
 * ## Why it is not `X-Forwarded-For` either
 *
 * `server.ts` has carried this since B16: trusting a header the client sets
 * turns a per-client limit into a per-header-value limit, which is no limit at
 * all. Anyone wanting a hundred audits sends a hundred values.
 *
 * ## So: named, or nothing
 *
 * The header is read only when an operator sets `USABILITY_LAB_CLIENT_IP_HEADER`
 * to its name, which is the same bargain as `USABILITY_LAB_SECURE_COOKIES` —
 * whatever terminates TLS has to be taught to us explicitly, because guessing
 * in either direction is worse than asking. Unset, this behaves exactly as the
 * server did before it existed, and a forged header is ignored.
 *
 * Read per call rather than at import, so the tests can cover every case in one
 * process instead of spawning one each. It is a single env lookup per request.
 */

/** Named here so the tests cannot drift from the variable they are asserting. */
export const CLIENT_IP_HEADER_VAR = "USABILITY_LAB_CLIENT_IP_HEADER";

/**
 * Long enough for IPv6 with a zone and a port, short enough that a header
 * cannot become a large key.
 *
 * The value goes straight into a `SlidingWindow`'s `Map`, and B16's lesson was
 * that an attacker-chosen key must never be able to grow an unbounded map. A
 * 4KB header would do it 64 bytes at a time. Over-long values fall back to the
 * socket, which is the safe direction: the limit gets coarser, never absent.
 */
const MAX_ADDRESS = 64;

type Readable = {
  socket: { remoteAddress?: string | undefined };
  headers: Record<string, string | string[] | undefined>;
};

export function clientIp(req: Readable): string {
  const socket = req.socket.remoteAddress ?? "unknown";

  const name = process.env[CLIENT_IP_HEADER_VAR];
  if (!name) return socket;

  const raw = req.headers[name.trim().toLowerCase()];
  if (raw === undefined) return socket;

  /**
   * The **last** entry, not the first.
   *
   * `X-Forwarded-For` reads `client, proxy1, proxy2`, appended left to right.
   * The leftmost is what the original caller claimed and is freely forgeable;
   * the rightmost is what the nearest proxy actually observed. With exactly one
   * trusted hop — which is what a single TLS terminator is — that is the peer.
   *
   * `docs/deploy-runbook.md` names `cf-connecting-ip` instead, precisely so
   * there is no hop counting to get wrong: Cloudflare writes one value and
   * overwrites whatever the client sent.
   */
  const parts = (Array.isArray(raw) ? raw.join(",") : raw).split(",");
  const last = parts[parts.length - 1]?.trim() ?? "";

  if (last.length === 0 || last.length > MAX_ADDRESS) return socket;
  return last;
}
