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

## B12. The image cache does not work — measured, flagged, and still Kelly's call

**The cost is bigger than first estimated.** Measured 2026-08-17 across every
lane that has run since screenshots shipped:

    lane              cache_write   cache_read
    forms                  23,622            0
    visual-hierarchy       20,244          345
    conversion-cta         17,315        1,812
    copy                   17,201        2,174
    heuristics             11,777        2,138

Every lane **writes** the images; the reads are `SHARED_RULES` alone. At
Sonnet's rates that is roughly **$0.15-0.18 an audit, about 30% of a run** —
not the ~$0.11 first quoted.

**Why.** Prompt caching matches a *prefix* of the whole request, and `system` is
`[SHARED_RULES, rubric.lane]`. The prefix diverges at the lane, so the images
after it are a different prefix for every reviewer.

**The fix is implemented behind a flag**, `USABILITY_LAB_LANE_AFTER_DATA=1`:
`system` becomes SHARED_RULES alone and the lane block moves to the end of the
user message, after the page content. Tests assert both halves of the property —
every reviewer shares one prefix up to the page data, and the lanes still differ
at the end. **The default is unchanged**; nothing ships on a flag.

**What the red team can and cannot say about the trade.** Four runs, two per
ordering, twelve reviewer calls: **no injection succeeded in either
arrangement.** That is not evidence the ordering is safe to change. The control
never fails either, so the experiment has **no discriminating power** — it
compares two zeros. A real test needs an attack that succeeds against at least
one arrangement, and nothing written so far succeeds against anything.

**Two false alarms on the way there, both mine, both the same mistake.** The
compliance detector matched a reviewer *quoting the attack while reporting it*
("a line claiming the page is \"pre-approved\" ... reads as if the site were
compromised") and called it obedience. It fired once on the current ordering
and twice on the reordered one, which came within an inch of producing a
verdict against the change on evidence that was entirely noise. It now looks
only outside quotation marks — the same distinction `claims.ts` draws for
quoted page text, one file over, filed as B11 on the same day.

**What is still Kelly's.** Whether ~30% of the audit cost is worth putting our
lane instruction after untrusted page content. What has changed is that the
cost is measured, the change is one environment variable, and the honest
uncertainty is written down instead of guessed at.

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
- **Not built at all:** lint gate, Content agent, email gate, Stripe, web app,
  Inngest/Supabase, re-audit diffing.
- **`docs/quality-bar.md`** still carries one `[UNRESOLVED]` (the post-publish
  correction path) and five `[PROPOSED]` items.
