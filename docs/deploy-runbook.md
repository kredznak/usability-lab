# Deploy runbook — putting this behind TLS

**Written 2026-08-20**, against a Cloudflare quick tunnel. Everything except the
last section applies to any host.

---

## 1. What the deploy blocker actually was

"HTTPS" was three things wearing one name, and only the first was obvious.

| | Why it blocks |
|---|---|
| **TLS** | The magic link is a bearer credential in a URL on first use. |
| **`USABILITY_LAB_SECURE_COOKIES=1`** | `ul_full` is a bearer cookie. Without the flag it looks and behaves identically, right up until somebody is on a network that can read it. |
| **`USABILITY_LAB_CLIENT_IP_HEADER`** | `asksByClient` allows five audit requests an hour **per client**, keyed on the connecting socket. Behind any proxy every request arrives from that proxy, so five an hour becomes the budget for the whole internet and the sixth visitor of the hour is refused. |

The third was the surprise. It is not hardening — it is the site failing on day
one, and failing in a way that reads as a broken router rather than a
misconfiguration.

**`npm run serve` now refuses to start** if `USABILITY_LAB_BASE_URL` begins
`https://` and either of the other two is unset. It names the variable and the
consequence. See `src/preflight.ts` for why refusing beats warning: both faults
are invisible when wrong, and a warning printed at boot is read once.

---

## 2. The variables

```sh
USABILITY_LAB_BASE_URL=https://<your-host>       # also where Stripe returns to
USABILITY_LAB_SECURE_COOKIES=1                   # mandatory once the above is https
USABILITY_LAB_CLIENT_IP_HEADER=cf-connecting-ip  # mandatory once the above is https
USABILITY_LAB_BIND=127.0.0.1                     # proxy-only; see §4
USABILITY_LAB_SECRET=<64 hex chars>              # see §5 — required off this machine
ANTHROPIC_API_KEY=...                            # only the audit runner needs it
```

Nothing is trusted by default. With `USABILITY_LAB_CLIENT_IP_HEADER` unset the
server reads the connecting socket exactly as it always has, and a forged
`X-Forwarded-For` is ignored — which is the behaviour `clientip.test.ts` guards
first, because the obvious fix for the rate limiter is worse than the bug.

**Name `cf-connecting-ip`, not `x-forwarded-for`.** Cloudflare writes a single
value and overwrites whatever the client sent. `X-Forwarded-For` is a list
appended left to right, so the correct entry depends on how many proxies you
have; `clientIp` takes the rightmost, which is right for exactly one hop and
wrong the day a second appears.

---

## 3. Cloudflare quick tunnel

```sh
brew install cloudflared

# Terminal 1 — the tunnel. Prints a random https://<words>.trycloudflare.com
cloudflared tunnel --url http://127.0.0.1:4000 --no-autoupdate

# Terminal 2 — the server, told the hostname the tunnel just printed
USABILITY_LAB_BASE_URL=https://<words>.trycloudflare.com \
USABILITY_LAB_SECURE_COOKIES=1 \
USABILITY_LAB_CLIENT_IP_HEADER=cf-connecting-ip \
USABILITY_LAB_BIND=127.0.0.1 \
npm run serve
```

Tunnel first: it needs no server to hand you a hostname, and the server needs
the hostname.

**A quick tunnel is disposable.** No account, a new random hostname each time,
and it dies with the process. That makes it right for testing Stripe against a
real account, for letting the pipeline audit its own homepage, and for showing
someone — and wrong for anything you would print on a business card. A named
tunnel on a domain you own is the next step, and changes nothing above except
the hostname.

---

## 4. Bind to loopback, and why it is not optional here

`server.listen(PORT)` alone accepts connections on **every interface**. Behind a
tunnel that means the app also answers on your LAN, over plain http — and with
`USABILITY_LAB_SECURE_COOKIES=1` set, the gate cookie is marked `Secure` and so
is never sent over that connection at all. Anyone on the network gets a site
where signing in silently does nothing.

Worse: `USABILITY_LAB_CLIENT_IP_HEADER` is trusted on every request. Reachable
directly, anyone can set that header to whatever they like and have their own
rate-limit bucket per request.

`USABILITY_LAB_BIND=127.0.0.1` closes both. Verified: with it set, the LAN
address refuses connections and the tunnel still serves.

---

## 5. The signing key, which fails silently and totally

`tokens.ts` reads `USABILITY_LAB_SECRET`, and **generates one into `out/.secret`
if it is unset**. On this Mac that file persists and everything is fine — the
preflight says which one is in use on every boot.

On any host without a persistent volume it is regenerated on each deploy, and
**every magic link and every session ever issued stops verifying at once.** No
error, no log line: customers simply report that their links stopped working.

So off this machine, set it explicitly:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Same rule for `out/` generally: it holds the SQLite database, every capture, and
every annotated screenshot the server serves. It is state, not cache.

---

## 6. Stripe, once a public URL exists

This is what unblocks **B21**. `docs/stripe-runbook.md` has the full walkthrough;
the only thing the tunnel changes is the webhook endpoint:

```
https://<your-host>/stripe/webhook
```

Subscribed to `customer.subscription.created`, `.updated` and `.deleted` — **not**
`checkout.session.completed`, which carries no period end and locks out every
customer who pays. Then `npm run stripe:check`.

A quick tunnel's hostname changes every restart, so the webhook has to be
re-pointed each session. That alone is a good argument for a named tunnel before
doing much Stripe work.

---

## 7. Auditing our own homepage

**B24.** The capture path refuses private addresses — not just `/request`, so a
CLI run by the machine's owner is refused too. That is deliberate and stays.
With a public URL it just works:

```sh
npm run audit -- https://<your-host>/ --answers <answers.json>
```

Then read every finding and fix what is real, before putting one on the page.
The placeholder card in `marketing.ts` says it is a placeholder; that line comes
out when the finding is genuine.

---

## 8. What was actually verified on 2026-08-20

Not inferred — run and observed:

- `GET /`, `/start` and `/s/inter.woff2` over the tunnel: **200, HTTP/2, certificate verified**.
- The LAN address with `USABILITY_LAB_BIND=127.0.0.1`: **connection refused**.
- Cloudflare delivers `cf-connecting-ip` (a single value), `x-forwarded-for`, and `x-forwarded-proto: https`.
- Rate limiting with the header configured: six requests from one address → the sixth is **429**; a request from a second address immediately after → **400**, unthrottled. Separate buckets.
- Rate limiting with the header **unset**: six requests from six *different* addresses → the sixth is **429**. Both the collapse this fixes and proof that a spoofed header is ignored by default.
- `USABILITY_LAB_BASE_URL=https://…` with neither variable set: **exit code 2**, both reasons printed.
