# Backlog

Work we have decided to do *later*, on purpose. An item earns a place here only
if we know why it matters and roughly what it costs — a wish with neither is
just noise, and this file is worthless the moment it becomes a dumping ground.

Nothing here is in scope for the current slice. Anything genuinely urgent should
be argued into a slice plan instead of parked.

---

## From the first labelling session (2026-08-10, audit `1e6d5d13`)

These three came out of labelling all 17 findings from one allbirds audit on
both axes — truth and usefulness. Each is evidenced, not suspected.

### B1. Make the Synthesizer's exclusions machine-readable

**What.** `SynthesisResult.excluded` carries `{ id, agent, reason }` for every
cut finding. `src/render.ts` already publishes all of it under "Set aside by the
synthesizer", so it is visible to a human reading the page. It is **not** in
`findings.json`, so `npm run corpus` and `npm run outcome` cannot see it.

*(Corrected 2026-08-10. This entry first claimed the reasons were discarded
entirely. They are not — they are rendered, just not stored as data.)*

**Why it matters.** Precision only measures findings that survived. If the
Synthesizer is systematically cutting the *good* ones, every metric we have
would keep looking healthy while the product quietly got worse. On `1e6d5d13`,
29 findings went in, 18 survived synthesis and 11 were cut — a bit under 40% of
the audit's raw output, invisible to every score we compute.

**What the cuts actually looked like** — worth reading before assuming the
Synthesizer needs fixing. It rejected findings for being unverifiable from the
capture ("the reviewer could not establish that the two listings actually
differ"), for self-contradiction across lanes, for duplication, and repeatedly
for irrelevance to the visitor's stated concern: *"correctly labelled social
icons in the footer do not inform the checkout drop-off this visitor came
about."* That is the behaviour we asked for.

**Cost.** Small — write `excluded` into `findings.json` alongside the findings,
then teach `corpus.ts` to read it.

### B2. Tighten the positives rule

**What.** The Synthesizer prompt says *"Keep at least one genuine positive if
the reviewers found one."* On `1e6d5d13` it kept three; Kelly judged one worth
the space on the page.

**Why it matters.** Two of the three findings that were true-but-inert were
positives. The rule is right — an audit that only accuses is a worse audit — but
"at least one" is being read as licence for several. This is a prompt change,
not a new mechanism.

**Cost.** Small, but it must not be made blind: re-measure on the next labelled
audit before editing, or we will be tuning on n=3.

### B3. Absence claims are unchecked

**What.** `src/claims.ts` verifies that cited elements exist, that quoted text
appears on the page, that measurements match, and that accessible-name claims
hold. It has no check for a claim that something is *missing* — "no discount
amount visible anywhere", "no incentive stated near the form".

**Why it matters.** Absence claims are unusually common in the
`conversion-cta` lane, and they are the easiest kind of finding to get wrong,
because the reviewer sees a capture rather than the page. Both absence claims in
`1e6d5d13` (#8, #9) held up under review, so this is not on fire.

**Cost.** Medium, and genuinely hard: proving absence means searching text,
accessible names *and* element attributes, and a false alarm here is expensive.
See the calibration history in `src/claims.test.ts` — the checker's first run
flagged 15 findings and 14 were its own bugs.

### ~~B4. No end-to-end test of the publish path~~ — done 2026-08-13

**What.** `renderPublic` is well covered and the state machine is well covered,
but nothing tests `review.ts` itself: load an audit, walk the findings, write
`review.json`, publish, transition. It was proven once by hand on `4f8f1271`.

**Why it matters.** This is now the most business-critical code in the repo —
it decides what a paying visitor sees and what stays behind the gate. Its first
run had a real bug (piped answers 2–17 silently discarded) that only surfaced
because it was used.

**Done.** `src/review.test.ts` — seven tests driving the real script as a
subprocess with piped answers, against a temp database and `out/` directory
(`USABILITY_LAB_DB` / `USABILITY_LAB_OUT`, `src/paths.ts`). Raised at the Slice 4
`/karpathy-review`, where the argument for doing it now was that B4 stops being
backlog the moment the gate publishes something.

---

## B5. ~~The correction path is UNRESOLVED~~ — DECIDED 2026-08-17

**Decided: the page is fixed and it says so.** A dated line in our words, above
the findings. `npm run correct -- <audit-id> "<reason>"`, history append-only in
the event log, `review.ts`'s refusal now points at it instead of just refusing.
See `docs/quality-bar.md` §3 for the rejected options and why.

**Verified on the case that prompted it.** `139d5f3e` (notion.com/pricing) went
live carrying three citations it did not display; correcting it produced a page
with all three sources visible and the line "Corrected 2026-08-18 · the sources
behind three findings were missing from this page".

**Still open, and deliberately not built:** nobody is notified — a correction the
customer never hears about is half a policy, and there is no email path yet. And
a correction re-renders with *today's* code, so it can pick up unrelated
rendering changes while the dated line names only the stated reason.

**The bypass this closes.** Twice a published page was regenerated with a
throwaway script that stepped around the guard, and nothing recorded that what
the visitor saw had changed. A guard that can only be bypassed will be.

---

## B6. Nothing can quote the page title, so findings about it read as false

**What happened.** 2026-08-16, at the asana gate. Finding `f2` observed that a
page titled "Create Account" carries no step indicator, and `claims.ts` marked it
**contradicted** — *quotes "Create Account", which is NOT on the page*. The
finding was right. `capture.title` is `Create Account - Try Asana for free •
Asana`, captured and stored.

**The cause.** [`pageSources()`](../src/confidence.ts) builds the checker's
ground truth from `text_excerpt`, element `text`, and `accessible_name`. It never
includes `capture.title`. We capture the title and then let nothing quote it, so
every finding that reasons about a page title is mechanically false by
construction.

**Why it was not fixed on the spot.** Kelly cut `f2` instead, at the gate, with
the trade-off stated. Recording the fix here rather than shipping it alongside a
publish was deliberate — it changes what the truth checker considers true, and
that should not ride along with a page going out.

**The trade-off to decide.** Adding `capture.title` to `pageSources` is one line.
It widens what counts as quotable: a finding could quote the browser-tab title
while implying it is visible body copy, and the checker would pass it. The
narrower alternative is a separate `title` source that only the quote check
consults, so a title match never satisfies a claim about visible text.

**Cost.** One line plus a test for the wide version; ~20 lines for the narrow
one. **What it distorts until fixed:** one finding in the corpus is labelled
contradicted when it is true, and the asana audit reports 12 findings / 1 false.

---

## B8. The page text truncates silently

*(Corrected 2026-08-16, an hour after filing. This entry first claimed the
truncation caused basecamp's false finding. **It did not** — see B10. I fixed
the truncation, re-captured basecamp, and the labels were still missing from a
now-complete 6666-character page text, which is how the real cause surfaced.
The bug below is real and the fix stands; the causal claim was wrong.)*

**Found by** the rank-agreement diagnosis, 2026-08-16.

**What happens.** `text_excerpt` was `fullText.slice(0, 4000)`, and **5 of the
11 distinct pages we have ever captured exceed it** — stripe/pricing 28086
chars, stripe 12310, linear 8146, basecamp 6753, wikipedia 4102. A reviewer
handed 59% of a page under the heading `VISIBLE PAGE TEXT` has no way to know
it is reasoning about a fragment.

**The part that makes it a defect rather than a limit.**
[`runner.ts`](../src/agents/runner.ts) already solves this problem for the other
truncation. When the element list is cut it appends: *"this list is TRUNCATED.
Do not claim anything is missing from the page; you are only seeing part of
it."* The page text is handed over under the heading `VISIBLE PAGE TEXT` with
no warning at all. We taught the reviewer to distrust one truncated input and
not the other.

**Fixed** the same day: the warning is mirrored, and the limit raised 4000 →
16000, which covers 9 of the 11. Kept here because the *reasoning* is worth
holding on to — the guard existed twenty lines away and had simply never been
applied to the second input. Related: B3 (absence claims), B10.

---

## B9. `<noscript>` markup is being served to reviewers as visible page text

**Found by** the same diagnosis. Measured, not suspected.

**What happened.** 47% of asana's "visible page text" (273 of 576 characters) is
raw tracking-iframe markup:
`<iframe src="//b.yjtag.jp/iframe?c=st0IEwU" width="1" height="1" ...>`.

**The mechanism, probed rather than assumed.** When scripting is enabled, a
`<noscript>` element's contents are **not parsed into elements** — they are one
text node holding the literal markup. And in Chromium under Playwright,
`<noscript>` computes `display: inline`, `visibility: visible`, `opacity: 1`
with a 0x0 rect. `visibleText`'s clip rule needs `overflow: hidden` to fire, so
nothing catches it.

**Why it matters.** Reviewers are asked to reason about the words a visitor
reads. On a short page like asana's signup, nearly half of what we called page
text is tracking markup — and it is exactly the kind of thing a model will
happily draw a conclusion from.

**Cost.** Small — skip `script`, `style`, `noscript`, `template` and `head` by
tag in `visibleText`, rather than hoping their computed style gives them away.
A tag check is a fact; a style check turned out to be a request.

---

## B10. Text rendered as an image is invisible to us and obvious to a visitor

**This is the real cause of basecamp's false finding**, and the reason B8 above
carries a correction. It is also the first bug this project has found that
cannot be fixed by looking harder at the DOM.

**What happened.** `4f8f1271` rank 1, high confidence, mechanically **verified**:
*"The six large tool tiles (Message Board, Docs & Files, To-dos, Chat, Schedule,
Card Table) carry no visible text on the page — their labels exist only as
accessible names, not as rendered captions."* Kelly cut it. The screenshot shows
all six labels rendered as red headings.

**What the page actually does.** Each label is a `.webp` image —
`tool-message-board-light.webp`, `tool-docs-and-files-light.webp`, and so on —
every one with `alt=""`. Probed on the live page:
`document.body.textContent.includes("Message Board")` is **false**. The string
is nowhere in the DOM text. The `<button>`s carry `aria-label="Tool: Message
Board"`, which is exactly what our capture recorded.

**So the capture was right and the finding was wrong.** Every fact in it is true
of the document. The conclusion — that a visitor sees no caption — is false,
and no amount of DOM inspection can tell us otherwise, because the caption is
pixels.

**Why this is the hard one.** Every capture bug found on 2026-08-16 was fixed by
asking a better question of the DOM. This one cannot be. The options, none free:

- **Stop reviewers claiming absence of text at all.** Cheapest and bluntest.
  They can say "no text node exists for X", which is true and much weaker. Costs
  real findings — "this page never states its price" is a *good* finding.
- **Send the screenshot to the reviewer.** They currently get text only and
  never see the page. Correct, and materially more expensive per audit.
- **OCR the screenshot** into a second text source. Most machinery, and its own
  false positives.

**Cost.** The decision is the expensive part; each option is small to medium.
**What it distorts until decided:** every absence-of-text claim on any page that
sets type in images — which is most marketing pages. Related: B3, B8, and
`usability-lab-evidence-failures` — this is the purest example yet of a right
fact with a wrong conclusion.

---

## B11. ~~The quote check has never caught a fabrication~~ — FIXED 2026-08-17

**All five false flags are gone. Precision 94.6% -> 96.8%**, mechanically
contradicted 8 -> 3, and every remaining flag is a genuine catch.

**The framing above was wrong in one respect, and the test suite caught it.**
"Never caught a fabrication" is true of the current corpus and false of its
history: `claims.test.ts` pins linear.app's duplicated-headline claim, where the
quote check correctly contradicted a finding whose "duplicate" was
screen-reader-only text. The first fix here made *every* missing quote
inconclusive and turned that test red — it would have disarmed the check for
exactly the shape it exists for. So the fix narrows instead.

**What now skips the check**, each mapped to one of the five:

| was flagged | now |
|---|---|
| hypothetical `"Reserve a seat"` | a negation or example cue in the clause before the quote |
| absence `"United States"` | same — negation scopes over the clause, not the word before it |
| elided `"You're juggling…"` | an ellipsis cannot be matched as one contiguous string |
| the page title `"Create Account"` | title added as a quote-only source (B6, narrow version) |
| abstraction `"Includes X, Y, Z"` | `e.g.` recognised as an example marker |

**Two bugs found while fixing it, both in my own regexes.** `\b` after `e.g.`
never matches, because a word boundary needs a word character and the token ends
in a full stop. And the clause splitter read that same full stop as a sentence
end, cutting the cue out of the text it was meant to search. Both are pinned.

**What the fix does not do.** An unhedged quote that is not on the page still
contradicts — narrowing must not become disarming. And the hedge list is a
judgement about language, so it will miss phrasings nobody has written yet.

**B6 is partly closed by this**: the title is quotable now, and deliberately
still absent from `pageSources`, so a title match cannot satisfy a claim about
visible body text.

---

## B12. ~~The image cache does not work~~ — FIXED 2026-08-17, with a caveat

**Shipped** (`61e1e5f`): `system` is SHARED_RULES alone and the lane block moved
below the page content, so every reviewer of an audit shares one prefix.
`USABILITY_LAB_LANE_AFTER_DATA=0` restores the old ordering; the red team runs
against both, and that stays.

**Verified live on linear.app/pricing:**

    forms            cache_write 18,303   cache_read      0
    heuristics       cache_write 18,303   cache_read      0
    conversion-cta   cache_write      0   cache_read 18,303
    copy             cache_write      0   cache_read 18,303

**The saving is ~$0.09 an audit, not the ~$0.18 predicted, and the gap is our
own concurrency.** §6 runs two sub-agents at a time, so the first pair both
start before either has written the cache and both pay full price. Two writes,
two reads, instead of one and three.

**The remaining half is a scheduling change, not a security one** — run one
reviewer alone to warm the cache, then fan the rest out. It costs roughly one
reviewer (50-60s) on the critical path of a ~230s audit. Not done: it trades
latency against money and that is a product call.

**The trade that was accepted.** Our lane instruction now follows untrusted page
content. Three paired red-team rounds, thirty reviewer calls, five fixtures —
two built so success would be observable — found no difference between the
orderings. Nothing has ever succeeded against either, so that is evidence and
not proof.

---

## B13. Reviewers assert facts the capture cannot carry, and nothing marks the gap

**Two instances, both found at the gate on 2026-08-17, both verified false by
going to the live page.**

**duolingo, `2a5a7f87` finding 5, severity 2, high confidence.** "Across the
screenshot slices, the header ... is only visible in the first slice; no fixed
or sticky version of it reappears." Probed live:

    DIV  fixed  1440x72  top:0  ::  Site language: English

The header *is* `position: fixed`. A fixed element paints once at the top of a
full-page screenshot, so its absence from later slices is a property of
full-page screenshots, not of the page. **This failure mode did not exist before
we sent reviewers the screenshot** — B10's fix created it.

**irs.gov, `5d121558` finding 10, severity 2, medium confidence.** "Page Last
Reviewed or Updated: 28-Jun-2026, a date that is in the future relative to when
this capture was made." The capture was made 2026-08-17. June 28th is seven
weeks past. The reviewer has no clock and reasoned about time anyway.

**The shape.** Both are B8's pattern — silence read as absence — but neither is
about truncation. The capture cannot express `position`, and the request carries
no date. Reviewers do not know which facts are unavailable to them, so absence
of evidence becomes evidence of absence, at high confidence, and every
downstream check passes because the *element* is real and the *quote* is
present. `claims.ts` scored both audits `0 false`.

**Two fixes, both shipped 2026-08-17 (`1124834`):**

1. ~~Carry `position` on captured elements when it is `fixed` or `sticky`.~~
   Done. Nullish, so older captures still parse, and the renderer says nothing
   when it is null — never "static", because silence has to keep meaning
   "unknown".
2. ~~Put the capture date in the prompt.~~ Done, and *outside*
   `<captured_page_data>`: read from inside it would be page content, and a page
   that wanted to look freshly updated could write it.

**Still open**, and the larger one: **name what the screenshot cannot show** —
stickiness,
scroll and hover behaviour, animation, anything time-dependent — in
SHARED_RULES, the way the truncation warnings name what is missing. That is a
prompt change and should be measured, not assumed.

**Do not treat this as rare.** Both landed in the same afternoon, in two audits
out of three, and both were kept at the gate after being flagged — so the corpus
now carries them as true and useful. Precision reads 94.3% and the honest
number is 93.1%.

**Verified 2026-08-17, and the first attempt was wrong.** Reading
`style.position` off each element recorded position on **zero** elements of
duolingo — its header is a `position: static` <nav> inside a `position: fixed`
<div>, and the <div> is not in the capture selector. The opacity bug's exact
shape, four days later, with green tests because the fixture had been written to
match the implementation. `pinnedBy` walks the chain (`f8e0cf9`); the live page
now returns 3 of 98 elements pinned.

**The reviewer half is still unproven.** Two audits since — one without the data
and one with — and neither reproduced the false claim. That means the fix has
not been contradicted; it does not mean it was used. No finding in either run
mentions the fixed header at all. **Absence of the bug in two runs is not
evidence the data changed anything**, and the honest next step is the third fix
below, not a claim of success.

**What the fixes do not do.** Neither one has been seen working on a live page.
The tests prove the capture records `position: fixed` and the request carries
the date; nothing yet proves a reviewer *uses* either, and the failure mode was
never that the data was wrong — it was that a reviewer filled a gap with
confidence. The next audit on a page with a fixed header is the evidence. Until
then this is a fix by construction, not by measurement.

---

## B14. One synthesizer call took 27 minutes and reported success

**2026-08-17**, the second B13 verification run on duolingo (`58c9cfe5`).

    capture     38.1s
    review     106.5s
    synthesize  1618.6s   <- 27 minutes
    research    29.1s
    total       1799.9s   $0.6460

`model_calls` logged it `ok=1`, 4334 output tokens, one row. Every other
synthesizer call we have ever made:

    8226 / 40489 / 24071 / 36143 / 34559 ms

**The number is suspiciously structured.** 1618.6s is close to 3 x 540s, and
the SDK's default non-streaming timeout for `max_tokens: 8000` is 600s with two
retries. **Hypothesis: the call timed out twice and succeeded on the third
attempt**, and we paid for three generations while `model_calls` recorded one.
Unverified — the retries happen inside the SDK and leave no row of their own.

**Why it matters beyond the money.** The definition of done says under 8
minutes. This run took thirty. Nothing in the pipeline has a wall-clock budget,
so a step that hangs takes the audit with it and still reports success. F9 is
the timeout family in §7 and is in v0's list; this is the case it exists for and
the case it does not currently cover.

**Before fixing, measure.** One occurrence, one hypothesis, no proof. The cheap
probe is to log `_request_id` and attempt count, or set an explicit
`maxRetries: 0` on the synthesizer once and see whether a 9-minute failure
replaces the 27-minute success. Streaming the synthesizer would sidestep the
timeout entirely — the SDK recommends it for long outputs — but that is a change
to make on evidence, not on a single slow run.

---

## B15. The audit agrees with itself about a third of the time

**Measured 2026-08-17.** duolingo.com, three runs, same answers, same prompt
versions, reviewers pinned to the same three lanes, ~$2.11 all in. The page did
not change between them. This is the noise floor for any finding diff, and it is
also a fact about the product a customer would notice.

    findings per run          14, 12, 15
    in all three runs          6 distinct issues
    in at least one run       17
    in exactly one run         7   <- 41% of everything said was said once

Best key (`polarity + element text`), pairwise, on a page that did not change:

    run1 v run2    5 fixed / 5 new / 6 unchanged
    run1 v run3    2 fixed / 2 new / 9 unchanged
    run2 v run3    4 fixed / 4 new / 7 unchanged

**"3 fixed, 1 new" is inside the noise.** A diff cannot make that claim on one
run per side, whatever the matching key does.

**Pinning the lanes worked and is worth keeping** (`1c16f94`): the same page
unpinned gave 7 fixed / 10 new / 2 unchanged, so reusing the baseline's
reviewers roughly halved the churn. It did not get near zero.

**Where the variance is, and where it is not.** The reviewers produced 23, 23
and 24 raw findings — remarkably stable. Synthesis then kept 14, 13 and 16, and
*which* ones it kept moved. So the instability is concentrated in dedupe/rank
and in wording drift, not in what the reviewers see.

**This is bigger than the diff.** A customer who re-runs an unchanged page gets
a materially different report, and `precision` is measured over one sample of a
distribution we have never characterised. Three candidate directions, none
costed yet:

1. **Weaken the claim** to "no longer reported" and show both lists. Honest,
   cheap, smaller product.
2. **Make synthesis reproducible** — it is the step where the variance enters.
3. **Use repetition as evidence**: run twice, report what recurs, treat
   recurrence as a confidence input. Doubles cost, and fits "confidence is
   derived, not declared" better than anything we currently do.

---

## The deeper problem behind B3

Two of the seventeen findings were false, and neither was a wrong fact:

- **#3** — "no third option (e.g. Shop All) given similar prominence." `el_5 <a>
  "Shop All"` exists at 62×16px in the nav; the hero CTAs are 122×33px.
- **#11** — flyout items are `<button>` while equivalent nav is `<a>`. The
  capture confirms this exactly. The contestable part is "functionally
  identical".

Both state accurate facts and over-reach on what those facts mean. **No
extension of `claims.ts` can catch this**, because the facts are right. It is an
argument for the human review gate, not for a better checker — worth remembering
the next time a metric tempts us to automate the gate away.

---

## B16. ~~The served surface has no defences a public one would need~~ — DONE 2026-08-18, one item withdrawn

**What shipped.** `src/ratelimit.ts` and three limits on `POST /a/:id/email`:

    cooldown    1 link per (audit, address) per 5 min   → "we have not sent another"
    per audit   20 requests per hour                    → 429 + retry-after
    per address  5 requests per hour, across audits     → 429 + retry-after

The defended case is **mail-bombing**, not the audit: once a sender exists, an
unlimited endpoint makes us a relay that mails any address a stranger types,
from our domain, about a site they have never visited. So the limit that
matters is keyed on the recipient.

Plus: the magic link now exchanges itself for an `HttpOnly; SameSite=Lax` cookie
scoped to `Path=/a/<id>/` and redirects to a clean URL, so a seven-day bearer
credential stops living in browser history and proxy logs after first use.

### The item withdrawn, and why

**The bad-token lockout was a worse idea than the attack it prevents.** As
specified — refuse an audit after N failed tokens — it is a denial of service
that anyone holding the results URL can aim at the customer whose audit it is,
guarding a 256-bit HMAC against guessing, which is not a thing that happens. A
defence that is easier to abuse than the attack it stops is not a defence.

Replaced with a `token.rejected` event carrying the reason and **not the token**,
so an attempt is visible in the funnel and nothing gets locked. There is a test
asserting the real link still works after twenty-five failures.

### CSRF: inapplicable, not deferred

CSRF needs ambient authority. The only state-changing route is the email form,
it reads no cookie, and an attacker who wants a link mailed to an address they
chose can POST it themselves — a victim's browser adds nothing. **The rule to
keep: if a state-changing route ever reads `ul_full`, it needs a CSRF token that
day.**

### Still a deploy blocker

**HTTPS.** Not ours to build — it belongs to whatever fronts this. But the token
is a bearer credential and travels in a URL on first use, so plain HTTP in front
of a real customer is a real leak. Whatever terminates TLS must also set
`USABILITY_LAB_SECURE_COOKIES=1`; the server will not guess.

### Two limitations that are real

- **The windows are in memory.** A restart forgets them, and behind more than
  one process each would enforce the limit separately — the real limit silently
  doubling per process. Revisit before there is a second process.
- **The sweep is not a cap.** It reclaims expired keys; a flood arriving inside
  one window expires nothing. What bounds the maps is the *order* of the checks
  in `server.ts` — the per-audit allowance is peeked before any other key can be
  created. That ordering is load-bearing and is commented as such in both files.

**The numbers are guesses.** Nobody has used this. They are set where a real
visitor cannot plausibly reach them and an automated one hits them in seconds.

## B17. The funnel cannot tell a customer from us

**What.** `preview.viewed`, `email.captured` and `full.viewed` are recorded for
anyone who loads the page, including whoever is testing it. Verifying the gate
by hand on 2026-08-18 put three fabricated stages into the real dashboard within
a minute, and they had to be deleted by hand — from a log that is append-only by
construction, using a script that stepped around it.

**Why it matters.** This is the 200% review row again in a new place. A dashboard
that counts its own author is not measuring anything, and the first instinct on
finding wrong numbers in it was to bypass the append-only guarantee — which is
exactly the failure B5 exists to prevent.

**What would fix it.** Either a flag on the event (`internal: true` when the
request comes from localhost, which is honest today and wrong the moment this is
deployed), or the discipline of pointing manual checks at `USABILITY_LAB_DB`.
The second is free and was the actual mistake; the first is the durable answer
and should wait until there is a real deployment to distinguish *from*.

**Cost.** Small either way. **Do not build it before there is a customer to
tell apart from us** — until then it would be a flag with one possible value.

---

## B18. Subscribing buys something; nothing can subscribe

**What.** Built 2026-08-18: the `subscriptions` table, the fair-use cap as a
real refusal, the offer on the full results page, a re-audit button behind CSRF,
a request queue, and `npm run reaudit -- --queue` to act on it. **Stripe
Checkout, its webhook, and F21's daily reconciliation are not built** — they are
the third of §0's subscribe step that needs API keys nobody has yet.

**Why it was built in this order.** §0 defines a subscription as
"customer-triggered re-audits from the results page", and until today there was
no button on any page — `npm run reaudit` was a CLI. Building Checkout first
would have meant a customer paying $29 and landing back on the page they
already had. Everything a subscription *buys* is now real and tested; the part
that takes the money is the part that is missing, and it is missing visibly:
the page says "Checkout is not connected yet" rather than showing a dead button.

**What granting access looks like meanwhile.** `npm run subscribe -- <email>`
writes the same row the webhook will, through the same store, leaving both
Stripe id columns null so a hand-granted subscription is distinguishable at a
glance. That command is also the granting half of F21's reconciliation, so it
is not throwaway.

**Two decisions inside it that are Kelly's to overrule.**

1. **Sites do not reset with the month; audits do.** "3 sites, 10 audits/mo"
   reads to me as a rate and a scope: a month is what $29 is quoted against, but
   §1 sells monitoring *for three sites*, and a site limit that cleared every
   month would be selling something else. The cost is that swapping a site is a
   founder deleting a row. `checkFairUse` is the one function to change and
   `fairuse.test.ts` says so.
2. **Access expires rather than persists.** A row saying `active` with no period
   end grants nothing. This matches F21 — named failure "customer paid, still
   locked out", named repair "reconciliation grants access", named blast radius
   "one customer, ≤24h" — and deliberately takes that failure over the opposite
   one, a cancelled customer keeping access until somebody notices. No grace
   period, because a grace window turns F21's ≤24h into 24h-plus-whatever.

**What is not covered by a test.** `runQueue` in `reaudit.ts` shells out per
request, so testing it means either spawning a real capture or mocking
`execFileSync`. It was verified by hand on 2026-08-18 against a temp database —
it picked the request up, dispatched, failed cleanly on an unresolvable host,
marked the row done, and reported `0 of 1 completed, 1 failed`. The store
semantics underneath it (`queue`, `complete`, `pending`) are tested; the loop
is not. **Recorded here so the green suite is not read as covering it.**

**What is left.** Checkout session creation, the webhook with signature
verification, and daily reconciliation. All three need keys. None of them can be
written honestly before there is an account to write them against.

---

## B19. ~~The URL guard resolves once; the browser resolves again~~ — DONE 2026-08-18

**What it was.** `checkUrl` resolved a hostname, judged it, and threw the
addresses away. Playwright then resolved the same name again — minutes or hours
later, when the queue ran — and connected to whatever it got. A host answering
publicly for the first lookup and `169.254.169.254` for the second passed the
check and reached the cloud metadata service, whose response would be rendered
into a screenshot published back to the person who chose the URL.

**What closed it.** `resolveGuarded` returns **the address to connect to**
rather than a verdict, and `src/guardproxy.ts` — a loopback-only proxy started
per capture — makes every request the browser sends go to an address it
validated. `robots.txt`, which runs *before* the browser and used a bare
`fetch`, connects through a pinned `lookup` for the same reason.

**Why a proxy and not `--host-resolver-rules`.** The Chromium flag is two lines
and pins the hosts you name. It does not pin the ones you cannot: a redirect, an
`<iframe src>`, an image, an XHR. An iframe pointed at an internal address
renders into the screenshot exactly as the main document would, so pinning only
the submitted URL leaves the interesting half open. `fixtures/pages/ssrf-subresource.html`
is that case, and it is a committed test.

**Fidelity was measured, not assumed.** basecamp.com captured through the proxy
and directly on HEAD, minutes apart: 88 elements, 88 total, 6,621 characters,
4,502px — identical on every number. The proxy is transparent.

**Three things found while building it, each by a test that failed:**

1. The injected policy never governed — `resolveGuarded` had already refused
   with the real rule before `isBlocked` ran. The allow-path test failed with a
   403 that looked exactly like the feature working.
2. `--proxy-bypass-list` passed through `args` does nothing; Playwright builds
   that flag from its own `proxy.bypass` option and its version wins.
3. Chromium refuses its own list of restricted ports (9, 25, 6667 and ~80
   others) before any proxy is consulted. The loopback fixture originally used
   port 9, so the request was never issued — which also looked like the guard
   working.

**What is not covered, stated plainly.**

- **`bypass: "<-loopback>"` is untested.** It asks Chromium to drop its
  documented loopback exemption, and removing it leaves the loopback assertion
  passing — so on this Chromium the exemption is not applied to a proxy set this
  way. Kept as insurance against a version that restores it; `capture.ts` says so
  where it is set, and the test says so too.
- **WebRTC.** A page can open direct UDP connections that do not traverse an
  HTTP proxy. It is not a practical route to a metadata endpoint — those speak
  HTTP and will not complete an ICE handshake — but it is the one thing a page
  can still do that this does not see.

---

## B20. Two queue runners, neither of them tested past "empty"

**What.** `runQueue` in `reaudit.ts` (B18) and `runQueue` in `index.ts` both
shell out per row. Their stores are tested and their empty case is tested; the
loop that actually spends money is not, in either file, because exercising it
means a real capture and a real audit.

**Why it matters.** These are the only two functions in the codebase whose job
is to spend money, and they are the two with the least coverage. Not because
they are hard to write, but because they are hard to *observe* — the test would
have to either mock `execFileSync`, which tests the mock, or spend $0.65 a run,
which no suite should.

**What has been verified by hand.** Both, on temp databases, 2026-08-18. The
re-audit runner picked up a request, dispatched, failed cleanly on an
unresolvable host, marked the row done and reported `0 of 1 completed, 1 failed`.
The audit runner picked up a form submission, minted and stamped an audit id,
ran a real basecamp audit ($0.5684, 206.7s, 14 findings), and the visitor's
status page followed it from "In the queue" to "a person is reading it" to a
link.

**What would fix it.** A `--dry-run` that prints the command instead of running
it would make the loop, the claiming and the failure accounting testable while
leaving the spend untestable — which is the honest split. Small.

**Recorded so the green suite is not read as covering them.**

---

## B21. Two Stripe calls have never been sent to Stripe

**Status 2026-08-18: the guessing is gone; the sending has not happened.**

### What was verified against Stripe's live documentation

Every field name in `src/stripe.ts` was checked against docs.stripe.com on
2026-08-18 rather than against my recall. All confirmed as written:

- **Checkout session create** — `mode`, `line_items[0][price]`,
  `line_items[0][quantity]`, `customer_email`, `client_reference_id`,
  `metadata`, `success_url`, `cancel_url`, and the `id`/`url` in the response.
- **`subscription_data.metadata`** exists and is a map. This was the highest
  risk in the file: if that key were wrong the metadata would never reach the
  subscription, every `customer.subscription.*` webhook would arrive
  unattributable, and **the customer would pay and never be granted access** —
  silently, and only in one direction, since the checkout session would still
  carry its own copy.
- **Subscriptions list** — `limit` (1–100), `starting_after`, and `status=all`,
  which is documented as returning subscriptions of every status.
- **The status enum** is exactly the eight `mapStatus` handles.

### Three things it changed

1. **`current_period_end` is not a top-level field.** The Subscription object's
   attribute list does not contain it; it appears only inside
   `items.data[].current_period_end`. The defensive fallback written blind
   turned out to be reading the *current* location as its second choice. Both
   are still read, because a webhook is shaped by the account's API version
   rather than ours and an older account still sends it at the top level.
2. **The earliest item wins, not the first.** Stripe's own list filter is
   documented as matching "the minimum item `current_period_end`". `items[0]`
   was right by accident on a one-line plan.
3. **The API version is now pinned** to `2026-07-29.dahlia`, confirmed as
   current. Pinned rather than omitted because the field names above were
   verified against *that* version's docs — sending anything else means the docs
   I checked are not the docs that apply. It does **not** cover webhooks, whose
   shape follows the account's or the endpoint's version.

### What now catches the silent failures

`npm run stripe:check` — one cheap call, then arithmetic. It blocks on a
non-recurring price (sells one charge, never renews, nothing else would notice),
an archived price, a webhook secret that is not one, and a live key aimed at
localhost. It warns on Stripe's amount disagreeing with the `$29` on the results
page, because both numbers are real and only a person can say which is right.
Tested against a stub, including the case where the key does not authenticate at
all.

### What is still open

**No request has been sent to Stripe.** `stripe:check` proves a key and a price;
it does not prove a payment. `docs/stripe-runbook.md` is the half hour that
closes this: make the price, run `stripe listen`, buy one subscription with
`4242 4242 4242 4242`, watch the row appear, cancel it, reconcile.

**Do not mark this done from a passing `stripe:check`** — that is the easy half.

---

## B22. A late webhook can revive a cancelled subscription

**What.** Stripe delivers webhooks out of order and retries them. A
`customer.subscription.updated` that was delayed behind a `deleted` will be
applied after it, and `SubscriptionStore.upsert` is last-writer-wins by design —
so a cancelled customer gets their access back until something corrects it.

**Why it was left.** §7 designs `npm run reconcile` as the daily repair, and it
is built and tested. The window is therefore ≤24h and self-closing, which is the
same blast radius §12 already accepts for F21. Kelly was offered the guard at
plan time and the plan's stated default — leave it to reconciliation — stood.

**What would fix it.** A `last_event_at` column, and refusing any write whose
Stripe event `created` timestamp is older than the one already applied. About
ten lines plus tests, and `db.ts` has predicted it in a comment since the table
was written.

**Cost.** Small. **Worth doing before the first real subscriber, not after** —
the failure direction is free access, which nobody complains about.

---

## Previously deferred

Recorded here so the deferrals live in one place rather than in commit messages
and memory. Consolidated 2026-08-10; not new decisions.

- **Research and citations.** Every finding still reports `source_type: none`,
  so the v0 definition of done — "≥1 **cited** finding" — is not literally met.
  Sequenced after the review gate, because the gate produces the human labels
  that make an LLM judge calibratable.
- **Recall.** `docs/design.md` §10 wants it measured against hand-labelled issue
  lists per site, roughly two hours each. Without those lists any recall number
  would be invented, so `npm run outcome` prints none.
- **LLM judge for usefulness.** Needs ~50–100 human labels to calibrate against.
  We have 17.
- **Not built at all:** Content agent, Inngest/Supabase, the nightly priors job,
  F11's daily cost ceiling. *(Stripe Checkout is built but has never been sent a
  request — B21.)* *(The lint gate, re-audit
  diffing, the email gate, the subscribe surface and the question flow have
  since shipped, and Stripe with them; the web app exists as `npm run serve` on
  localhost only. See B21 for what Stripe still owes and B19 before any of this
  is served publicly.)*
- **F7 deviated without being written down.** §0 says "redraft loop (max 2) →
  PARKED"; `lint.ts` quarantines the finding instead, with no redraft and no
  park. Quarantine is the better answer — a redraft loop asks a model to try
  again at the thing it just got wrong — but the doc and the code disagree and
  nothing records which one won. **Decide and amend §12, or build the loop.**
- **F11 has nothing at all.** No spend counter anywhere. Not needed while a
  person runs both queues by hand, which is today's actual spend control; needed
  the day either becomes a cron. Named here so "five failures handled for real"
  is not claimed with four.
- **`docs/quality-bar.md`** still carries one `[UNRESOLVED]` (the post-publish
  correction path) and five `[PROPOSED]` items.
