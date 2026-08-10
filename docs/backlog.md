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

### B1. Persist the Synthesizer's exclusions

**What.** `SynthesisResult.excluded` carries `{ id, agent, reason }` for every
finding the Synthesizer cut. `src/index.ts` prints the *count* to the console at
run time and writes none of it. The reasons are gone the moment the process
exits.

**Why it matters.** Precision only measures findings that survived. If the
Synthesizer is systematically cutting the *good* ones, every metric we have
would keep looking healthy while the product quietly got worse. On `1e6d5d13`
roughly 30 findings went in and 17 came out — reconstructed from token counts,
because the record itself does not exist. That is a third to a half of the
audit's raw output that we cannot inspect.

**Cost.** One line to write `excluded` into `findings.json`, a little more to
surface it. Small.

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
