# Stripe: the half hour that closes B21

Everything Stripe-shaped in this repo is built and tested **except one thing**:
no request has ever been sent to Stripe. This is how that changes. It needs a
Stripe account and about thirty minutes; nothing in it can be done without one,
which is why it is a document rather than a test.

Nothing here touches real money. Test mode uses a separate set of keys and a
separate dashboard, and the only card involved is Stripe's fake one.

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

```
npm install -g @stripe/cli     # or: brew install stripe/stripe-cli/stripe
stripe login
stripe listen --forward-to localhost:4000/stripe/webhook \
  --events customer.subscription.created,customer.subscription.updated,customer.subscription.deleted,checkout.session.completed
```

`stripe listen` prints a signing secret (`whsec_…`) on startup. **That secret is
the one for this session** — it is not the dashboard's, and it changes each time
you restart `stripe listen`.

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

It authenticates, reads the price, and refuses on the failures that are
otherwise silent: a one-off price, an archived price, a webhook secret that is
not one, a live key aimed at localhost. It warns — but does not block — when
Stripe's amount disagrees with the `$29` on the results page, because both
numbers are real and only a person can say which is right.

## 6. Buy one subscription (10 min)

You need a published audit to buy from, and an email session on it.

```
npm run serve                          # in one terminal
stripe listen --forward-to ... # in another (step 3)
```

1. Open a published audit's preview: `http://localhost:4000/a/<audit-id>/`
2. Enter an email. The magic link is **printed to the server's terminal**; no
   mail is sent.
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
- **B19** — DNS rebinding in the question flow. Unrelated to Stripe, and a
  blocker on serving any of this publicly.
- **HTTPS.** Stripe will accept an `http://localhost` return URL in test mode
  and will not in production, and the magic link is a bearer credential in a URL
  regardless. Whatever terminates TLS must set `USABILITY_LAB_SECURE_COOKIES=1`.

When step 6 has been done once, edit B21 to say so and record the date. **Do not
mark it done from a passing `stripe:check`** — that proves the key and the price,
which is the easy half.
