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

## B5. We rewrote a published page, and the correction path is still UNRESOLVED

**What happened.** 2026-08-13, fixing the pin/severity bug: `results.html` for
`4f8f1271` (basecamp) was regenerated with a throwaway script. The audit is
PUBLISHED, and [`review.ts`](../src/review.ts) explicitly refuses to touch a
PUBLISHED audit — *"Re-reviewing would rewrite what the visitor saw"*. The guard
was bypassed rather than failing; nothing in the audit's history records that
the page changed, and `published_at` still points at the original publish.

**Why it matters.** The page was making a false claim, so changing it was right.
That is exactly the situation the correction path is *for*, and we do not have
one — `docs/quality-bar.md` still carries it as `[UNRESOLVED]`. Today it cost
nothing because the only reader was us. The next time it will not be.

**The decision to make.** What does a customer get when a published finding or
page turns out to be wrong?

- *Silent update* — cheapest, and indistinguishable from the thing we sell
  against. A reader who acted on the old page never learns.
- *Visible correction on the page* — a dated line saying what changed and why.
  Costs a schema field and some rendering.
- *New URL plus a notice* — the old page stays as evidence of what was said.
  Most honest, most machinery.

**Cost.** The decision is minutes; the build is small-to-medium depending on the
answer. **Not mine to make** — noted here so it stops being invisible. When it is
decided, `review.ts`'s refusal should route to that path instead of just
refusing, or the same bypass happens again.

**Also from that session:** the commit message on `335535d` describes the piped-
answers test as *"the one for the bug that shipped"*. It is a regression guard —
that bug was fixed in Slice 4, and the test passes on the pre-fix code. Five of
the other new tests do go red when their fixes are reverted; that one does not.

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

## B11. The quote check has never caught a fabrication, and has flagged five true findings

**Found while verifying B10**, 2026-08-16, by reading every flag it has ever
raised rather than trusting the count.

`claims.ts` asserts that quoted text appears in the page text. It exists to
catch the worst thing this product can publish: a finding that puts words in a
page's mouth. Across 186 corpus findings it has raised **five** flags. **All
five are false positives**, each by a different mechanism:

| audit | quoted | why the flag is wrong |
|---|---|---|
| gov.uk | `"Includes X, Y, Z"` | an *abstraction* of the real pattern, not a quotation |
| cotopaxi | `"United States"` | quoted precisely because it is **absent** from a list |
| basecamp | `"Reserve a seat"` | a *hypothetical* — what a better label could say |
| asana | `"Create Account"` | the page **title**, which nothing can quote (B6) |
| basecamp | `"You're juggling…This all has to happen somewhere."` | an **elided** quote; every fragment is on the page, the string as written is not contiguous |

**Two readings, and they are not the same.** Either reviewers do not fabricate
quotes — in which case the check is a deterrent doing its job and its precision
is beside the point — or it cannot detect fabrication and the flags are noise.
What is certain either way: its current precision is **0/5**, and every flag
becomes a `contradicted` row that drags on the precision metric and routes a
correct finding to a human for adjudication it does not need.

**What a fix would have to distinguish.** A quotation *of* the page from: an
illustration, a counterfactual, an absence, a title, and an elision. Four of
those five are signalled in the sentence around the quote ("such as", "no label
like", "does not list"), which is a judgement about language rather than a
string comparison — so the honest options are to narrow the check hard (skip any
quote preceded by such-as/like/e.g., skip anything containing an ellipsis) or to
downgrade the verdict from `contradicted` to `unverifiable` and stop treating a
missing quote as proof of anything.

**Cost.** Small either way. **What it distorts until fixed:** precision reads
low by roughly five findings, and the review queue carries five items that need
no review. Related: B6, B10.

---

## B12. The image cache does not work, because caching matches prefixes

**Measured 2026-08-16**, immediately after shipping screenshots to reviewers.

Sending the page to reviewers cost **+$0.188 per audit (+40%)**, against the
~$0.10 estimated in the plan. The estimate assumed the images would be written
to the cache once and read by the remaining reviewers. `model_calls` says
otherwise — for the same basecamp page:

    heuristics       cache_write 17177   cache_read 0
    copy             cache_write 17238   cache_read 0
    conversion-cta   cache_write 14823   cache_read 2416

Every reviewer **writes** the images; none reads them. The 2416 tokens that were
read are `SHARED_RULES` alone.

**Why.** Prompt caching matches on a *prefix* of the whole request. Our system
array is `[SHARED_RULES, rubric.lane]`, so the prefix diverges at the lane block
— and everything after it, including the images in the user message, is a
different prefix for every agent. The cache breakpoint on the user content is
working exactly as designed and buying nothing, because no two reviewers ever
share that prefix. `rubrics.ts` documents the ordering that makes SHARED_RULES
cacheable; the same reasoning was not carried through to the images.

**The fix, and its cost.** Move `rubric.lane` out of `system` and into the user
message *after* the page content. The prefix becomes shared rules → images and
capture (identical for all reviewers, cached once) → lane (differs). That should
take the image cost from roughly 3.75x base to 1.45x.

**The trade-off, which is why this is not already done.** It puts our
instructions *after* untrusted page content. Today every instruction precedes
every byte of third-party data, which is the cleanest possible arrangement
against prompt injection. Moving the lane block below the capture weakens that
ordering to save about $0.11 an audit. **Not obviously worth it**, and not a
call to make while measuring a different change.

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
