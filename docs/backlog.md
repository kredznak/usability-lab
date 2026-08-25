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

## B21. ~~No real Stripe account has ever been sent a request~~ — DONE 2026-08-25

The title is kept because it was true for seven days and is the whole point of
the entry. Closed by a card, a webhook, a cancel, a stale replay and a renewal —
the measurements are at the bottom, under the two status lines that kept
promising them.

**Status 2026-08-18: the guessing is gone; the sending has not happened.**
**Status 2026-08-19: they have been sent to a fake Stripe that knows the schema.
What is left needs an account and a card.**

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

### The requests have now been sent — 2026-08-19

Not to Stripe. To **`stripe-mock`**, Stripe's own server, generated from their
OpenAPI spec: `brew install stripe-mock`, and `STRIPE_API_BASE` — a seam that
already existed — points `liveStripe` at it. `src/stripe-live.test.ts`, ten
tests, each watched failing with its fix reverted.

What that newly covers, none of which a stub could: the form encoding, the auth
header, the pinned `Stripe-Version`, a fresh idempotency key per POST and none
on a GET, the `status=all` paging loop, error text that does not carry the
secret key, and `readSubscription` parsing a subscription object shaped by the
spec instead of by my typing. **Misspell `line_items` and the request is now
refused** — the stub accepted everything.

Two findings worth keeping:

- **Stripe's spec agrees that `current_period_end` is not top-level.** The
  fixture carries it only inside `items.data[]`. That is the docs finding above,
  confirmed a second time from a different source.
- **stripe-mock 401s on a key with underscores after the prefix.**
  `sk_test_NEVERLOGTHIS9f3a` authenticates, `sk_test_NEVER_LOG_THIS_9f3a` does
  not, and the refusal is indistinguishable from a wrong key.

### What is still open

**stripe-mock validates top-level parameter names only.** Measured, not assumed:
`line_itemz[0][price]` and `subscription_datum[…]` are 400s;
`subscription_data[nonsense_key]` and `line_items[0][quantityy]` are 200s. So
the one field this file most needs to be right — **`subscription_data[metadata]`,
where a typo means every customer pays and stays locked out** — is still covered
by documentation alone.

**And nothing has charged a card, delivered a webhook, or round-tripped
`ul_email` back out through a `customer.subscription.*` event.** That needs an
account. `docs/stripe-runbook.md` is the half hour: make the price, run
`stripe listen`, buy one with `4242 4242 4242 4242`, watch the row appear,
cancel it, reconcile.

**Do not mark this done from a passing `stripe:check`, and do not mark it done
from a green `stripe-live.test.ts` either.** Both prove shape. Neither proves a
payment, and the failure they cannot see is the expensive one.

### The green suite was never green. 2026-08-24.

The paragraph above warns against trusting `stripe-live.test.ts`. It was worse
than that: **the suite had never run.** `stripe-mock` was never installed —
not on the machine that wrote the tests on 2026-08-19, and not in CI once that
existed on 2026-08-24. Every full run reported

```
pass 675   skipped 10
```

and those ten were all of them. The only check that our requests match Stripe's
own schema was reporting a pass by not running — B31's defect with a different
filename, and it survived five days and a machine move because a skip looks
exactly like a thing that did not need doing.

The runbook said `brew install stripe-mock`, and there is no Homebrew on this
Mac. The release tarball needs none; `docs/stripe-runbook.md` step 0 has it.

**Now:**

```
703 passing, 0 skipped
```

**And the suite has teeth, watched rather than assumed.** B21 claims "misspell
`line_items` and the request is now refused". Done, on this machine: changing
`line_items[0][price]` to `line_itemz[0][price]` in `src/stripe.ts` fails 4 of
the 10 tests. Restored.

**CI cannot skip them.** The workflow installs stripe-mock (pinned to 0.202.0,
the spec B21's findings were measured against) and sets
`STRIPE_MOCK_REQUIRED=1`, which turns a missing binary into a failure. Verified
in all three combinations:

```
flag set + stripe-mock absent   -> exit 1
flag set + stripe-mock present  -> exit 0
no flag  + stripe-mock absent   -> exit 0    (a skip is still fine locally)
```

Skipping locally stays allowed on purpose: a contributor should not be blocked
by a binary they may not want. CI installs it a step earlier and has no excuse.

**None of this moves the entry.** It changes "ten tests exist" into "ten tests
run", which is a smaller claim than it sounded like yesterday. Nothing has
charged a card, delivered a webhook, or round-tripped `ul_email` back out
through a `customer.subscription.*` event, and **`subscription_data[metadata]`
is still covered by documentation alone** — stripe-mock validates top-level
names only, which is measured above. B21 stays open on an account and a card.

### CLOSED 2026-08-25. A card was charged and the metadata came back.

The account exists, the card was `4242 4242 4242 4242`, and every claim this
entry has been carrying on documentation alone is now a measurement.

```
2026-08-25 08:14:00  --> checkout.session.completed      <-- [200]
2026-08-25 08:14:01  --> customer.subscription.created   <-- [200]
```

```
email               status  current_period_end        stripe_subscription_id
kredznak@gmail.com  active  2026-09-25T12:13:56.000Z  sub_1U8JEo2NPS7tsyT01vXfvBSr
```

Three things settled, in order of how expensive they would have been:

1. **`subscription_data[metadata]` is spelled right.** Retrieved from Stripe,
   the subscription carries `"metadata": {"ul_email": "kredznak@gmail.com"}`.
   This is the field the whole authorization model hangs on and the one
   stripe-mock cannot check — a typo meant every customer pays and stays locked
   out, silently and in one direction only. It round-tripped.
2. **`current_period_end` is not null**, so B21's finding #1 — that it lives
   inside `items.data[]` and not at the top level — was read correctly against a
   real object rather than a fixture.
3. **The pinned version is the account's version.** `stripe listen` announced
   `2026-07-29.dahlia`, which is exactly `STRIPE_API_VERSION`. The docs the field
   names were verified against are the docs that apply.

`npm run stripe:check` passes 6/6 against the live account. The price was
created from the CLI (`price_1U8J242NPS7tsyT0NohGv2cl`, recurring monthly, 2900,
`livemode: false`), which sidesteps the one-off-price trap by construction.

**And the runbook nearly cost us the thing it was written to protect.**

Step 3 said `--forward-to localhost:4000/stripe/webhook`. The CLI sends
`Host: localhost:4000`; the server 308-redirects every host that is not the
canonical one. **Every webhook would have bounced.** The customer pays, reads
"Payment received", and is never granted access — F21, arriving by a line in a
document rather than by a dropped event.

It was caught by probing the route with `curl` before spending the card, which
is worth more than the fix: nothing in the test suite could have found it,
because the test suite does not know what the runbook says. The 308-vs-301
choice is what would have made it *loud* rather than silent, and the comment
above that redirect called it "a branch written for a case that cannot currently
occur". It occurred within ten minutes.

~~**What is still not proven.** A renewal — the second month's invoice — and the
`customer.subscription.deleted` path from a dashboard cancel. Step 7 covers the
cancel; nobody has run it yet.~~

**Step 7 run, same day.** The cancel path is measured:

```
09:42:52  --> customer.subscription.deleted  [200]
kredznak@gmail.com  canceled   current_period_end (null)
```

and the results page went back to the subscribe pitch with the re-audit button
and the dashboard link both gone — the last of those because the account link is
minted only for a subscriber, which is the guard working rather than a
coincidence. The replay that followed is written up under B22, which this run
also closed.

~~**What is left, and it is now one thing: a renewal.** No second month's invoice
has ever been charged, so `invoice.payment_succeeded` and the period-end
extension that follows it are still untested. `stripe listen` is not even
subscribed to that event. Nothing in the product reads it today — access hangs
on `customer.subscription.updated` carrying a new `current_period_end` — so the
open question is whether that update actually arrives on renewal, which only a
renewal answers. Stripe test clocks can force one without waiting a month.~~

### The renewal, forced with a test clock. B21 CLOSED, 2026-08-25.

A clock, a customer on it, `tok_visa` as the default payment method, and a
subscription on the real price — then the clock advanced one hour past the
period end. Its own address, so the row under test was never the founder's.

```
09:56:28  customer.subscription.created  [200]   period end 2026-09-25
09:59:30  customer.subscription.updated  [200]   period end 2026-10-25
```

```
invoice in_1U8Kpx…  billing_reason subscription_create  amount_paid 2900  paid
invoice in_1U8Ksv…  billing_reason subscription_cycle   amount_paid 2900  paid
```

**The open question is answered: yes.** `customer.subscription.updated` carries
the new `current_period_end` on renewal, one month forward, so access extends
without this product reading `invoice.payment_succeeded` at all. The event we do
not subscribe to is the event we do not need — which was a guess when the
endpoint was written and is now a measurement.

Worth keeping, because it was the risk: had the renewal *not* carried the date,
every subscriber would have lost access one month after paying, and the failure
would have been invisible until the first customer hit their second month —
long after anyone was watching. That is F21 with a thirty-day fuse.

Cleaned up afterwards: subscription cancelled, clock deleted, no test objects
left on the account. The local row stays as `canceled`, which is what happened.

**B21 has nothing left in it.** Checkout, the metadata round-trip, the period
end, the cancel, the stale replay (B22) and the renewal are all measured against
a real account. What is *not* covered anywhere: a failed renewal —
`past_due`, a declined card, `invoice.payment_failed` — which `mapStatus`
handles by construction and nothing has exercised. That is a new entry's worth
of work, not a loose end on this one.

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

### Shipped 2026-08-24, before the runbook is walked

Done in the order the entry asked for: before a real subscriber exists, and
before step 6 of `docs/stripe-runbook.md` creates one.

`subscriptions.last_event_at` — Stripe's `created` on the newest event applied
to the row, unix seconds, migrated with the same `PRAGMA table_info` +
`ALTER TABLE` pattern as `baseline_audit_id` and `attempts`. `upsert` takes an
optional `eventAt` and returns whether it applied; the webhook passes
`check.event.created`, which meant adding `created` to `StripeEvent` — it was
parsing `id`, `type` and `data` and throwing the timestamp away.

**The prediction in `db.ts` was right, including the fix.** That comment said
ordering would start to matter "the first time a cancel lands before the
renewal it followed", and that the answer would be "Stripe's own event
timestamp, not a lock". Both stood.

**Three decisions worth the words.**

*Strictly older, never older-or-equal.* Stripe stamps `created` in whole
seconds and sends several events inside one — `customer.subscription.created`
and `.updated` routinely share a timestamp. Rejecting ties would drop
legitimate events, and dropping a real update is worse than briefly applying a
same-second one, which reconciliation covers anyway.

*A write with no `eventAt` always applies, and leaves `last_event_at` alone.*
Reconciliation is the repair for everything this guard cannot see — an event
Stripe never delivered leaves no timestamp to compare against — so it must
never be blocked by it. And `COALESCE` rather than assignment, so a nightly
reconcile cannot erase the ordering a webhook established; without that, a
stale webhook arriving after the job would be applied all over again. That is
the subtlest of the tests and the one worth keeping.

*A refused write still answers 200, and records `webhook.stale`.* Delivery
succeeded; we chose not to apply it, and a non-200 would have Stripe redeliver
the same stale event forever. Recorded rather than dropped, because a write
that silently does nothing is exactly the shape B27 is about.

**Verified with four reverts, each watched failing:** removing the guard fails
3 tests, rejecting ties fails exactly 1, dropping the `COALESCE` fails exactly
1, and not passing the timestamp from the webhook fails exactly 1. 711 tests,
0 fail.

**What it does not do.** It orders writes that arrive out of order. It does
nothing about an event Stripe never delivers at all — still reconciliation's
job, still F21's ≤24h. And it is not replay protection: deduplicating by event
id is a different problem, deliberately not conflated with this one.

~~**Unproven by measurement**, like B30 and B32 before it: no real webhook has
ever reached this code. Step 6 of the runbook is where it first will.~~

### Measured 2026-08-25, with a real Stripe event, and it held.

The subscription bought that morning was cancelled, then the **earlier**
`customer.subscription.created` event was replayed with `stripe events resend` —
a redelivery arriving after a `deleted`, which is precisely the sequence this
entry was written for.

```
09:42:52  --> customer.subscription.deleted  [200]     status -> canceled
09:46:14  --> customer.subscription.created  [200]     (the older event, replayed)
```

The row did not move:

```
kredznak@gmail.com  canceled  last_event_at 1787665371   (the cancel, not the replay)
webhook.stale  {"type":"customer.subscription.created","created":1787660039}
```

Without the guard that replay sets `status = active` and a customer who
cancelled is subscribed again — billed by nobody, granted access by us, and no
event anywhere saying it happened. The 200 matters as much as the refusal:
Stripe must not retry an event we have deliberately declined.

Two things this run also settled that the entry did not claim:

- **`current_period_end` is cleared on a cancel**, so access does not hang on a
  stale date after the status flips. Both halves of `isActive` agree.
- **The refusal is visible.** `webhook.stale` carries the event type and
  Stripe's `created`, so a redelivery storm is diagnosable rather than a silence.

---

## B23. A research step died and the metric read it as a thin corpus

**Found 2026-08-19, while fixing the uncited rate.**

**Corrected the same day, before building anything: the crash itself was already
fixed, and two of the three claims below were wrong.** Kept in full rather than
rewritten, because what an entry got wrong is worth as much as what it got right.

- **The crash cannot recur.** The duolingo research call ran at 11:34 UTC on
  2026-08-17; `1bb5cd5` landed at 13:23 UTC and replaced `messages.parse()` —
  which lets the SDK throw on malformed JSON — with `messages.create()`, reading
  `stop_reason` before touching the body, and swapped the token formula for a
  flat ceiling. `researcher.ts` names this exact error in a comment: *"Truncation
  used to reach us as 'Unterminated string in JSON at position 1616', which
  describes the symptom and hides the cause."* The audit predates its own fix by
  two hours.
- **"The founder gate does not show it" was wrong.** `render.ts` puts the full
  degraded list on `results-full.html`, and duolingo's page carries it verbatim,
  error text and all. What is true is narrower: **`npm run review` — the terminal
  where keep/cut actually happens — shows lint flags and not degradation.**
- **"The metric absorbed it" was right**, and is fixed as of `19d50a2`.

**What is actually left**, and it is small: `degraded` exists only as rendered
HTML, never as data, which is why `outcome.ts` had to infer research failures
from `model_calls` instead of reading them. Writing it as data and mirroring the
lint block at the terminal gate is the whole of it. **The alarm added to
`npm run outcome` currently reports a bug that no longer exists** — worth knowing
before anyone acts on it.

**What happened.** On the duolingo audit (`2a5a7f87`) the researcher failed:

```
Failed to parse structured output as JSON:
Unterminated string in JSON at position 1616 (line 1 column 1617)
```

`ok=0`, zero tokens billed, 95 seconds spent. Eight findings published with no
citation. The audit is `PUBLISHED`.

**What was not silent.** `index.ts` did its job — `research.degraded` was pushed
onto the run's degraded list, stored on the record, and printed as
`DEGRADED: research: ...` at the end of the run. This is not a missing guard.

**What was silent is everything after that.** Nothing downstream reads it:

- **The founder gate does not show it.** `review.ts` never mentions `degraded`,
  so the person deciding whether to publish sees eight uncited findings and no
  reason to think anything went wrong.
- **The metric absorbed it as judgment.** Until today `npm run outcome` counted
  those eight as honest declines. A crashed step and a thin corpus produce
  identical numbers, and the remedy for one — add sources — does nothing for the
  other. `citationBreakdown` now separates them; that is a report, not a repair.

**Why this is worth a number.** §12's F7 covers a *reviewer* failing schema
validation. This is the Research step failing it, and the consequence is
different in kind: a quarantined finding is visibly absent, while an uncited
finding looks exactly like the honest ones. **The failure mode is a page that
reads as well-evidenced work when a whole step did not run.**

**What would fix it.** Two candidates, both small, neither chosen:

1. Surface the degraded list at the gate, so publishing over a failed step is a
   decision rather than an oversight.
2. Retry the researcher on a parse failure. `researcher.ts` already handles
   `stop_reason === "max_tokens"` explicitly; this failure got past that, so the
   truncation is happening somewhere the existing check does not look. **Worth
   understanding before adding a retry** — a retry around a bug that is not
   truncation would just spend twice.

**Cost.** Small either way. **Ask before building** — §0 handles F1, F7, F9, F11
and F21 in v0, and this is a sixth failure, not one of those.

---

## B26. ~~The rate limiter collapses behind any TLS terminator~~ — DONE 2026-08-20

Found while planning the deploy, not by anything failing.

`asksByClient` allows five audit requests an hour per client, keyed on
`req.socket.remoteAddress`. Honest on localhost; behind a proxy every request
arrives from the proxy, so five an hour became the budget for the entire
internet and the sixth visitor of the hour would have been refused. Not
hardening — the site failing on day one, in a way that reads as a broken router.

The obvious fix is worse than the bug: reading `X-Forwarded-For` by default
turns a per-client limit into a per-header-value limit, which is none at all.
So `clientip.ts` reads a header **only when an operator names it** in
`USABILITY_LAB_CLIENT_IP_HEADER`, and unset behaves exactly as before.

Verified, not reasoned about: six requests from one address → the sixth 429s,
and a second address immediately after is unthrottled. With the variable unset,
six *different* addresses share one bucket — which is both the collapse and
proof that a forged header is ignored.

`preflight.ts` now refuses to start when `USABILITY_LAB_BASE_URL` is https and
either this or `USABILITY_LAB_SECURE_COOKIES` is missing. Both faults are
invisible when wrong; a boot warning is read once.

## B24. The homepage cannot audit itself until it is deployed

Opened 2026-08-20, blocked, **not a bug**.

`docs/specs/2026-08-20-homepage-design.md` §5.4 puts a real finding from our own
pipeline on the homepage, and §10 sequences it: build the page, audit it, fix
what is real, embed the result. The first attempt was refused:

```
audit bb4ba4b6-3097-41a3-b76b-54d791bafe3a
http://127.0.0.1:4000/
  capture        failed after 0.0s
CAPTURE_FAILED: that address points at a private network
```

**The guard is deeper than the HTTP route.** It was easy to assume `checkUrl`
only defends `/request`, where a stranger picks the URL. It does not — the
capture path checks too, so nothing in this repo will point a real browser at a
private address, including a CLI run by the person who owns the machine. That is
the stronger design and it stays.

Nothing was spent: the refusal happens before any model call, and the audit's
research outcome is `never`. The row is left in place as an honest record; it is
`CAPTURE_FAILED`, which the corpus and `npm run research:replay` both already
exclude.

**Unblocked by:** a public deploy, which is itself blocked on HTTPS and
`USABILITY_LAB_SECURE_COOKIES=1`. So this waits behind the deploy blocker rather
than being worked around.

**Do not** weaken `urlcheck.ts` or the capture guard to make this convenient. The
placeholder card on the homepage ships with a visible line saying it is a
placeholder, which is the honest interim state — the alternative is a fabricated
finding on the page that sells evidence.

## B25. Every homepage view writes a permanent event row

Opened 2026-08-20, pre-existing, made slightly worse.

`GET /` records `home.viewed` and `GET /start` records `question.started`, both
unconditionally and both permanent under §8. A crawler can therefore grow the
event table without limit, and neither route is rate limited — only `/request`
is.

This was already true when `/` was the form; the redesign adds a second such
route. Named rather than fixed because the fix is a real decision — sample the
views, rate-limit the GET, or accept the growth and prune — and folding any of
those into a design change would have been scope creep.

## B26. The definition of done has never been met

Opened 2026-08-21, measured not guessed.

§0's demo sentence: *"One URL + question answers → published results page with
≥1 cited finding and an annotated screenshot, in under 8 minutes wall-clock,
**three consecutive runs on three different sites**, with every step's events
visible in the funnel dashboard."*

Every published audit, measured:

```
audit      wall   kept  cited  shot   site
0e1456d9   120s     4      0    yes   our own homepage
5112587d   182s    13     11    yes   basecamp.com
139d5f3e   292s    13      3    yes   www.notion.com/pricing
5d121558      ?    13      3    yes   www.irs.gov/payments
2a5a7f87      ?     8      0    yes   www.duolingo.com
25567a70      ?     7      4    yes   linear.app/pricing
8ae363d2      ?    14      7    yes   basecamp.com
52444e83      ?    14      7    yes   www.cotopaxi.com/cart
e16569d2      ?     8      3    yes   asana.com/create-account
4f8f1271      ?    14      0    yes   basecamp.com
```

**Each clause passes somewhere and they have never passed together.**

- **Wall-clock** can only be checked on the five audits that have step events —
  step logging landed 2026-08-17 18:35, and everything above it in the table
  predates it. All five are well under 8 minutes (120s–332s), so the time
  budget is not the problem.
- **Three consecutive** is where it breaks. The three published runs on three
  different sites, 2026-08-17 11:27/11:30/11:34 — linear, duolingo, irs —
  predate step logging *and* duolingo returned 0 cited findings. The two
  instrumented published runs that both cite, 139d5f3e and 5112587d, are
  consecutive — and the next audit, 5b5b3b2a, is FAILED. The streak is two.
- **≥1 cited** is subject-matter dependent, not pipeline dependent, and it is
  the clause most likely to break a streak: 3 of 10 published audits cite
  nothing. See B23 for why our own homepage is one of them.

**What this is not.** Not a regression, and not evidence the pipeline is
broken — 332s and 10-of-13 cited on 2026-08-21 is the best run the project has
had. It is evidence that **nobody has ever run the demo**.

**Do not** pick the three sites for citability. A streak assembled from sites
chosen because they cite well measures the chooser.

### The demo was run, 2026-08-21. The pipeline half passed.

Four requests through the real route — form POST, queue row, `npm run audit --
--queue` — run back to back in one pass, four for four, no failures:

```
audit      wall   find  cited  shot   site
1ccc0425   110s     10      6    yes   basecamp.com/
2ae5a280   128s     11      9    yes   myschools.nyc/en/
b7969d20   148s     11      9    yes   ghost.org/pricing/
96ba2ed5   278s     15      9    yes   buttondown.com/
```

Every clause of §0 that the pipeline controls is met, four times, on four
different sites, consecutively, with every step in the event log: **under 8
minutes** (worst 278s, against a 480s budget), **≥1 cited finding** (worst 6),
**annotated screenshot** on all four. $1.83 for the set, against a $25 ceiling
the same day's F11 work put in place.

Three of the four are fresh sites, never audited before. The basecamp row was a
separate submission of Kelly's with different answers from the 2026-08-21
request, so it produces a different profile and a different audit — not a
repeat. Two of the four question-answer sets were written by Claude rather than
by a site owner, which is the part of this demo that is not real.

**The streak is not yet complete, and the missing step is the founder gate.**
All four sit at REVIEW_PENDING; §0 says *published* results page. Publishing is
Kelly's, and B29 is the reason that is not a formality — the gate has cut
nothing since 2026-08-16.

Also worth reading against B15: the basecamp audit here found 10 findings where
`2928c314` found 13 the same day on the same URL, with different answers. That
is the reproducibility question, not a regression.

### The gate ran, and the streak completed. Measured 2026-08-24.

The four runs above sat at REVIEW_PENDING. Kelly reviewed three of them on the
22nd and 23rd, and ran a fifth audit in between. What the record now holds, in
run order:

```
1ccc0425  basecamp.com/         REVIEW_PENDING   never reviewed
2ae5a280  myschools.nyc/en/     DECLINED
b7969d20  ghost.org/pricing/    PUBLISHED   148s   kept 10   cited 8
96ba2ed5  buttondown.com/       PUBLISHED   278s   kept 13   cited 8
e338784b  theusabilitylab.com/  PUBLISHED   218s   kept 11   cited 6
```

**The last three are consecutive runs on three different sites, and every
clause holds on all three.** Published, annotated screenshot, ≥1 cited finding,
under 8 minutes against a 480s budget, every step in the event log and visible
in `npm run funnel`. All 28 citations across the set resolve (`npm run
sources:check`, 28/28, one redirect). No run between them: `audit.requested` in
the event log goes ghost → buttondown → us with nothing in between.

So the sentence at the top of this entry — *"nobody has ever run the demo"* —
was true when it was written on 2026-08-21 and is false now.

**Why the cited counts differ from the table above.** That one counts citations
across every finding the pipeline produced; this one counts only findings that
survived the founder gate. Ghost went 9 → 8 and buttondown 9 → 8 because review
cut a cited finding from each. Neither is wrong; they have different
denominators, and the published page is the one that owes the ≥1.

**Four things that make this weaker than it reads, none of which unmake it.**

1. **The third site is our own.** §0 says three different sites, not three
   third-party sites, so this passes as written — but a streak whose third leg
   is us auditing ourselves is the least persuasive version of the claim.
   Notably it was not chosen for citability: B23 is the entry about our
   homepage citing badly, and this run cited 6 of 11.
2. **Two of the four answer sets in the 2026-08-21 demo were written by Claude,
   not a site owner** — the caveat above still stands and now sits inside the
   streak. The homepage run's answers are Kelly's own, and they read like it
   (*"Nobody has ever bought one"*).
3. **Publication was not consecutive.** The runs were, minutes apart; the
   reviews came days later and out of order — the homepage published at
   2026-08-22T23:30, before either of the two audits that ran ahead of it.
4. **Nobody watched it happen.** This streak was found by querying the database
   on 2026-08-24, not performed. Every clause is evidenced, and no human has
   ever sat through the demo end to end in one sitting.

**So both of these are true:** the definition of done has been *met*, and the
demo has never been *performed*. Which of those §0 was asking for is Kelly's
call, not this file's. What is no longer defensible is the claim that the
clauses have never co-occurred.

### Closed 2026-08-24 — met, not performed

Kelly's call, made with the four caveats above in front of him: the evidence is
sufficient, and **no fresh runs were bought to decorate it**. Three audits would
have cost about $1.40 and produced a second streak that proved the same thing
the first one already proves.

**Performing it live is a demo-day task, not engineering work.** It needs a
person watching and a person at the gate, and neither is a code change. When it
happens, the thing to capture is the wall clock of the *whole* sitting —
request through founder review to published page — because that is the number
this entry never had. Every measurement here stops at `audit.completed` and the
gate has always been hours or days later.

What stays true and unfixed: the streak's third leg is us, and two of the four
answer sets from 2026-08-21 were written by Claude. A demo run for an audience
should use three sites that are not ours and answers from someone who owns the
site. That is a sourcing problem, not a pipeline one.

### Reopened by mistake on 2026-08-25, and what the mistake bought

**The mistake first.** This entry was read from the top — the title, and the
2026-08-21 table under it — and proposed as the oldest open item with the words
"the streak is two". Two sections and a closure later in the same entry say
otherwise. Three audits were then bought for $1.76, which is within pennies of
the ~$1.40 the section above explicitly declined to spend, for the reason it
gives. **A long entry's conclusion is not at the top, and this file is full of
long entries.**

**What it bought, which is not nothing.** The section above names one number
this entry never had: *"the wall clock of the whole sitting — request through
founder review to published page ... Every measurement here stops at
`audit.completed`."* That is the number these runs produced, and the conditions
for it did not exist on 2026-08-24 — `worker.ts` and the automated gate both
landed that day and nothing had exercised them end to end since.

```
site                        status           queue   request->published   kept  cited  shot
allbirds.com                AUTO_PUBLISHED     11s          244s           15   10/13  yes
posthog.com/pricing         REVIEW_PENDING      8s          held            -   10/15  yes
gov.uk/browse/childcare…    AUTO_PUBLISHED      1s          199s           10    9/10  yes
```

244s and 199s, whole sitting, against a budget of 480s. Both pages read back off
`theusabilitylab.com`: 200, annotated screenshot, real citations — Nielsen
Norman Group on the gov.uk one, not "based on our evaluation" filler. Three
sites, none of them ours, which the section above also asks for. The answers
were still written here rather than by whoever owns the sites, so that caveat
stands unchanged.

**And a clause worth re-cutting.** The middle run held at REVIEW_PENDING because
`claims.ts` disputed a finding, and it was a *correct* hold: PostHog's pricing
page jokes about false scarcity — "1 left at this price!!", "Act now and get $0
off your first order" — and a reviewer read the joke as a dark pattern. So §0's
"three consecutive runs" counts the quality gate working as a failed run. At a
~4% hold rate a three-run streak fails about one time in nine for that reason.
The clause measures whether three pages happened to contain nothing worth a
second opinion, which is not what it was written to measure. Re-cutting §0 is
whoever owns the definition's call; noted, not done.

**B27, caught in the act.** The held audit's entire event trail was
`audit.completed` and then nothing — the status became REVIEW_PENDING with no
event, which is exactly what the funnel means by "changed by something that left
no event". Worse and not previously written down: the *reason* was printed to
stdout and stored nowhere, and `npm run worker` runs detached, so on the
deployment this product actually has, the one fact needed to act on a held audit
lived for the length of a `console.log`. Fixed the same day — `audit.held` is
recorded with the disputed findings before the status is set. That fix is the
one thing here that would not have been found by reading.

---

## B27. A status can change without leaving an event

Opened 2026-08-21. Found while measuring B26.

`5b5b3b2a` emitted `audit.completed` at 01:30:52 on 2026-08-18 with 10
findings, and its row was moved to `FAILED` at 01:34:32 — three minutes and
forty seconds later, by something that recorded no event and left no trace. The
audit's own trail says it finished; its status says it failed. Nothing in the
tracked code sets `FAILED` except the audit runner's `catch`, which always
records `audit.failed` first.

**Why it matters.** `AuditStore.transition()` writes a status; only *some* call
sites also record an event. So the audits table and the append-only event log
can disagree, and here they do. This is the B5 shape again — a write that steps
around the log — and it is how the dashboard came to print `audits failed: 1`
directly below `FAILED 15`.

**Fixed today, partly.** `npm run funnel` now counts failures from rows rather
than events, and prints how many have no recorded cause (16 audits, 1 cause).
That makes the disagreement *visible*; it does not make it impossible.

**What would fix it properly.** Have `transition()` record the status change
itself, so no status can move invisibly. That means `AuditStore` writing to
`events`, which today it does not — a real design decision about whether the
store owns its own audit trail, and worth deciding rather than defaulting.
**Ask before building.**

---

## B28. The evals exist; the gate does not

Opened 2026-08-21. §0 lists "Evals in CI: trajectory suite + 3 injection
red-team fixtures" as shipping in v0, and the leftovers list has carried
"evals in CI" as outstanding without saying which half was missing. It is the
CI, not the evals.

**Both suites exist and pass.**

- `src/orchestrator/trajectory.test.ts` — the trajectory suite.
- `src/injection.test.ts` — the hermetic injection assertions.
- Together: 35 tests, 4.3s, green. They run inside `npm test`.
- `npm run redteam` — **five** fixtures against real calls, not three:
  `inject-visible`, `inject-hidden`, `inject-alt`, `inject-escape`,
  `inject-scope`. §0 under-promised.

**What is missing is enforcement.** §10 wants a PR gate: trajectory 100%,
schema 100%, red-team 100%, any injection success blocks merge. There is
**no git remote** on this repository, so there is no PR, no Actions workflow
and nothing to gate. The only hook is `.githooks/pre-commit`, which scans
staged content for credentials and **does not run a single test**.

So today the evals run exactly when somebody types `npm run check`. That has
been enough while one person commits, and it is the same shape as F11 before
today: a control that exists on paper and is executed by discipline.

**Two ways forward, and they are not equivalent.**

1. ~~**A remote and a workflow.** What §10 actually describes. Blocked on
   creating a GitHub repository — the same "Kelly has to make an account"
   shape as the domain and B21, and about as cheap.~~ **Taken 2026-08-24**, and
   it was as cheap as the comparison predicted. See below.
2. **A local `pre-push` or `pre-commit` step** running `npm run check`. Gives
   the gate teeth today without a remote, at ~5s a commit. But a pre-push hook
   with no remote to push to never fires, so this really means pre-commit —
   which changes the commit workflow on Kelly's machine, and `--no-verify`
   makes it advisory anyway.

**Not built pending a decision**, because (2) alters how Kelly works and (1) is
not mine to create. The honest interim is that `npm run check` is the gate and
it is run by hand.

### Shipped 2026-08-24 — and it still does not block a merge

`.github/workflows/check.yml`. Ubuntu, Node 24, `npm ci`,
`npx playwright install --with-deps chromium`, `npm run check`. That last line
is the whole design: **CI runs the command a person runs**, not a CI-only
variant. Two gates that can drift eventually mean different things, and then a
green badge is a claim nobody has checked.

Measured on a clean clone before any of it was written — `git clone` of the
committed tree, `npm ci`, `npm run check` with no `.env` in the environment:

```
exit 0   685 tests   675 pass   0 fail   10 skipped (stripe-mock absent)
snapshots unchanged (7 agents)
```

**Watched failing before it was trusted passing.** Branch `ci-gate-proof`
carried one changed character — `d.spawn.length <= SPAWN_CAP` weakened to `<`
in `trajectory.test.ts`, an invariant reality violates because some profiles
legitimately spawn exactly four.

```
check #1  43e1f24  ci-gate-proof  FAIL   1m38s   "checkout: spawned 4"
check #2  426eba0  main           PASS
```

Branch deleted after. A gate nobody has seen red is a badge.

**Triggered on `push`, not only `pull_request`.** Everything here lands as a
direct commit to `main`, so a PR-only gate — which is literally what §10 asks
for — would never once have fired. That would have been this entry's own defect
with better decoration.

Also `engines.node: ">=24"` in `package.json`. CI had to name a version and the
repo stated one nowhere; `node:sqlite` and `--env-file-if-exists` make it a
floor rather than a preference.

**This entry stays open, on two things it does not do.**

1. **It blocks nothing.** A workflow reports; only a branch ruleset requiring
   the `check` status stops a red commit landing on `main`. That is a
   repository setting, and the same "Kelly has to click it" shape as the two
   accounts. Until it is ticked, the enforcement gap this entry opened against
   is narrowed — a failure is now loud and dated instead of invisible — but not
   closed.
2. **It does not run `npm run redteam`.** Five injection fixtures against real
   model calls: real money per run, and a repository secret to hold the key.
   §10 puts red-team in the PR gate at 100%, so **half that line is kept** —
   the hermetic assertions in `src/injection.test.ts` run on every push, the
   five live fixtures still run only when someone types the command. A nightly
   schedule is the obvious shape and is not built.

Neither is a surprise; both were named before the work started rather than
discovered after.

**One thing was discovered after**, while reading what CI would actually
execute: `src/hooks.test.sh` guards its `.env` case behind `if [ -f .env ]`,
and `.env` is gitignored. On Kelly's machine that is 6 passing hook tests; on
any fresh checkout, including every CI run, it is 5. The case that never runs
is *"blocks a staged `.env` file"* — the most consequential of them. Logged
separately.

---

## B29. The priors job has nothing to learn from, and the gate is why

Opened 2026-08-21, measured while scoping the last v0 leftover.

§0 ships a "nightly priors job (delta-capped)": the Growth agent reads the
event log and writes versioned priors — question weights, spawn thresholds,
evidence weights — which are, per §5, *"the only channel by which past audits
influence future ones"*. There is no `priors` table and no Growth agent. That
is the small half of the problem.

**The large half is that there is no signal to aggregate.** Every founder
review decision ever recorded, across all ten reviewed audits:

```
115 decisions | kept 108 | cut 7 | keep rate 94% | written reasons 0
```

And the cuts are not spread. They come from two sessions in the first week:

```
4f8f1271  n=17  cut=3   2026-08-11
e16569d2  n=12  cut=4   2026-08-16
0e1456d9  n= 4  cut=0   2026-08-21
5112587d  n=13  cut=0   2026-08-17
...        eight audits, cut=0
```

**Since 2026-08-16 not one finding has been cut, and a severity has never been
adjusted — not once, in 115 decisions.**

Per-reviewer keep rates are correspondingly flat: copy 96% (n=28), heuristics
96% (n=27), conversion-cta 96% (n=23), a11y 100% (n=9). A priors job trained on
this would adjust spawn thresholds on differences of one decision. That is not
learning, it is amplifying noise — and priors are append-only and versioned
precisely because a bad write is expensive to undo (F15).

**Why the gate reads this way.** `Enter` alone keeps and records nothing, so the
cheapest keystroke is also the least informative one. The reason field is
offered — *"Add a reason after the letter"* — and has been used zero times in
115 decisions. The gate's own docstring calls a cut reason *"the only record of
why"*, and that record is empty for the entire corpus.

This is not proof the gate is a rubber stamp; a 94% keep rate is also what a
good pipeline looks like. It is proof that **the two cannot be told apart from
the data**, which is the same problem as B17 and the 200% review row: a
measurement that cannot discriminate. Note also that 4 of the 115 are labels
**I** made on `0e1456d9`, not Kelly's, so even the flat signal is contaminated.

**What to do, in order.**

1. **Do not build the priors job yet.** It would be correct code computing
   meaningless weights, and the versioning would preserve them.
2. Decide whether the gate should make the informative action the cheap one —
   e.g. require a keystroke for keep as well as cut, or prompt for a reason on
   any severity change. **A change to how Kelly reviews, so Kelly's call.**
3. Revisit priors when cuts and reasons carry information. `npm run corpus`
   already excludes nothing here, so nothing is lost by waiting.

**Do not** treat "the pipeline got good" as established. On the evidence it is
untested either way.

### Re-measured 2026-08-24. The gate started talking on its own.

Before writing any code against the numbers above, they were taken again. They
had moved:

```
                  2026-08-21     2026-08-24
decisions              115            165
cut                      7             10
severity adjusted        0              1
written reasons          0              7
keep rate              94%            94%
```

**Every new reason was typed on 2026-08-23, and no code changed in between.**
Three sessions — `b7969d20`, `96ba2ed5`, `2928c314` — produced 3 cuts, the
first severity adjustment in the project's history, and 7 written reasons. The
entry's central sentence, *"that record is empty for the entire corpus"*, was
true when written and false two days later.

They are also not box-ticking:

> *"observation holds but the count is wrong: the capture has 50 identical
> 'Help' tooltips, not 'roughly 40'"*

> *"understated: white on rgb(121,175,251) measures 2.25:1 across the whole
> fill, below the WCAG AA 3:1 floor for large bold text. The primary CTA is
> 4.70:1 and passes. An accessibility failure, not a styling inconsistency"*

So the diagnosis needed changing before the fix did. The gate was not being
rubber-stamped; it was being read carefully and recording almost none of it.

### Shipped 2026-08-24

**A cut or a severity change cannot be recorded without a reason.** If none is
typed inline, the gate asks. Keeps are untouched — 155 of the 165 decisions
were keeps, and charging a keystroke for the common path buys noise, not
signal. Answering the severity a finding already has is not a change and is not
questioned.

**A dash is an answer.** It records `reason_declined: true` with a null note.
Blocking outright would extract *"bad"* from a reviewer with no words to hand,
and a corpus of *"bad"* is worse than an empty one because it looks like
signal. The dash separates **declined to explain** from **was never asked** —
and all 165 decisions to date are the second, indistinguishably.

**Every decision now records how long it took** (`ms`). This is the part aimed
at the entry's actual complaint: reasons only ever exist on the ~7% of
decisions that cut or adjust, so they cannot settle whether a 94% keep rate is
a careful pipeline or a rubber stamp. Dwell time covers all of them. It is a
noisy proxy — an interrupted review inflates it, an obvious finding is honestly
quick — so it is worth reading as a session median and never as a score.

**`review.decided` carries `reasons` and `declined` counts**, so the funnel can
show a session that cut three findings and explained none without opening a
file. Counts, not text.

Verified the way this repo verifies: five separate reverts, each watched
failing. Removing the requirement fails 8 tests; asking on keeps too fails 19;
dropping `ms` fails exactly 1; dropping the event counts fails exactly 1;
making a dash ordinary text fails 2. 693 tests, 0 fail.

**What is still open, and it is the original point.** The priors job is still
not built and should not be — 7 reasons is not a training set, and steps 1 and
3 above stand unchanged. Nothing here has been exercised by a real session
either: no review has yet run under the new rule, so every claim above is a fix
by construction rather than by measurement, exactly as B13 and B30 were. The
next audit through the gate is the evidence.

**And the reasons pointed somewhere this entry did not expect** — four of the
seven are the reviewer checking the pipeline's arithmetic, not its usefulness.
That is B32.

---

## B30. The screenshot sees text the capture text does not

Opened 2026-08-23, found at the gate while reviewing `2928c314` (basecamp.com).

Finding 13 of that audit is a positive: *"The page displays a live counter:
'people are working in Basecamp right now!' next to a number."* Verifying it
against `capture.json` says the claim is unsupported — there is no number:

```
el_10.text        "people are working in Basecamp right now!"
digits in it      false
text_excerpt      no match for /[\d,]{4,}\s*people are working/
```

The screenshot says otherwise. Cropped at el_10's own bbox, it reads
**"160,691 people are working in Basecamp right now!"** — above the fold, in the
hero, in the same 19px link styling as the six nav links stacked with it.

**This is not a flake.** basecamp.com was captured twice, eleven hours apart,
and the two captures are the same size to the byte:

```
2928c314  2026-08-21T13:30:09Z  87/87 elements  6553/6553 chars  no number
1ccc0425  2026-08-22T01:09:16Z  87/87 elements  6553/6553 chars  no number
```

Both screenshots have it — 160,691 on the first run, 87,688 on the second, which
is what a live counter should do. So the extraction drops this node
**consistently**, and has done on every capture of this page we hold.

**How it surfaced, and why that is the worrying part.** Both audits found the
counter anyway, because reviewers see the screenshot as well as the capture.
They just found it with different confidence:

```
2928c314 f13   "...next to a number."                        (hedged)
1ccc0425 f8    "...displays a live figure, \"87,688 people   (quoted exactly)
                are working in Basecamp right now!\""
```

Both are true. Neither is checkable from `capture.json`. At the gate I treated
the missing number as evidence the finding was wrong and was one keystroke from
cutting a correct positive; it survived because I opened the PNG. **A gate that
verifies from the capture alone will cut true findings, and will do it silently.**

**Where it probably comes from.** `visibleText` in `src/capture.ts` assembles
text itself rather than using `innerText`, and skips descendants that are
`display:none`, `visibility:hidden`, `opacity:0`, clipped to nothing
(`width<=1 || height<=1` with `overflow:hidden`/`clip-path`/`clip`), or
off-canvas. Every one of those rules was added for a real defect — the
linear.app duplicated h1, asana's 47%-of-page-text tracking iframe, Cotopaxi's
phantom "Check Out". A rolling-digit counter is exactly the shape that trips the
clipped-to-nothing rule: a short `overflow:hidden` window with digits animating
through it.

**That is a hypothesis, not a finding.** It has not been tested, and the
off-canvas rule is an equally good candidate.

### Tested 2026-08-24. Both hypotheses are wrong, and so is the proposed fix.

Step 1 was run against the live page — capture's exact load sequence (1440x900,
same UA, `networkidle`, the full scroll), then the `visibleText` walk
instrumented to name the rule that drops each node. **No rule fires.** Every
node in the counter's subtree survives every check:

```
a.live-ready         448.5x24.0  overflow:visible  clip:auto   kept
  span               137.1x24.0  overflow:visible  clip:auto   kept
    number-flow       71.7x27.0  overflow:visible  clip:auto   kept   <- empty
  u                  306.7x25.9  overflow:visible  clip:auto   kept
```

**The digits are in a closed shadow root.** The number is rendered by
`<number-flow>`, a custom element whose light DOM has **zero child nodes**;
`el.shadowRoot` is `null`, `::before`/`::after` are `none`, and there is no
`aria-label`. So `textContent`, `innerText` and shadow traversal are all blind
to it, and no skip rule ever had to fire — there was nothing there to skip.

**This kills step 3 as written.** The proposal was to flag an element whose
assembled text is a strict substring of its `innerText`. Measured on the live
page:

```
document.body.innerText  matches /[\d,]{4,}\s*people/   false
document.body.textContent  same                         false
```

`innerText` does not have the number either, so the flag would never fire on
the one case that motivated it. **The gap is not between our walk and
`innerText`; it is between the DOM and the rendering.**

**One source does see it: the accessibility tree**, which is computed from the
rendering and is what a screen reader reads. Playwright's `ariaSnapshot()` on
the visible link, and CDP `Accessibility.getFullAXTree`:

```
link  "112,942 people are working in Basecamp right now!"
image "112,942"                       <- the closed-shadow element, exposed
```

The two hidden duplicate `/live` links on the page return an empty snapshot,
which is worth noting: the AX tree respects `visibility:hidden` on its own.

**Why our capture still misses it.** `accessibleName` in `capture.ts` is
hand-rolled and reads **attributes only** — `aria-label`, `aria-labelledby`,
`<label>`, `title`, `alt`, `placeholder`. It never falls back to computed
content, so `el_10.accessible_name` is `null` and `pageSources` gets nothing.
We compute a name where the browser already computes a better one.

**What to do, in order — revised.**

1. ~~Test it.~~ Done. The answer is above and it cost one Playwright run.
2. **Do not loosen a rule.** Unchanged, and now for a better reason: no rule is
   implicated.
3. ~~Record the browser's accessible name on captured elements.~~ Done.
4. ~~Keep it out of `pageSources`.~~ Decided, and pinned by a test.

### Shipped 2026-08-24

`CapturedElement.rendered_name` — the browser's own accessible name, recorded
**only when it carries text `text` and `accessible_name` do not**. Read over CDP
(`DOM.querySelectorAll` on a `data-ul-ref` stamp, then
`Accessibility.getPartialAXTree` per element), best-effort by construction: every
failure path leaves it null and the capture continues, because this enriches a
capture that already succeeded and F1 owns the failures that should stop one.

Live on the page that produced the entry — capture only, no model spend:

```
ref             el_10
text            "people are working in Basecamp right now!"
accessible_name null
rendered_name   "140,973 people are working in Basecamp right now!"

1 of 87 elements carry a rendered name
```

**One in eighty-seven is the number to keep.** The failure mode of a field like
this is noise — annotate every row and the annotation stops being read.

Two surfaces consume it, and they are the point: `runner.ts` hands it to the
reviewer as `rendered="…"`, and `review.ts` prints a warning at the gate saying
the capture could not read this and to check the screenshot. That is the half
B30 said would change what the gate can conclude.

**`pageSources` does not read it, and `confidence.test.ts` now fails if that
changes.** The AX tree carries screen-reader-only text — linear.app's clipped
duplicate h1, which `claims.test.ts` holds as a *correct* contradiction — so a
reviewer quoting a rendered-only figure still gets no credit from the quote
check. That cost is accepted deliberately: the gate is told instead.

**A bug the tests did not catch and the live page did.** basecamp's `el_42`
reads "Aug 26 Intro to Basecamp Wed, Aug 26, 8:00am" and its accessible name
omits the `aria-hidden` date chip — so the rendered name is a strict *subset* of
the visible text. The first rule subtracted the long text from the short name,
matched nothing, kept the whole name as residue and recorded a revelation where
there was none. Fixed, and in the fixture as its own case. **Two elements became
one**, which is the entire difference between a signal and a decoration.

**Cost, as spent.** One capture change, one field, two render lines, seven
tests. Each new test was watched failing with its fix reverted; the negative ones
against a rule forced always-true, the `pageSources` pins against a widened
source list.

**What this does not fix.** The gate still cannot tell "the page does not say
this" from "we did not capture what it says" for anything the AX tree also
misses — text baked into an image with `alt=""` is still B10, and still
unreachable. This closes one mechanism, not the class.

**Still unproven, and stated plainly:** no reviewer has yet *used* a
`rendered_name`. Every capture before today has null everywhere, and the next
audit of a page with a shadow-DOM counter is the evidence. B13 made exactly this
claim about `position` and it is still unproven four days later — a fix by
construction is not a fix by measurement.

---

## B31. The hook test that a fresh checkout does not run

Opened 2026-08-24, found while reading what CI would actually execute rather
than what the suite claims to cover.

`src/hooks.test.sh` runs six cases against `.githooks/pre-commit`. One of them
is guarded:

```sh
if [ -f .env ]; then
  ...
  check $? 1 "blocks a staged .env file"
fi
```

`.env` is gitignored, so it exists on Kelly's machine and nowhere else.

```
this working copy   passed 6, failed 0
clean clone / CI    passed 5, failed 0
```

**The case that silently vanishes is the one that matters most.** The other
five prove the hook catches a *pattern* — an Anthropic-shaped key, an AWS id, a
private-key block — in a file somebody edited. This one proves it catches the
file that holds all of them at once, staged whole. B28's gate now runs the hook
suite on every push, so the effect is that the check with the highest
consequence is the only one CI has never executed, and its absence is reported
as a pass.

Same shape as the bug this file's own header describes: the first pre-commit
hook piped patterns into `while`, exited 0 from a subshell, and blocked nothing
while looking like it worked. A test that does not run is a weaker version of
the same lie — it does not even have to be wrong to be useless.

**Cost: small.** Write a throwaway `.env` into the temp worktree the test
already builds, instead of depending on the developer's own. No change to
`.githooks/pre-commit` — the hook is not implicated, the test is.

~~**Not built pending a decision**, only because it was found mid-B28 and
belongs in its own commit rather than smuggled into a CI change.~~

### Shipped 2026-08-24, same day

The guard is gone. The test writes `PLACEHOLDER=not-a-secret` to `.env` when
there is no `.env`, runs the case, and deletes only what it wrote.

**Two details that are the whole of the fix.**

*Only when absent.* `CREATED_ENV` is empty unless this script created the file,
and the `EXIT` trap checks it before removing anything. Clobbering a real `.env`
would destroy the one file this repo tells people to keep secrets in — a steep
price for a fixture, and the reason the original author reached for
`if [ -f .env ]` in the first place. That instinct was right; the conclusion
was not.

*Deliberately boring content.* A key-shaped placeholder would have been blocked
by the hook's **content** scan, and the case would have passed without ever
exercising the rule it names. `PLACEHOLDER=not-a-secret` means only rule 1 —
the filename rule — can produce the block.

Verified in a clean clone with no `.env`, which is what CI is:

```
committed code        passed 5, failed 0     ← the case is simply absent
with the fix          passed 6, failed 0     ← and the throwaway is cleaned up
fix + rule 1 deleted  passed 5, failed 1     ← "expected exit 1, got 0"
                      script exits 1, not 0
```

That third line is the one worth having. A restored case that passes no matter
what the hook does would be worse than the guard it replaced — it would report
coverage instead of merely omitting it. And the exit code is checked because
this file's own header exists to remember a guard that printed failure and
exited 0.

On a machine that *has* a real `.env`: still 6 passing, and the file's checksum
is identical before and after (`9b450d62…`).

**Not yet observed:** the CI log saying `passed 6`. The clean-clone run above is
the same situation — fresh checkout, no `.env` — but on macOS `sh` rather than
Ubuntu's `dash`. The next run on `main` settles it.

---

## B32. The founder gate is being used as a fact-checker

Opened 2026-08-24, out of B29's re-measurement rather than by looking for it.

Seven written reasons exist in the whole corpus. **Four of them are the
reviewer correcting the pipeline's arithmetic**, not judging whether a finding
is worth acting on:

```
b7969d20  CUT   "the count is wrong: the capture has 50 identical 'Help'
                 tooltips, not 'roughly 40'"
96ba2ed5  CUT   "the page has two join CTAs, not three (y=584 and y=5177)"
96ba2ed5  CUT   "counts three instances of the join CTA; the capture has two"
2928c314  KEEP  "the '19-24px' range is imprecise: the capture has all seven
                 links at exactly 19px"
```

Every one of these is checkable against `capture.json` by a machine. A count of
matching elements, a claimed range against measured values — the reviewer is
doing by eye what the data already holds exactly.

**Why this matters more than four notes.** Two of the four are *cuts* — the
finding was thrown away because its number was wrong, not because it was
unhelpful. That is the pipeline spending money to produce a true observation
wrapped in a false quantity, and a person spending attention to catch it. It
also contaminates the usefulness labels B29 wants to learn from: a cut for
"miscounted" and a cut for "nobody would act on this" mean opposite things
about the finding and are recorded identically.

**Related and not the same.** `src/claims.ts` already checks quoted text
against the page. This is the numeric sibling — counts, ranges, and
measurements rather than quotes. B15 is the reproducibility question and B10
the alt-text one; neither covers arithmetic.

**Cost: unknown, and worth scoping before committing.** The cheap version is a
lint rule over a small set of shapes — "N of these", "roughly N", "between X
and Y px" — resolved against the elements the finding cites. The expensive
version is general numeric verification, which is a research problem. Do not
start with the second.

~~**Not built.** Four notes is a lead, not a measurement, and three of them come
from two audits on one day.~~

### Shipped 2026-08-24, both halves

**First, the thing that made this worth doing at all.** `checkClaim` was
imported by exactly one file — `corpus.ts`, an offline builder. **It had never
run during an audit or at the gate.** The truth-checker this project built
after two false positives reached a results page was not present at the only
moment a person is deciding. Run against the seven annotated findings it
returns `verified` on all seven, including the three cut for miscounting — and
on the `19-24px` finding it reports *"states 24px, which matches a measured
value"*, passing the exact claim the reviewer flagged, because it asks whether
a number exists somewhere rather than whether the sentence is true.

**A `count` check.** When a finding states one count of repeated things and
exactly one quoted string near it resolves to any element, it compares the
claim against the capture. Matching is exact against visible text *or*
accessible name — the tooltip case lives on `accessible_name` and the button
case on `text`, and exact matching reproduced both hand counts precisely, 50
and 2.

Measured across every finding on disk before it was wired anywhere:

```
381 findings | count check fires on 3 (0.8%) | 2 mismatches, 1 agreement

96ba2ed5-f9  says 3 of "Join your last newsletter platform", capture holds 2   <- cut by hand
b7969d20-f6  says 40 of "Help", capture holds 50                               <- cut by hand
e338784b-f2  says 2 of "Get started", capture holds 2                          <- agrees
```

Both hand-caught errors, no false alarms, on a check that speaks about 1 finding
in 125.

**The first version had three mismatches, and the third was luck.** It flagged
`96ba2ed5-f5` — *"well after the first two instances of the join CTA"* — as
claiming 2 of `"one-click concierge migration"`. The count refers to join CTAs,
an unquoted phrase the capture cannot resolve, so it paired with the only
quotation that did resolve, 115 characters away. It flagged a finding that was
genuinely cut for miscounting, for a reason the finding never gave: the right
answer for the wrong reason, which is this project's recurring failure. A
distance rule (`MAX_COUNT_GAP`, 60 characters) separates it — gaps of 10 and 41
on the true pairings against 115 on the false one. **That constant is fitted to
three observations.** It is a separation, not a law, and the next
counter-example should move it rather than be explained away.

**It cannot contradict.** B11's precedent applied before the fact rather than
after: the quote check shipped with teeth, flagged five findings and was wrong
all five times. A check with no precision record has not earned the right to
call a finding false, so this reports and the judgment stays where it was.

**Second half: `checkClaim` now runs at the founder gate**, printing failing
checks under the finding as *"what the data holds, not a verdict"*. This is
where the value is — the arithmetic arrives while the decision is being made
rather than in a corpus build nobody runs. On the audits we have it prints on
**16 of 381 findings (4.2%)**.

**One of those lines is knowingly wrong.** `1ccc0425` quotes basecamp's live
counter — *"87,688 people are working in Basecamp right now!"* — and the quote
check calls it contradicted, because the digits are in a closed shadow root
that `capture.json` never saw. That is B30 exactly, and B30's `Rendered:` line
prints immediately above it to say so. A gate line that read as a verdict would
make keeping a true finding feel like overruling the machine, which is why the
wording is what it is and why a test pins it.

**Verified** with five reverts, each watched failing: removing the check fails
7 tests, removing the distance rule fails exactly 1, substring instead of
whole-element matching fails exactly 1, letting it contradict fails exactly 1,
removing the gate line fails 2. 703 tests, 0 fail.

### The range half: measured 2026-08-24, and deliberately not built

The `19-24px` case was left for its own measurement rather than bolted on. The
measurement says not to build it.

**Three findings in 381 state a pixel range at all**, and they are three
different problems:

```
2928c314-f3   "el_4 through el_10 ... nearly identical font sizes (19-24px)"
              all seven measure exactly 19px            <- checkable, and wrong

2928c314-f8   "...the seven links stacked above it at 19-24px"
              names no resolvable refs                  <- not checkable

e16569d2-f11  "el_5 and el_6 are both 50px tall, noticeably larger THAN THE
               13-16px surrounding nav, label, and footer text"
              el_5 and el_6 measure 16px                <- a trap
```

**The third one is why there is no check.** The obvious rule — compare the
stated range against the font sizes of the refs the finding names — reports
that `f11` "says 13-16px but its elements measure 16px". The finding claims
nothing of the sort: `el_5` and `el_6` are the *subject*, and the range
describes the surrounding text, which is never named. That is the count check's
`f5` mispairing again, one sentence-shape over.

**And the fix that worked there does not work here.** Distance separated the
count cases (10 and 41 against 115). Here it inverts: the named refs sit
*closer* to the range in the false case than in the true one, so an adjacency
rule would reject the real error and accept the false alarm. Only a semantic
guard — a comparative marker like "larger than" or "surrounding" between the
refs and the range, in the spirit of `NOT_A_QUOTATION` — separates them.

So the ceiling is a check that **fires on one finding in 381**, kept honest by
a rule fitted to exactly one counter-example. That is how the quote check
earned its 0-for-5 record, and this file's own header already says it: a
checker that cries wolf is worse than none.

**Decided 2026-08-24: not built.** The defect is real — the model inventing a
spread it never measured, flagged by hand twice in one session — but it is a
prompt problem wearing a checker's clothes, and the honest place to attack it
is the rubric, not `claims.ts`. Left here so it stays visible if a fourth case
turns up. **A fourth case should reopen this; three is not a corpus.**

**And still unproven:** no reviewer has yet seen one of these lines at the
gate. Same sentence as B30 and B13 — a fix by construction, not by
measurement. `1ccc0425` is sitting at REVIEW_PENDING and would show one.

---

## B33. ~~The product never said it was AI~~ — DONE 2026-08-25

Opened and closed the same day, out of a copy review rather than a bug report.

**The word "AI" appeared on no page this product serves.** Not the homepage,
not the question flow, not the waiting page, not a published audit, not a
single email. What appeared instead, to anyone who had not read the source,
was a small agency: *reviewers*, *your team*, *we*, *a person starts each
audit by hand*. Nobody wrote a false sentence on purpose — "reviewer" is an
accurate word for a sub-agent, and every one of these was written when it was
true or nearly true. The impression assembled itself out of accurate parts.

By 2026-08-25 the product had taken a card payment from someone who had no way
to know.

### Two of the sentences were also false outright

Not misleading — false, and both had been false for a day.

**"A person starts each audit by hand."** True until `worker.ts` shipped on
2026-08-24 and began draining the queue every 20 seconds. The worker's own
docstring says it plainly — "a stranger's submission now becomes a paid audit
with no human in between" — and the waiting page went on saying the opposite.
The table is the whole argument:

```
ocelotchocolate.com   2026-08-25    started 13s after it was asked for
farmtopeople.com      2026-08-24    2674s
basecamp.com          2026-08-21    17436s
```

Thirteen seconds is a timer. Everything above it is a person deciding to spend
money, which is what the sentence was written to describe.

**"Last checks before a person reads it."** False for the ~96% of audits that
skip the founder gate after 2026-08-24 — and this one is worse than stale,
because the correct answer was already in the same file. `stagesFor` hides the
"A person checks it" stage from exactly those audits, deliberately, with a
comment explaining why. Two hundred lines below it, `NOW_DOING.research` and
`NOW_DOING.lint` promised that stage to everyone unconditionally. **The page
hid the person in its list and promised one in its prose, and the careful half
was written first.** One truth kept in two places drifts in one of them.

### What shipped

Disclosure in the product's own voice — plain, once per surface, no apology and
no pitch. The word "reviewers" stays, because it is accurate for six
sub-agents; what it cannot do is arrive unqualified, so the first use on each
surface reads "AI reviewers" and the rest do not.

- **Homepage.** A new paragraph under "What we do", directly below the claim it
  qualifies: *"The critique is written by AI reviewers reading your page.
  Everything they claim points at the element it came from, because you should
  not have to take it on trust."* Deliberately not in the footer and
  deliberately not in `.aside`, this page's 13px footnote voice — a disclosure
  set in the footnote voice is one the layout is apologising for, and a
  disclosure the reader has to go looking for has been designed not to be read.
  This product publishes findings about other people's sites that say exactly
  that.
- **Question flow.** The help text under question 2 names them, because someone
  can land on `/start` from a link without ever seeing the homepage.
- **Waiting page.** The two false sentences replaced; "Your team is on it."
  became "Still working on it."
- **Published audit.** Both footer branches now open "Written by AI reviewers".
  The branch that needed it most looked like it needed it least: *"read by a
  person before publishing"* is true on a founder-decided audit, and it was the
  only mention of a human on the page, sitting alone under eight hundred words
  nobody had written by hand. **A true sentence can mislead by being the only
  one there.**

Every published audit is re-rendered from stored JSON on each request, so the
new footer reached audits published before it existed. Nothing had to be
regenerated.

### Nine tests, and the two that were nearly worthless

Eight reverts, eight red. Two needed rewriting first.

**A test was pinning the false sentence in place.** `the queue does not promise
a turnaround nobody is on the hook for` asserted `/by hand|a person/i` with the
message *"say who starts it, since it is not a machine"*. True when written,
and from 2026-08-24 it would have failed anyone who tried to tell the truth
here. Kept and inverted rather than deleted; the half about durations survives
unchanged, because nothing promises one.

**And the guard could not see the one sentence that was pure invention.**
Restoring `"Your team is on it."` left the whole suite green. That string is
`STILL_WORKING`, the fallback `whatIsHappening` renders only when it meets a
step name it does not recognise — and every page the test built walked
recognised steps or none at all. Fixed by rendering a status with a step
`index.ts` has never emitted. **The one line on the page invented from nothing
was the one line the test could not reach.**

The load-bearing test is neither of those. `the road and the sentence beside it
agree about whether a person is coming` walks every prefix of the pipeline and
fails if the prose produces a human the stage list does not — the two halves of
this file can no longer disagree, which is the defect rather than either
sentence.

### Not done

- **The queued sentence is unverified live.** Every other surface was read off
  `theusabilitylab.com` after the change. That one needs a fresh unstarted
  request, and making one spends money on a real audit. Covered by test only.
- **The waiting page is the only place a customer meets the word before
  paying**, and the free audit precedes the card. Whether the disclosure needs
  to be nearer the payment step is a question this entry does not answer.

---

## B34. ~~The failed renewal has never happened~~ — DONE 2026-08-25

Opened out of B21's close, as the last unexercised branch of the money path.
`mapStatus` maps `past_due`, `unpaid` and `incomplete` onto one status and
always had; nothing had ever produced one. A fix by construction, and the
construction turned out to be the only part that was right.

### Proved with a test clock and a card that stops working

A customer subscribed with a good card, the card swapped for
`tok_chargeCustomerFail`, the clock advanced past the period end, then the card
put back and the invoice paid. The whole round trip, measured:

```
subscribed          stripe active     ours active     ends 2026-09-25   access granted
renewal declines    stripe past_due   ours past_due   ends 2026-10-25   access refused
card fixed, paid    stripe active     ours active     ends 2026-10-25   access restored
```

**Access came back on its own.** No manual step, no reconciliation run — which
is the F21 failure ("customer paid, still locked out") not happening, on the
path most likely to produce it.

### The date moves the wrong way, and only the status stops a free month

Look at the middle row. `current_period_end` went **up** on the failure, from
2026-09-25 to 2026-10-25, because Stripe advances the period when it *raises*
the invoice rather than when the invoice is paid. So the row of a customer who
has paid nothing holds a date a month in the future.

`isActive` requires `status === "active"` as well as a future date, so access is
refused correctly. But db.ts's own note says access "hangs on"
`current_period_end`, and anyone who took that at face value and simplified the
check to the date would hand out an unpaid month against a row that looked
entirely reasonable. `db.test.ts` had the case by construction; it now carries
the measurement.

### What the customer was actually told

The reason this became a copy fix rather than a status fix. Read off the live
site, from the account of someone whose card had just been refused:

```
Status          past_due
Access ran to   2026-10-25
There is no active subscription on this address.
```

Four wrong things in five lines. **`past_due` is a value in a SQLite column**,
rendered straight into the page because `billingPage` had a branch for `active`
and an `else` for everything else. **The date is in the future under a
past-tense label** — that unpaid period end again. And **the last line is
false**: there is a subscription, Stripe is retrying the card for days, and the
page denied it existed to someone who was still being charged.

The dashboard tab said the same thing from the other direction — it took a
single `subscribed: boolean`, so every state that was not paid-and-current
collapsed into "no subscription". **A customer mid-dunning was told they had no
subscription on two tabs at once.**

### What shipped

- **`billingPage` is a switch over `SubscriptionStatus`, not a ternary chain**,
  with a `never` in the default. A fourth status now fails the build instead of
  printing itself to a customer. `BillingView.status` was narrowed from `string`
  to the row's own union, which is what it always was.
- **A real `past_due` branch**: status reads "Payment failed", and the copy says
  the card was refused, that Stripe will keep trying, that everything comes back
  on its own if it succeeds, and where to change the card if it will not.
- **No date on that branch, deliberately.** The only date the row holds is the
  unpaid period end, and the one the customer wants — when the card was refused
  — is not stored. A sentence with no date is honest; the one this page could
  build from what it has would not be.
- **The button says "Update your card"** in that state and "Manage billing"
  otherwise. Same portal, but a customer sent here by a declined card has one
  thing to do and should not have to guess whether it is the right door.
- **`accountPage` takes `{ active, status }`** instead of a boolean, and says
  "payment failed" where it used to say "no subscription". Both are needed: a
  row can say `active` with an expired period end, which is not access.

### Not done

- **Nothing tells them.** All of this is on a page they have to visit. Stripe
  can send dunning mail itself (Settings → Billing → Manage failed payments),
  which is a dashboard setting and therefore exactly the kind of thing
  `deploy-runbook.md` has already been burned by — it belongs in the runbook
  with the rest of the live config, and it is not there yet.
- **No grace period.** Access stops on the first decline while Stripe retries
  for days. That is the harsher default and consistent with how this store
  chooses to fail, but it is now a *choice* rather than an oversight, and it was
  never argued anywhere. A customer whose bank reissued a card loses monitoring
  the same day.
- **`renewal-test@theusabilitylab.com` is still in the table**, cancelled and
  inert, from yesterday's renewal proof. This entry's own row was removed.

---

## B35. A magic link only reaches the one address that owns the Resend account

Opened 2026-08-25. Not closed — half of it is two dashboards this repository
cannot reach.

Mail sends as `onboarding@resend.dev`, which Resend delivers **only to the
account owner**. A stranger who signs up gets no link, no bounce, and no error
row. Since a magic link is the only way into a paid account, **the product
cannot sign up a customer who is not Kelly**, and has not been able to since
mail started working on 2026-08-25.

### What is already in the zone

```
_dmarc.theusabilitylab.com  v=DMARC1; p=quarantine; adkim=r; aspf=r;
                            rua=mailto:dmarc_rua@onsecureserver.net;
```

Inherited from GoDaddy, older than this project. `p=quarantine` instructs
receivers to junk unauthenticated mail from this domain, and there is no SPF and
no DKIM to satisfy it. Harmless so far only because the `From:` is a domain we
do not own. The `rua` is worth changing on its own account: DMARC failure
reports about our mail go to the registrar, where nobody reads them.

### A plausible finding, measured and refuted

The first version of this entry led with an ordering trap — move
`USABILITY_LAB_MAIL_FROM` before the records exist and the domain's own policy
quarantines every magic link, silently. It cost one API call to find out that is
not what happens:

```
403  The theusabilitylab.com domain is not verified.
     Please, add and verify your domain on https://resend.com/domains
```

**Resend refuses to send as an unverified domain**, so that mistake is loud and
never reaches a customer. Kept here because the refutation is the useful part: a
hazard that turns out to be handled is worth knowing about precisely so nobody
designs around it twice.

**The silent failure runs the other way.** Verification is something Resend
checks once; afterwards sends are accepted. Records pruned out of Cloudflare
later, or a zone rebuilt without them, leave mail going out unsigned against
that `p=quarantine` — accepted by Resend, logged as a success here, quarantined
at the far end. Every component reports that it worked.

### Shipped: `npm run mail:check`

The same shape as `stripe:check`, for the same reason — the failures are
invisible from inside. `preflight(records)` is pure, so every interesting state
is tested without touching DNS: a From that outruns the records, a DKIM key that
was never added, SPF put on the apex where Resend does not use it, a DMARC
policy reporting to a stranger. Today, live:

```
warn  from address       onboarding@resend.dev — not theusabilitylab.com
warn  SPF on send.…      missing
warn  DKIM at resend._domainkey   missing
warn  bounce MX on send.…         missing
ok    DMARC              p=quarantine, with neither SPF nor DKIM in place
warn  DMARC reports      mailto:dmarc_rua@onsecureserver.net — nobody here reads it
```

**One bug in it was caught by writing the test rather than the code.** `aligned`
was `SPF && DKIM`; DMARC passes on *either* one, aligned. As written it would
have called a domain delivering perfectly well on DKIM alone a failure — wrong
in the direction that teaches an operator to ignore the tool.

### Not done, and it needs a person at two dashboards

The Resend API key here is **send-only** (`restricted_api_key` on every other
call), which is correct and should stay that way — so the domain cannot be added
from code. `~/.cloudflared/cert.pem` is 282 bytes, the tunnel token only, with
no zone API token in it, so the records cannot be written from here either.

`docs/deploy-runbook.md` §6a is the procedure: add the domain in Resend, put its
three records in Cloudflare as **DNS only**, verify, and change
`USABILITY_LAB_MAIL_FROM` last. Then the part `mail:check` cannot do — send to
an address outside the account and read `Authentication-Results` on what
arrives. `dkim=pass`, `spf=pass`, `dmarc=pass`, or it was delivered on
reputation and will be junked later.

### Also outstanding, from B34

Stripe's dunning mail (Settings → Billing → Manage failed payments) is off, so
nothing tells a customer their card failed except the account page they would
have to think to visit. It is a dashboard setting, which is the class of thing
this runbook has already been burned by, and it belongs in §6a with the rest.

---

## B36. ~~A page that scrolls inside a container captures as one screen~~ — HALF DONE 2026-08-25

Found by Kelly looking at an annotated screenshot and saying "I only see the top
half of the page". The picture was right; everything around it was wrong.

`capture.ts` takes the page height from `document.body.scrollHeight`, and
Playwright's `fullPage: true` uses the same number. **posthog.com/pricing scrolls
an inner panel rather than the body**, so that number was 900 — the viewport —
while the DOM walk found elements down to y=4775.

```
screenshot        1440 x 900
full_height       900
deepest element   4775
below the picture 87 of 121 elements  (72% of the page)
```

Three quarters of the page was audited from extracted text with a one-screen
photograph attached to it, and **nothing anywhere said so**.

### The pins made it worse than silence

`annotate` clamped every off-image box with `Math.min(box.y, height - 1)`, so 8
findings whose elements sat thousands of pixels below the crop were drawn as a
row of numbered badges along the bottom edge — each one pointing at whatever
happened to be cropped there. A pin is a promise that the reader can check the
claim against the picture, and `results.html` makes that promise in words:
"carries the element it refers to so you can verify it yourself".

The clamp is not the bug and has been left alone. Its reason is good — a box
measured a pixel or two past the edge is a rounding artefact, and dropping it
would lose a real pin. It was simply never written for a box 3,700 pixels out.

### Only this page, out of eight

Measured before anything was changed, because "the screenshotter is broken"
would have been the wrong conclusion:

```
allbirds        shot 3662px   deepest 3662   below 0/65
posthog         shot  900px   deepest 4775   below 87/121   <--
gov.uk          shot 2790px   deepest 2790   below 0/74
ocelotchocolate shot 9043px   deepest 9043   below 0/62
farmtopeople    shot 4931px   deepest 4931   below 0/84
theusabilitylab shot 3327px   deepest 3327   below 0/7
buttondown      shot 5492px   deepest 5428   below 0/66
ghost           shot 5904px   deepest 5832   below 0/122
```

Full-page capture works. Container-scrolled layouts defeat it, and they are
common enough — app-shell marketing sites, anything with fixed rails — that this
will recur.

### Shipped: it stops lying about it

- **`isOffImage`**, one predicate, used by both `annotate` (what gets drawn) and
  `pinNumbers` (what the cards offer). They had to be shared: `annotate.ts`
  already carried the comment "the drawn number and the rendered number cannot
  disagree", and fixing only the drawing would have produced a card offering pin
  12 beside a picture with no pin 12 on it.
- **A tolerance of 8px**, which is the clamp's original purpose kept and its
  accidental scope removed. Revert-tested in both directions: removing the check
  redraws the clamped pins, and setting the tolerance to 0 drops legitimate
  edge boxes.
- **The run says so.** `annotated.offImage > 0` pushes a DEGRADED line naming
  both numbers — "screenshot covers 900px of a 4775px page: 8 finding(s) point
  below it and carry no pin" — and the degraded note already renders on both the
  internal and the public page.
- **`annotate.ts` had no tests at all** before this. It has six now.

### Not done: the capture itself

The screenshot is still one screen on these pages. Fixing that means detecting
the scrolling container, scrolling it, and stitching — a real piece of work, and
the wrong thing to attempt in the same change as making the existing behaviour
honest. **The audit is degraded rather than wrong**, which is the state this
project prefers, but it is not the state it should stay in.

Also unaddressed: the reviewers read the full DOM text, so their findings about
the lower page are as good as their evidence ever was — it is only the
*screenshot* evidence that is missing. Whether an audit where 72% of elements
have no visual evidence should publish at all is a policy question this entry
does not answer.

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
- **Not built at all:** Content agent, Inngest/Supabase, the nightly priors job.
  *(F11's daily cost ceiling shipped 2026-08-21 — see below.)* *(Stripe Checkout is built, and its requests run
  against `stripe-mock`, but no real account has ever been sent one — B21.)* *(The lint gate, re-audit
  diffing, the email gate, the subscribe surface and the question flow have
  since shipped, and Stripe with them; the web app exists as `npm run serve` on
  localhost only. See B21 for what Stripe still owes and B19 before any of this
  is served publicly.)*
- **F7 deviated without being written down.** §0 says "redraft loop (max 2) →
  PARKED"; `lint.ts` quarantines the finding instead, with no redraft and no
  park. Quarantine is the better answer — a redraft loop asks a model to try
  again at the thing it just got wrong — but the doc and the code disagree and
  nothing records which one won. **Decide and amend §12, or build the loop.**
- **F11, built 2026-08-21.** `src/spend.ts` plus a `spentOn` counter over
  `model_calls`, checked between audits in *both* queue runners — they share one
  bill, so guarding one would have guarded neither. Over the ceiling, a request
  is left unclaimed rather than started, so it keeps its place and runs
  tomorrow. Proved end to end against a seeded database: refused at $999 of
  $25, and the same queue ran when the ceiling was raised, which is what says
  the ceiling stopped it rather than the environment.

  **The numbers were measured before they were kept.** Lifetime spend is
  **$21.93** over 294 calls; the worst day was **$8.04**; the worst single audit
  **$1.16**. So §11's $25/day is about 3× the worst day we have ever had, and
  the whole project has spent less in its life than one day is allowed. The
  paper figure is kept — a backstop should sit well above normal — but it is now
  a number that can be checked instead of one that could not. `npm run funnel`
  prints today's spend against it.

  What this does *not* do: the per-audit $3 ceiling (§11's DEGRADED-then-PARKED
  path) is still unbuilt. Worst observed is $1.16, so it has never been within
  2.5× of firing either.
- **`docs/quality-bar.md`** still carries one `[UNRESOLVED]` (the post-publish
  correction path) and five `[PROPOSED]` items.
