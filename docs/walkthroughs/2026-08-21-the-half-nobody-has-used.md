# Walkthrough — the half nobody has used

**Written 2026-08-21.** Everything here is free and reversible. Nothing on this
list spends money or publishes anything.

---

## Why this list exists

Five real bugs were found on 2026-08-21 by using the product for twenty
minutes. The test suite was 588 green through all five, and is 602 green now.
Tests hold a line; they do not find it.

The funnel says where to look next:

```
homepage viewed          82
form opened              17
questions answered        9
audit requested           6
completed                 5
published                 3
previewed                 1     <- me, with curl
email captured            0     <- the wall
full results read         0
checkout started          0
re-audit requested        0
```

**Everything past the email gate is zero.** The audit pipeline has been walked
hard. The half that turns an audit into money has never been walked at all —
and it is the half with signed tokens, a bearer cookie, and the moment somebody
decides whether to pay.

## Two shapes to watch for

Both bugs found today were one of these, and neither is a crash:

1. **Copy that promises what the code does not do.** The status page said "It
   updates as we go" for its whole life and never refreshed. It looked fine.
2. **A dead end with no way back.** Four duplicate requests came from one page
   that gave no sign of life and no route to the audit already running.

When something feels wrong but works, it is usually one of these. Write down
the feeling, not just the fault.

---

## Session A — the email gate (~30 min, $0)

Server: `npm run serve`, then `http://localhost:4000`.

Use an audit that already has findings behind the gate:

```
http://localhost:4000/a/4f8f1271-63d5-4634-b8a6-59cf5f7dbd6f/     (basecamp, 14 kept)
http://localhost:4000/a/52444e83-6100-4683-bac3-9cf182c7d802/     (cotopaxi, 14 kept)
```

**No mail is sent.** Magic links print to the server console — ask and I will
read one out.

### The happy path

**Walked to the magic link on 2026-08-21 and stopped there.**

- [x] The preview shows **three** findings and an honest count of what is held back.
- [x] The withheld count names the severity spread, and it is **true**. Verified
      against `review.json` rather than the rendered page: 14 kept, 11 issues,
      3 positives, free three all severity 2, the 8 held back `2,2,2,2,1,1,1,2`.
      Every number the page states is correct. **Note the free-three-by-rank
      risk cannot be observed on this audit — it contains no severity 3 at all.
      Only `2928c314` has any (two).**
- [x] Submit an address → **`email.captured`, the first in the project's life.**
      The funnel had read 0 there since it was built.
- [ ] Follow the magic link. The full page shows every kept finding.
- [ ] The subscribe block says **checkout is not connected** — a sentence, not a dead button.
- [ ] The quiet "prefer to talk it through?" mailto is present and low-key (§1).

### The ugly paths — where the bugs will be

- [ ] **Same address twice.** There is a cooldown and no second link is sent. Does the page say so, or does it look like the first one failed?
- [ ] **A malformed address.** Does the refusal help, and does it keep what you typed?
- [ ] **The link twice.** Second use — still works, or an error that explains itself?
- [ ] **The link in a different browser.** It is a bearer credential; whatever happens should be deliberate.
- [ ] **`/full` with no cookie.** Straight to `…/full` in a private window.
- [ ] **A tampered token.** Change one character in the link.
- [ ] **An unpublished audit.** `…/a/2928c314-4cb0-4a96-a106-36ed5b9cd3d8/` must 404 exactly like a made-up id — "this exists but you may not see it" is itself information.
- [ ] **Back-button after submitting.** Does it resubmit?

---

## Session B — a small screen (~15 min, $0)

The homepage, the stepper and the status page were all built on 2026-08-20/21
and **none of them has been seen on a phone.**

Bind to the network and open it from your phone on the same wifi:

```sh
USABILITY_LAB_BIND=0.0.0.0 npm run serve
# then http://<your-mac's-lan-ip>:4000/
```

- [ ] The hero's dot field — does it read, or is it noise at 390px?
- [ ] The brandmark and headline — anything colliding?
- [ ] The stepper: one question at a time, keyboard covering the field?
- [ ] Continue and Back reachable with a thumb.
- [ ] The status page dot and step copy.
- [ ] Long text: a very long URL, and an answer near the 1000-character cap.
- [ ] **Reduced motion** (Settings → Accessibility → Motion). The hero and the dot should stop moving and stay legible.

---

## Session C — the founder gate, then B24 (~15 min, yours)

```sh
npm run review -- 2928c314
```

Thirteen findings. `Enter` keeps, `c` cuts, `1`–`4` keeps at a severity, and a
reason typed after the letter is the only record of *why*.

The question is **"would a founder change something because of this?"** — action,
not interest. A finding can be true and still worth cutting.

- [ ] Watch whether either **severity 3** finding lands outside the free three. Selection is by rank, not severity, and that risk was left unguarded so it could be measured.
- [ ] Notice whether the three **uncited** findings are the ones you cut.
- [ ] Publish.

Then I replace the homepage's placeholder card with a real cited finding — which
is **B24**, and which this audit itself flagged as a severity-2 problem.

---

## What to write down

For anything that felt wrong, even if it worked:

- what you expected
- what happened
- what you did next

That third line is the valuable one. Four duplicate requests were not four
mistakes; they were one missing affordance, and the pattern only showed up
because the "what you did next" was the same every time.

---

## Found on the way, not yet decided

**The magic link's TTL is seven days, and nobody chose it.** The token is a
bearer credential in a URL that will sit in an inbox forever; `TOKEN_TTL_MS` is
simply what it is. Seven days is not obviously wrong — it is obviously
unconsidered. Worth deciding rather than inheriting.

The payload is signed, not encrypted, and readable by anyone holding the link:

```json
{"auditId":"4f8f1271-…","email":"…","expiresAt":1787956883327}
```

That is fine — they already hold the link — but it means forwarding the link
forwards access, and the address travels with it.

**B17 proved itself.** `preview.viewed` reads 12 and roughly ten are a shell
loop run while investigating. The funnel cannot tell a customer from us, and
the contamination happened *during* an investigation of the funnel. Of the rows
past the gate, only `email.captured` is currently trustworthy, because it
cannot be produced without going through the form.

## Known, so do not re-report

- **The published homepage audit has no gate.** Only 3 issues and 3 shown, so nothing is withheld and the form correctly does not appear.
- **Four usefulness labels on `0e1456d9` are mine, not Kelly's** — kept without a founder judging them, permanent once `npm run corpus` runs.
- **Checkout is not connected.** Stripe keys are unset; B21 needs a real account and a public URL.
- **`a3eef85f`** is a stray queued Basecamp request from the localhost switch. Not run, not needed.
- **Quick tunnels are unreliable** — three failed three ways in one day. Use localhost; a named tunnel on a real domain is the fix, and only B21 needs it.
