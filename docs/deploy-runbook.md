# Deploy runbook — putting this behind TLS

**Written 2026-08-20** against a Cloudflare quick tunnel; **§3a added 2026-08-22**
when `theusabilitylab.com` went onto a named tunnel. Everything except §3 and §3a
applies to any host.

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

## 3a. Named tunnel — theusabilitylab.com

This is the live setup. The domain was bought at GoDaddy on 2026-08-21 and its
nameservers moved to Cloudflare (`rachel`/`reese`) on 2026-08-22; a named tunnel
requires that move, because the route is a record in a zone Cloudflare controls.

```sh
cloudflared tunnel login          # browser; authorise the theusabilitylab.com zone
cloudflared tunnel create usability-lab
cloudflared tunnel route dns usability-lab theusabilitylab.com
cloudflared tunnel run usability-lab
```

Tunnel `usability-lab` is `87b0e6e3-8e46-4bec-a985-bbaec39fecc9`. Its ingress
lives in `~/.cloudflared/config.yml`; the four deploy variables live in `.env`,
which `npm run serve` already reads, so the whole thing is two commands:

```sh
cloudflared tunnel run usability-lab   # terminal 1
npm run serve                          # terminal 2
```

Unlike a quick tunnel the hostname is stable, so the Stripe webhook is pointed
once and stays pointed. That is the entire reason to prefer it.

### The parking records

A domain moved from GoDaddy arrives with its parking records imported: two `A`
records on the apex, pointing at `13.248.243.5` and `76.223.105.230`. **Delete
them by hand in the Cloudflare dashboard before routing.** `cloudflared tunnel
route dns` refuses while they exist — *"An A, AAAA, or CNAME record with that
host already exists"* — and `--overwrite-dns` does not help, because it replaces
one record and there are two. Once they are gone the route command succeeds and
the tunnel serves immediately.

### The trap: your own resolver keeps serving the old answer

This cost forty minutes on 2026-08-22 and would cost it again.

After the records were deleted and the route was live, **this Mac kept resolving
`theusabilitylab.com` to `13.248.243.5`** — the pre-migration GoDaddy parking IP,
cached locally with a long TTL from before the nameserver move. Every check ran
against parking while the site was up. `1.1.1.1` had the correct answer the whole
time.

Three things made it read as a zone problem rather than a cache problem:

- **Parking answers 200 on every path.** `GET /` and `GET /start` both returning
  200 says nothing about which origin replied. Six consecutive "stable" 200s were
  recorded while the app was not being reached.
- **Parking's `<title>` is the domain name** — `<title>The Usability Lab</title>`,
  against our `<title>The Usability Lab — a design critique of your site, backed
  by research</title>`. Skimmed, the wrong one looks right.
- **`dig` against the authoritative nameserver looked fine**, because it *was*
  fine. Asking the right question of the wrong resolver is the whole failure.

**The one check that cannot be fooled** is which IP the connection actually
reached:

```sh
curl -sS -o /dev/null -w "connected to %{remote_ip}\n" https://theusabilitylab.com/
#   172.67.x.x / 104.21.x.x  -> Cloudflare, i.e. the tunnel
#   13.248.243.5             -> GoDaddy parking, i.e. a stale resolver
```

`cf-ray` present in the response headers says the same thing. To test the real
zone while a local cache is stale, pin the address:

```sh
curl -sSI --resolve theusabilitylab.com:443:172.67.161.65 https://theusabilitylab.com/
```

### Fixing the cache, and which cache it is

**There are two, and `dig` shows you neither of the ones that matter.** `dig`
talks to the configured nameserver directly and bypasses macOS's resolver
entirely, so it answers a question nobody asked. Measured on 2026-08-22, at the
same moment:

| Cache | Held | Seen by |
|---|---|---|
| macOS `mDNSResponder` | `13.248.243.5` (parking) | `curl`, every browser |
| the router, `192.168.0.1` | `13.248.243.5`, TTL 1603 | `dig @192.168.0.1` |
| Cloudflare `1.1.1.1` | correct | `dig @1.1.1.1` |

Reading `dig` against the authoritative nameserver and concluding the zone was
broken was the whole mistake. **Use `curl -w "%{remote_ip}"`** — it is the only
one of these that reports what an actual request did.

The macOS cache can be cleared **without a password**, by toggling the resolver
so `mDNSResponder` drops its entries and re-queries:

```sh
networksetup -setdnsservers Wi-Fi 192.168.0.1   # whatever DHCP already gave you
networksetup -setdnsservers Wi-Fi Empty         # and straight back to DHCP
```

The documented incantation needs root and a TTY, which an agent has neither of:

```sh
sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder
```

A stale **router** cannot be flushed from here at all. It expires on its own —
check the TTL with `dig @<router>` — or reboot it, or step around it by pointing
at a resolver that is already correct:

```sh
networksetup -setdnsservers Wi-Fi 1.1.1.1 1.0.0.1
```

That last one is a persistent change to the machine's network settings, so it is
a choice to make deliberately rather than a repair to apply in passing.

**A browser has the same stale cache.** Anyone testing the site the day of a
nameserver move will see parking and report the deploy broken.

### www, and one host per site

`www` was routed to the tunnel by the GoDaddy import — as a `CNAME` to the apex,
which now flattens onto the tunnel — but it was not in the ingress, so it reached
the catch-all and returned **404 from `server: cloudflare`**.

Both halves are now handled, **in the repo rather than in the dashboard**:

- `~/.cloudflared/config.yml` has a second ingress entry sending
  `www.theusabilitylab.com` to the same process.
- `server.ts` redirects any non-canonical host to `BASE_URL` before routing —
  **308 for every method alike**, because a 301 lets a client rewrite the method
  to `GET` and a misaddressed webhook would then be silently dropped rather than
  redirected. The `one host, one site` suite in `server.test.ts` holds all of it.

  *(Corrected 2026-08-24. This said "301 for `GET`/`HEAD`, 308 for anything with
  a body", which was true when it was written and is not true of the code. The
  conditional was removed as a branch written for a case that cannot occur —
  Stripe is configured on the canonical host — and `server.ts` says so where the
  status is written. Caught by re-verifying §9 on a new machine and reading 308
  where the doc predicted 301.)*

A Cloudflare Single Redirect rule would have done the same job with no code, and
survives the tunnel being down. It was rejected for one reason: **nothing in git
would know it existed**, and nothing would fail if it were deleted. That is the
B27 shape — state that changes without leaving a record — and this project has
already paid for that once.

Serving the app on both hostnames instead of redirecting is the wrong answer
regardless of where the rule lives. `ul_full` is scoped to the host that set it
and magic links are built from `BASE_URL`, always the apex — so a visitor who
signed in on `www` would follow their link to a host that had never seen their
cookie, and be asked to sign in again, for ever.

### The magic link was addressed to localhost

Found while wiring the above, on 2026-08-22. Nothing in `server.ts` read
`USABILITY_LAB_BASE_URL`; the link was built from `http://localhost:${PORT}`
unconditionally. On a laptop that is correct and invisible. The day the site
became reachable at `theusabilitylab.com` it became a bearer credential
addressed to a machine the recipient does not have — and, once mail is actually
sent rather than printed, one that would travel over plain http.

The existing tests could not have caught it: they *follow* the printed link, and
`localhost` and `127.0.0.1` reach the same server from the test process. The
assertion has to be on the text of the link, not on whether following it works.

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

## 6a. Mail that reaches somebody other than you

Until the domain is verified in Resend, `USABILITY_LAB_MAIL_FROM` is unset and
mail goes out as `onboarding@resend.dev`. Resend delivers that **only to the
address that owns the account**. Everyone else gets nothing — no bounce, no
error, no row anywhere. Since a magic link is the only way into a paid account,
the product cannot sign up a stranger until this is done.

Run `npm run mail:check` first. It reads the live DNS and says which of the
records exist.

### What is already in the zone, and what it means

`theusabilitylab.com` carries a DMARC record inherited from GoDaddy:

```
v=DMARC1; p=quarantine; adkim=r; aspf=r; rua=mailto:dmarc_rua@onsecureserver.net;
```

`p=quarantine` is an instruction to receivers to junk mail from this domain that
does not authenticate, and nothing here authenticates yet — there is no SPF and
no DKIM. It has been harmless only because the `From:` is somebody else's
domain. The `rua` is worth changing too: DMARC failure reports about this
domain's mail currently go to an address at the registrar that nobody here
reads.

### The order, and the thing that makes it safe

1. **Resend** → Domains → Add `theusabilitylab.com`. It prints three records.
2. **Cloudflare** → DNS → add all three. They will be roughly:
   - `TXT  send   v=spf1 include:amazonses.com ~all`
   - `TXT  resend._domainkey   p=MIGfMA0GCSq...` — **unique per domain, copy it,
     it cannot be derived or guessed**
   - `MX   send   feedback-smtp.<region>.amazonses.com   priority 10`
   Set all three to **DNS only** (grey cloud). Proxying a TXT record is not a
   thing, but the MX will break if it is orange.
3. **Resend** → Verify. `npm run mail:check` should then show SPF and DKIM ok.
4. **Only now** set `USABILITY_LAB_MAIL_FROM` in `.env` and restart the server.

Getting step 4 wrong is safe, and this was measured rather than assumed — one
request with an unverified From returns:

```
403  The theusabilitylab.com domain is not verified.
     Please, add and verify your domain on https://resend.com/domains
```

So Resend refuses; the mistake is loud and stops at the API. **The dangerous
state is the opposite one**, and it is why `mail:check` exists: verification is
something Resend performs once, and afterwards the sends are accepted. Records
pruned out of Cloudflare later, or a zone rebuilt without them, leave mail going
out unsigned against that `p=quarantine` — accepted by Resend, logged as a
success by the server, and quarantined by every receiver. Nothing in this system
can see that happen.

### Proving it, which `mail:check` cannot do

DNS says the records exist. Only a real message says one arrives:

```sh
# From an address outside this Resend account
curl -s -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer $RESEND_API_KEY" -H "Content-Type: application/json" \
  -d '{"from":"hello@theusabilitylab.com","to":["<somewhere-else>"],
       "subject":"auth probe","text":"probe"}'
```

Then open the message's headers and read `Authentication-Results`. It must say
**`dkim=pass`** and **`spf=pass`**, and `dmarc=pass`. Anything less is a message
that was delivered today on reputation and will be junked later.

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

## 9. What was verified on 2026-08-22, on the named tunnel

Run and observed, with the address pinned past the stale local resolver
(`--resolve theusabilitylab.com:443:172.67.161.65`):

- Four edge connections registered — `bos01`, `bos03`, `iad22` ×2, protocol quic.
- `GET /`, `/start`, `/s/inter.woff2`: **200, HTTP/2, `server: cloudflare`, `cf-ray` present.**
- `GET /nonexistent-path-xyz`: **404.** This is the check worth keeping — GoDaddy
  parking answers 200 on every path, so a 404 on a made-up path is what proves
  our app is the origin, and a 200 on `/` is not.
- Certificate `CN=theusabilitylab.com`, issued by Google Trust Services WE1,
  **verify ok**, ALPN `h2`.
- Preflight passed with all four variables from `.env`; signing key reported as
  generated in `out/.secret`, which persists on this Mac (§5).
- The LAN address `192.168.0.110:4000`: **connection refused**, so
  `USABILITY_LAB_BIND=127.0.0.1` still holds on this configuration.
- `www`: **301 to `https://theusabilitylab.com/start?ref=test`** from
  `https://www.theusabilitylab.com/start?ref=test` — path and query intact.
  *(Re-measured 2026-08-24: it is a **308**, and always was by the time anyone
  read this. See the correction in §3a.)*

**This Mac's Wi-Fi DNS was set to `1.1.1.1`/`1.0.0.1`** to get past the stale
router, which was holding the parking record with ~27 minutes left on its TTL.
Clearing only the macOS cache did not hold — `mDNSResponder` re-queried the
router and got the same stale answer straight back. Undo with
`networksetup -setdnsservers Wi-Fi Empty` once the router has moved on; nothing
about the deploy depends on it.

### Probed from the internet, which was never possible before

Every operator surface, every guess at an index, and the unpublished audit
`e338784b` — **404 across the board**:

```
/funnel  /funnel.html  /out/funnel.html  /out/usability-lab.db  /.env
/package.json  /src/server.ts  /a  /a/  /audits  /admin
/a/e338784b-…/  /a/e338784b-…/full  /a/e338784b-…/…-annotated.png
```

**Those 404s mean nothing without the control**, because a route that is simply
broken 404s just as convincingly. So, against a *published* audit:

| Request | Result |
|---|---|
| `/a/0e1456d9-…/` | **200** — the preview is reachable |
| `/a/0e1456d9-…/0e1456d9-…-annotated.png` | **200** |
| `/a/0e1456d9-…/full` | **403** — still behind the token |
| `/a/0e1456d9-…/../../../etc/passwd` | 404 |
| `…/..%2f..%2f..%2fetc%2fpasswd` | 400 |
| `/a/0e1456d9-…/capture.json`, `findings.json`, `review.json` | 404 |
| an *other* audit's PNG under this audit's id | 404 |

Headers on `/`, `/start` and a published preview: `default-src 'none'`,
`script-src` pinned to a sha256 hash, `referrer-policy: no-referrer` — which is
the one that keeps a magic-link token out of the `Referer` on an outbound click —
and `x-content-type-options: nosniff`.

### Two header gaps this deploy created, both now closed

Neither mattered on a laptop.

**`frame-ancestors 'none'`** is now in `STRICT_CSP`, which `MARKETING_CSP` and
both script-bearing policies derive from — so one line covered all three. It is
worth knowing *why* it had to be written at all: `frame-ancestors` is one of the
few directives with **no fallback to `default-src`**, so a policy opening with
`default-src 'none'` still permits framing. Read quickly the line looks
redundant; deleted, every page here is frameable, including the one carrying the
subscribe button.

**`Strict-Transport-Security: max-age=31536000; includeSubDomains`** is set at
the top of `handle()` rather than in `send()`, deliberately: the responses most
likely to be a visitor's *first* are the ones that never reach a page helper — a
404 from a mistyped link, and the `www` redirect. The first request is the only
one HSTS protects. **No `preload`**, which is a submission to a list compiled
into browser binaries and takes months to leave.

Sent only when the base URL claims https. A browser ignores the header over
plain http anyway, so the gate is about not writing a false promise into a local
response.

Verified live on `/`, `/start`, a published preview, a 404 and the `www` 308.

**Not re-verified, deliberately.** The `cf-connecting-ip` rate-limit buckets were
proved on 2026-08-20 and re-proving them means six `POST /request` calls, which
write six `audit_requests` rows and move every funnel number. The header is
delivered by Cloudflare, not by the tunnel type, and the app's side of it is
covered hermetically by `clientip.test.ts`. Worth folding into Session A's ugly
paths, where the resubmit cooldown exercises the same limiter for a reason.

---

## 10. Restoring the deploy on a different machine — 2026-08-24

The repo and `out/` moved to a new Mac; the site answered **530** (Cloudflare
1033, origin unreachable) on every path while DNS resolved correctly. `cloudflared
tunnel list` showed `usability-lab` alive with **zero connections**, which is the
same fact from the other side.

**What did not come across, and neither is in the repo:** `~/.cloudflared/`
(the `cert.pem`, the credentials JSON, and `config.yml` holding both ingress
entries) and the `cloudflared` binary itself. `out/` did come across, which
matters more than it sounds — `out/.secret` is the signing key, and a regenerated
one silently invalidates every magic link and session ever issued (§5).

**The ingress now lives in the repo**, at `deploy/cloudflared-config.yml`, and is
passed explicitly. §3a rejected a Cloudflare dashboard redirect rule because
"nothing in git would know it existed" — and then put the tunnel's own ingress in
an untracked dotfile with exactly that problem. This is that argument applied to
itself. `credentials-file` is deliberately not named: it would be an absolute
path with a username in it, and with `tunnel:` set cloudflared defaults to
`~/.cloudflared/<UUID>.json` on any machine.

```sh
# No Homebrew on the new machine, and it is one binary
curl -sSL -o cf.tgz https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-arm64.tgz
tar xzf cf.tgz && mv cloudflared ~/.local/bin/ && chmod +x ~/.local/bin/cloudflared

cloudflared tunnel login          # browser; authorise the theusabilitylab.com zone

# Credentials for the EXISTING tunnel. Creating a new one would mean re-routing
# DNS, and the apex already points at 87b0e6e3-8e46-4bec-a985-bbaec39fecc9.
cloudflared tunnel token --cred-file ~/.cloudflared/87b0e6e3-8e46-4bec-a985-bbaec39fecc9.json usability-lab

npm run serve                     # terminal 1 — start the origin first, or the tunnel 502s
cloudflared tunnel --config deploy/cloudflared-config.yml run usability-lab   # terminal 2
nohup npm run worker >> .logs/worker.log 2>&1 &                              # terminal 3
```

**`tunnel login` needs the Authorize click, not just a login.** The first attempt
sat at `Waiting for login...` for eight minutes and exited 1 with "Failed to
fetch resource" — the dashboard was open, the zone was never authorised. The
callback URL is single-use, so a retry needs a fresh one.

**`--config` goes before the subcommand** — `tunnel --config X run`, not
`tunnel run --config X`. The latter is accepted and ignored, and prints usage
instead of failing, which reads like a flag that did nothing rather than an
error.

### Verified live, 2026-08-24

```
/                        200, http/2, remote_ip 104.21.34.128, server: cloudflare
/nonexistent-path-xyz    404      <- the check that matters; parking answers 200 everywhere
/start                   200
www/start?ref=test       308 -> https://theusabilitylab.com/start?ref=test
<title>                  The Usability Lab — a design critique of your site, backed by research
headers                  CSP default-src 'none' + frame-ancestors 'none', HSTS
                         max-age=31536000, referrer-policy: no-referrer, nosniff
```

Preflight passed on all four variables and reported the signing key as the
existing `out/.secret`, so no link issued before the move was invalidated.

**Not re-verified**, for the same reason as §9: the `cf-connecting-ip` rate-limit
buckets, which cost six `POST /request` rows and move every funnel number. The
app's side is covered hermetically by `clientip.test.ts`.

## 11. The worker, which this runbook never started — 2026-08-26

The third line in §10's block is new. For the four days before it existed, the
queue worker was not part of the deploy at all: it was a background command of a
Claude session, launched once on **Aug 24 at 20:08** and never restarted.

Nothing looked wrong. The site answered 200, the tests were green, and the
worker's own log for two days was the single line `Nothing queued.` repeated —
it had no work, so it never had a chance to be wrong out loud.

But `tsx` resolves modules at process start. That worker was running the tree as
it stood on Aug 24, which meant that on Aug 26 the deployed queue runner still
had:

- the pre-B36 capture, so any container-scrolled page would be screenshotted at
  viewport height and audited on a quarter of itself;
- pins clamped to the crop line, with no `offImage` count and no degraded note
  to say so;
- no `audit.held` event, so a hold would again leave the reason in a stdout
  nobody reads.

Every one of those was fixed, committed, and pushed on Aug 25. None of them were
*running*. The repo being green said nothing about the processes.

**Why it stayed invisible:** the only PostHog run that exercised the fixed code
was started in the foreground, by hand, to check the fix. It produced a correct
full-page capture and was taken as proof the fix was live. It proved the fix was
in the *repo*. The worker was never in the sample.

**What to check, and it takes one line.** `ps` prints the start time; compare it
to the last commit that touches the pipeline:

```sh
ps -p "$(pgrep -f 'tsx src/worker.ts')" -o lstart=
git log -1 --format=%ad --date=iso -- src/ 
```

If the process is older than the code, it is not running the code. The same
question applies to `npm run serve`, and applies every time either is left up
across a session.
