# Stripe: the half hour that closes B21

Everything Stripe-shaped in this repo is built and tested **except one thing**:
no request has ever been sent to Stripe. This is how that changes. It needs a
Stripe account and about thirty minutes; nothing in it can be done without one,
which is why it is a document rather than a test.

Nothing here touches real money. Test mode uses a separate set of keys and a
separate dashboard, and the only card involved is Stripe's fake one.

> **What was done instead, and why it is not enough** — 2026-08-19.
> `src/stripe-live.test.ts` sends the real requests to `stripe-mock`, Stripe's
> own server built from their OpenAPI spec. That is why the form encoding, the headers, the paging and the response
> parsing are no longer on my word. Two things it cannot do, and both are why
> this document still exists:
>
> - **It validates top-level parameter names only.** Measured:
>   `line_itemz[0][price]` → 400, but `line_items[0][quantityy]` → 200. So a typo
>   in `subscription_data[metadata]` — the key access is granted by — sails
>   straight through.
> - **It never charges, never delivers a webhook, and never gives your metadata
>   back.** The whole grant path, from `checkout.session.completed` to a row with
>   a non-null `current_period_end`, is untested until step 6 below.
>
> If you are reading this hoping to skip step 6: step 6 is the only part that
> tests the failure that costs money.

---

## 0. Install stripe-mock (2 min, and it was never done)

**Those ten tests ran nowhere for five days.** They were written on 2026-08-19
and `stripe-mock` was never installed — not on Kelly's machine, and once CI
existed on 2026-08-24, not there either. `npm test` reported `pass 675,
skipped 10`, and the ten were all of these: the only check that our requests
match Stripe's schema, reported as a pass by not running.

This document said `brew install stripe-mock`, and there is no Homebrew on this
Mac. The release tarball needs neither:

```sh
ARCH=$(uname -m); case "$ARCH" in arm64) A=darwin_arm64;; x86_64) A=darwin_amd64;; esac
curl -sL -o /tmp/sm.tar.gz \
  "https://github.com/stripe/stripe-mock/releases/download/v0.202.0/stripe-mock_0.202.0_${A}.tar.gz"
tar xzf /tmp/sm.tar.gz -C /tmp stripe-mock
mv /tmp/stripe-mock ~/.local/bin/ && stripe-mock --version   # 0.202.0
```

Pinned to 0.202.0 deliberately: B21's field-name findings were measured against
that spec, and a different spec is a different answer to *"does Stripe accept
this"*.

Then `npm test` reports **703 passing, 0 skipped**.

**Locally a missing stripe-mock still skips** — a contributor should not be
blocked by a binary they may not want. **In CI it fails**, via
`STRIPE_MOCK_REQUIRED=1` in `.github/workflows/check.yml`, because CI installs
it a step earlier and has no excuse for reporting green on tests it did not run.

---

## 1. Make the price (5 min)

In the Stripe dashboard, with the **Test mode** toggle on:

1. **Product catalogue → Add product.** Name it whatever the customer should see
   on their card statement — "The Usability Lab" is fine.
2. Price **$29.00 USD**, **Recurring**, **Monthly**.
3. Save, then copy the **price id**. It starts `price_`.

> **The one that bites.** A *one-off* price looks identical on the results page
> and sells a single charge that never renews — the customer pays once, the
> renewal never arrives, and access expires silently a month later.
> `npm run stripe:check` refuses to pass on a non-recurring price for exactly
> this reason.

## 2. Get the keys (2 min)

**Developers → API keys**, still in test mode. Copy the **secret key**
(`sk_test_…`). Do not copy the publishable key; this integration never uses one,
because the card form is Stripe's page and not ours.

## 3. Point webhooks at localhost (5 min)

**Already installed**, 2026-08-25, the same way step 0 installs stripe-mock and
for the same reason — there is no Homebrew on this Mac. The line here used to
read `brew install stripe`, which is step 0's defect a second time in the same
document:

```sh
ARCH=$(uname -m); case "$ARCH" in arm64) A=mac-os_arm64;; x86_64) A=mac-os_x86_64;; esac
curl -sL -o /tmp/stripe.tar.gz \
  "https://github.com/stripe/stripe-cli/releases/download/v1.50.5/stripe_1.50.5_${A}.tar.gz"
tar xzf /tmp/stripe.tar.gz -C /tmp stripe
mv /tmp/stripe ~/.local/bin/
```

**`~/.local/bin` is not on the login PATH here**, so a fresh terminal cannot
find it — use the full path or add the directory to `~/.zshrc`. A command that
silently does not exist is what a Cloudflare 1033 looked like on 2026-08-24.

```sh
~/.local/bin/stripe login
~/.local/bin/stripe listen --forward-to localhost:4000/stripe/webhook \
  --events=customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,checkout.session.completed
```

`stripe listen` prints a signing secret (`whsec_…`) on startup. **It is not the
dashboard's** — a webhook endpoint created in the dashboard has its own, and the
two are different secrets for different delivery paths. Stripe's CLI reference
notes that this one *does not* change between restarts of `listen`, so it only
has to go into `.env` once.

You do **not** need to create a webhook endpoint in the dashboard for this;
`stripe listen` delivers without one.

> **Why no `--latest`.** The CLI has a `--latest` flag that sends events in the
> newest API version. Leave it off. Without it, events arrive shaped by *your
> account's* version — which is what production will do, and the case
> `readSubscription` reads both the old and new home of `current_period_end` to
> survive. Testing with `--latest` would test a shape your account may not send.

> **The other one that bites.** If you later create a real webhook endpoint in
> the dashboard, subscribe it to the three `customer.subscription.*` events.
> `checkout.session.completed` alone is not enough: the session says a payment
> succeeded but carries no period end, and access hangs entirely on that date.
> Enable only that one and **every customer pays and stays locked out** — F21,
> arriving by configuration rather than by a dropped webhook.

## 4. Fill in `.env` (1 min)

```
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PRICE_ID=price_...
STRIPE_WEBHOOK_SECRET=whsec_...        # from `stripe listen`, not the dashboard
```

All three or none. With any one missing the results page keeps saying checkout
is not connected and `/stripe/webhook` 404s — there is no half-live state,
because a secret key without a webhook secret would take money and never grant
access.

## 5. Preflight (30 seconds)

```
npm run stripe:check
```

Unconfigured it exits 2 and says which variables are missing — verified
2026-08-18, which is as far as this runbook can be executed without an account:

```
Stripe is not configured — nothing to check.

  Set STRIPE_SECRET_KEY, STRIPE_PRICE_ID and STRIPE_WEBHOOK_SECRET in .env.
```

With keys, it goes further.

It authenticates, reads the price, and refuses on the failures that are
otherwise silent: a one-off price, an archived price, a webhook secret that is
not one, a live key aimed at localhost. It warns — but does not block — when
Stripe's amount disagrees with the `$29` on the results page, because both
numbers are real and only a person can say which is right.

## 6. Buy one subscription (10 min)

You need a published audit to buy from, and an email session on it.

> **Worth watching here — B22, shipped 2026-08-24 and never yet exercised by a
> real webhook.** Subscription writes are now applied in Stripe's order rather
> than the socket's: an event whose `created` is older than the newest one
> already applied is refused, answered `200 stale`, and recorded as
> `webhook.stale`. Nothing you do in this step should trigger it — the events
> arrive in order on a healthy connection. If `npm run funnel` shows a
> `webhook.stale` after this step, that is the guard doing its job on a
> redelivery, and the row it protected is the one that would otherwise have
> been revived.

```
npm run serve                                    # in one terminal
~/.local/bin/stripe listen --forward-to ...      # in another (step 3)
```

1. Open a published audit's preview: `http://localhost:4000/a/<audit-id>/`
2. Enter an email. **Where the link arrives depends on `RESEND_API_KEY`.** This
   step used to say "printed to the server's terminal; no mail is sent", which
   was true until 2026-08-25 and is now the wrong half of a branch:
   - **Key set** (the current machine): it is emailed, and nothing is printed —
     the link is a bearer credential and a log is not a place for one. The
     Resend domain is unverified, so it delivers **only to the account owner's
     own address**. Use that address here; any other silently goes nowhere.
   - **No key**: printed to the server's terminal, as before.
3. Open the link → full results → **Subscribe — $29 a month**.
4. Pay with `4242 4242 4242 4242`, any future expiry, any CVC, any postcode.

**What should happen, in order:**

| Where | What to see |
|---|---|
| Browser | Redirected back to `/a/<id>/full?paid=1`, reading **"Payment received"** |
| `stripe listen` terminal | `checkout.session.completed` and `customer.subscription.created`, both `200` |
| Browser, after a reload | The **"Ask for a re-audit"** button, not the subscribe pitch |
| `npm run funnel` | `checkout started 1`, and `subscribed 1 — active right now` |

```sh
# and the row itself
sqlite3 out/usability-lab.db \
  "SELECT email, status, current_period_end, stripe_subscription_id FROM subscriptions;"
```

`status` must be `active`, and **`current_period_end` must not be null** — a null
there means the period end was read from the wrong place, access will be refused,
and B21 is not closed.

## 7. Cancel it, and reconcile (5 min)

1. Cancel the subscription in the dashboard. `stripe listen` shows
   `customer.subscription.deleted`; reload the results page and the subscribe
   pitch should be back.
2. Then prove F21's repair works without a webhook at all:

```sh
sqlite3 out/usability-lab.db \
  "UPDATE subscriptions SET status='canceled', current_period_end=NULL;"
npm run reconcile -- --dry-run    # should report `granted` for a live subscription
npm run reconcile                 # applies it
```

That is the failure §12 names — *"customer paid, still locked out"* — repaired
by the job that exists for it.

---

## What this closes, and what it does not

Closes **B21**: the two calls will have been sent, and their responses read.

Does **not** close:

- **B22** — a late webhook can still revive a cancelled subscription until
  reconciliation corrects it. Deliberate; the window is ≤24h by design.
- **B19** — closed 2026-08-18, so it no longer blocks a public deploy.
- **HTTPS.** Stripe will accept an `http://localhost` return URL in test mode
  and will not in production, and the magic link is a bearer credential in a URL
  regardless. Whatever terminates TLS must set `USABILITY_LAB_SECURE_COOKIES=1`.

When step 6 has been done once, edit B21 to say so and record the date. **Do not
mark it done from a passing `stripe:check`** — that proves the key and the price,
which is the easy half.
