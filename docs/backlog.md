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

## B21. No real Stripe account has ever been sent a request

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

**Not built pending a decision**, only because it was found mid-B28 and belongs
in its own commit rather than smuggled into a CI change.

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
