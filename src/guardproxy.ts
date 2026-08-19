/**
 * The browser's only way out — B19.
 *
 * ## What it closes
 *
 * `checkUrl` decides whether a URL may be queued. Playwright then resolves the
 * name again, minutes or hours later, and connects to whatever it gets. A host
 * that answers publicly for the first lookup and `169.254.169.254` for the
 * second passes the check and reaches the cloud metadata service — and its
 * response is rendered into a screenshot we publish back to the person who
 * chose the URL. That is the whole attack, and it survives every check written
 * so far.
 *
 * ## Why a proxy and not `--host-resolver-rules`
 *
 * Chromium can be told `MAP host ip`, which is two lines and pins the hosts you
 * name. It does not pin the ones you cannot name: a redirect to a second host,
 * an `<iframe src>`, an image, an XHR. An iframe pointed at an internal address
 * renders into the screenshot exactly like the main document would, so pinning
 * only the document leaves the interesting half open.
 *
 * Everything the page does goes through a proxy. That is the difference.
 *
 * ## Why there is no TLS interception
 *
 * `CONNECT host:443` tells us the host without decrypting anything. We resolve
 * it, refuse or connect, and then move bytes. The browser's handshake stays
 * end-to-end, certificates still validate against the real hostname, and this
 * process never holds a key or sees a plaintext byte of anyone's traffic.
 *
 * ## What is tested here, and what is tested elsewhere
 *
 * **The policy** — which addresses are private — lives in `urlcheck.ts` and is
 * tested there, range by range. **The plumbing** is tested here. They are
 * separate on purpose, because any test server this file could start would sit
 * on loopback, which is precisely what the policy refuses. So `isBlocked` is
 * injectable and the tests swap it to reach a local server. That injection
 * tests the wiring; it does not weaken the rule, which has its own tests and
 * its own file.
 */

import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { connect, type Socket } from "node:net";
import { resolveGuarded, isPrivateAddress, type Resolver } from "./urlcheck.js";

export interface Refusal {
  host: string;
  reason: string;
}

export interface GuardProxy {
  /** Pass to Playwright as `proxy.server`. */
  url: string;
  /** Everything it turned away, in order. Empty is the expected case. */
  refusals: Refusal[];
  close(): Promise<void>;
}

export interface ProxyOptions {
  /** Injectable for tests — see the file note. */
  resolve?: Resolver;
  /** Injectable for tests — see the file note. Defaults to the real rule. */
  isBlocked?: (ip: string) => boolean;
}

/** `example.com:443`, or `[::1]:443`. */
function splitHostPort(authority: string, fallbackPort: number): { host: string; port: number } {
  const bracketed = authority.match(/^\[(.+)\]:(\d+)$/);
  if (bracketed) return { host: bracketed[1]!, port: Number(bracketed[2]) };
  const colon = authority.lastIndexOf(":");
  if (colon > 0 && /^\d+$/.test(authority.slice(colon + 1))) {
    return { host: authority.slice(0, colon), port: Number(authority.slice(colon + 1)) };
  }
  return { host: authority.replace(/^\[|\]$/g, ""), port: fallbackPort };
}

export async function startGuardProxy(options: ProxyOptions = {}): Promise<GuardProxy> {
  const refusals: Refusal[] = [];
  const blocked = options.isBlocked ?? isPrivateAddress;

  /**
   * Resolve, judge, and return the address to dial.
   *
   * The policy is handed to `resolveGuarded` rather than applied after it. The
   * first version applied it after, which meant an injected policy never
   * governed — `resolveGuarded` had already refused with the real rule — and
   * the allow-path test failed with a 403 that looked like the feature working.
   *
   * Connecting to the returned address, never to the hostname, is what makes
   * this a pin rather than one more check something else re-resolves around.
   */
  async function pin(host: string): Promise<{ ok: true; address: string } | { ok: false; reason: string }> {
    const verdict = await resolveGuarded(host, options.resolve, blocked);
    return verdict.ok
      ? { ok: true, address: verdict.address }
      : { ok: false, reason: verdict.reason };
  }

  const server: Server = createServer();

  // --- plain http --------------------------------------------------------
  server.on("request", async (req: IncomingMessage, res: ServerResponse) => {
    let target: URL;
    try {
      // A proxied request carries an absolute URI. Anything else is not a
      // request this server has any business answering.
      target = new URL(req.url ?? "");
    } catch {
      res.writeHead(400).end("proxy expects an absolute URI");
      return;
    }

    const verdict = await pin(target.hostname);
    if (!verdict.ok) {
      refusals.push({ host: target.hostname, reason: verdict.reason });
      res.writeHead(403).end("refused by the capture guard");
      return;
    }

    const headers = { ...req.headers };
    delete headers["proxy-connection"];
    // The Host header keeps the site's name so virtual hosting still works; the
    // socket goes to the address we validated.
    headers.host = target.host;

    const upstream = httpRequest(
      {
        host: verdict.address,
        port: Number(target.port || 80),
        method: req.method,
        path: `${target.pathname}${target.search}`,
        headers,
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    upstream.on("error", () => {
      if (!res.headersSent) res.writeHead(502);
      res.end();
    });
    req.pipe(upstream);
  });

  // --- https, without opening it -----------------------------------------
  server.on("connect", (req: IncomingMessage, clientSocket: Socket, head: Buffer) => {
    const { host, port } = splitHostPort(req.url ?? "", 443);

    void pin(host).then((verdict) => {
      if (!verdict.ok) {
        refusals.push({ host, reason: verdict.reason });
        clientSocket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
        return;
      }
      const upstream = connect({ host: verdict.address, port }, () => {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head?.length) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      // Both directions get an error handler, because an unhandled socket error
      // takes the whole process down and this one talks to strangers.
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
    });
  });

  // Loopback only. A guard proxy reachable from the network is an open proxy,
  // and an open proxy that resolves hosts for you is a gift.
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    refusals,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}
