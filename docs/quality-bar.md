# quality-bar.md — The Usability Lab

A template for encoding your quality criteria before building with AI.
Fill this in as a team before the first prompt is written.
The conversation it forces is the work.

Update it as your understanding evolves. Version it.
This is a living document, not a one-time exercise.

---

## 1. Purpose

**What problem does this solve?**
Founders can't tell why their site is leaking conversions, and every existing way to find out is too expensive, too shallow, or too unverifiable.

**Who experiences this problem, and when?**
A solo founder or small-team builder with real traffic and flat conversions, in the moment they've stared at their own analytics, know something is wrong, and have no designer to ask — typically right after shipping something (redesign, pricing page) or right before a moment of scrutiny (launch, demo day).

**What would they say if this worked perfectly?**
[PROPOSED] "It found the exact thing that was killing my checkout, showed me a screenshot of it on my own site, and backed it up with actual research — in ten minutes, for free. I subscribed so it keeps watching the site as I ship."

**What would they say if it failed?**
[PROPOSED] "It gave me the same generic checklist any blog post would — 'improve your CTA' — and one of its 'findings' wasn't even true about my site. Felt like AI content, not an expert."

---

## 2. The user in the moment

**What state is the user in when they encounter this?**
Mildly anxious, skeptical of AI-generated advice, protective of their work (they built this site themselves), and impatient — they will abandon a question flow that feels like a lead-capture form. They know their product deeply and their UX vocabulary shallowly ("something feels off" is a real answer we must handle).

**What do they know that the system doesn't?**
Their actual conversion data, who their customers are, what they've already tried, what's a deliberate choice vs. an accident, and what's about to change anyway. The question flow exists to extract the minimum viable slice of this — the system must never pretend it has the rest.

**What do they assume the system can do that it can't?**
That it can see their analytics; that it can audit behind the login wall; that it can fix things, not just find them; that "audit" means everything (SEO, performance, security) rather than UX judgment specifically. Results-page framing must close each of these gaps explicitly.

---

## 3. Behavioral specification

**In normal conditions, the AI should:**
Elicit context in 5–7 questions, spawn only the specialists the answers and page warrant (R0–R5, cap 4, drops logged), produce findings only from captured evidence, attach real citations or honestly report `none`, rank by severity × fixability against the visitor's stated goal, and ship top-3 findings with annotated screenshots — in under 8 minutes, in the kind-curiosity voice, behind founder review.

**When it doesn't know, the AI should:**
Say so structurally, not rhetorically: capture fails → PARKED with an honest "taking longer than expected," never an audit from imagination. No evidence for a claim → the claim doesn't ship. No citation found → `source_type: none`, displayed as "based on our evaluation" rather than a fabricated authority.

**When it is uncertain, the AI should:**
Show derived confidence (high = screenshot-verified, medium = inferred from page text) and exclude low-confidence findings entirely rather than hedging them into the report. Uncertainty is communicated by *withholding*, not by qualifier-stacking prose.

**When the user is wrong, the AI should:**
Lead with the evidence, not the visitor's frame. When the stated concern (messaging) and the found leak (broken checkout) diverge, finding #1 is whatever the evidence says matters most — but the stated concern is always explicitly addressed, kind-curiosity style: "You asked about messaging — here's what we saw there. The bigger leak we found is your checkout." We never silently ignore what they asked, and we never pretend their guess was right. Decided 2026-08-07: trust is built by finding what they couldn't, not by echoing their diagnosis.
[PROPOSED — the smaller sibling case: contradictory question-flow answers (e.g. "e-commerce" + "no purchase goal"). Proceed on best interpretation and state the interpretation on the results page, rather than interrupting the flow to interrogate. Confirm.]

**When it makes a mistake, the AI should:**
Pre-publish: founder review catches it; rejection reason is logged and fed back as a negative example.

Post-publish: **the page is fixed and it says so.** Decided 2026-08-17 (B5). A correction regenerates `results.html` and adds a dated line in our words — "Corrected 18 Aug · the sources behind three findings were missing from this page" — above the findings. `npm run correct -- <audit-id> "<reason>"`; the history is append-only in the event log, and a page corrected twice shows both.

The rejected options and why. *Silent editing* is indistinguishable from the thing this product sells against: a reader who acted on the old page never learns. *A new URL with the old page preserved* is the most honest and was not chosen — pages are files on disk with no hosting, so it is machinery for a guarantee we cannot yet make.

Two things this does not do, recorded so they are not mistaken for solved. **Nobody is notified** — a correction the customer never hears about is half a policy, and there is no email path yet. And a correction **re-renders with today's code**, so it can pick up unrelated rendering changes while the dated line names only the stated reason.

`review.ts` still refuses to re-review a published audit, but now points at the correction path instead of stopping. It had been bypassed twice by throwaway scripts; a guard that can only be stepped around will be stepped around.

---

## 4. What good looks like

**Describe a perfect interaction, step by step.**
Founder pastes URL, answers five questions in 90 seconds, sees "your team is assembling" with the specialists named. Under 8 minutes later: preview shows one finding — an annotated screenshot of *their* checkout with a numbered pin, a plain-language explanation of what it costs them, a Baymard citation, and a confidence tag. They trade their email for the full three. The full page opens themed to their brand, addresses their stated concern up front, leads with the strongest-evidence finding, ends with "we found 11 more — unlock them, and we'll keep watching as you ship" (with a quiet "prefer to talk it through?" link, zero emphasis). They subscribe and screenshot it to their cofounder.

**What does the output look, sound, and feel like when it's right?**
It feels like a senior designer who *looked at their actual site* — specific elements, their real copy quoted back, evidence for every claim, one genuine "this part works well." Never a report dump: three findings, ranked, each actionable this week.

**What would a senior designer say about it in critique?**
[PROPOSED] "The findings are real and the evidence discipline is unusual — I'd trust the confidence tags. My bar: does finding #1 survive me actually using the site for five minutes? If yes every time, this replaces my teardown Loom."

---

## 5. What wrong looks like

**Describe an output that looks right but is subtly wrong.**
A fluent, well-cited finding about "hidden pricing" on a page where pricing appears conditionally after plan selection — the agent misread a dynamic UI from a static capture. Passes every visual check; fails the truth check. This is why confidence derives from screenshot verification and founder review exists.

**Describe an output that is confidently wrong.**
A finding citing "Baymard research shows 68% abandonment from this pattern" where the citation doesn't exist or doesn't say that. One fabricated citation destroys the entire trust position — it is the worst single output this product can produce, worse than no audit. Hence: lint verifies every URL resolves and matches corpus/search logs; `none` is always legal.

**Describe an output that is technically correct but unhelpful.**
Three true findings that never engage the visitor's stated goal — they said checkout abandonment, we shipped a footer contrast issue and a heading-hierarchy nit with no mention of checkout at all. Every finding true, the audit still useless. Rule: evidence decides the lead (per §3), but the stated concern must be explicitly engaged somewhere in the three — and the trajectory suite asserts it.

---

## 6. Voice and tone

**How does this AI speak?**
Sounds like: curious, specific, evidence-first.
Never sounds like: accusatory, alarmist, generic.

[PROPOSED — the trade-off we accept: this voice gives up urgency-based conversion. "You're bleeding $X/day!!" converts better short-term; we're betting trust converts better once, and compounds. Confirm you accept the slower-burn trade.]

**What does on-brand output look like versus off-brand?**
On-brand: "We noticed your checkout asks for a phone number before showing shipping costs — Baymard's research suggests this ordering costs conversions. Worth testing the reverse? (One thing that's working: your guest checkout is genuinely fast.)"
Off-brand: "CRITICAL: Your broken checkout is destroying your revenue. You failed to follow standard practices."

**What does the AI never say, even if prompted?**
Second-person accusatory constructions ("you failed," "your mistake"); doom superlatives ("critical," "disaster," "broken") unless severity-4 with high confidence; any claim of certainty about the visitor's business outcomes ("this will increase conversions 20%" — we say "research suggests," never promise); anything about a competitor's site beyond factual pattern observation.

---

## 7. The not-doing list

**This product refuses to:**
Ship a finding without an evidence pointer. Fabricate or embellish a citation (`none` is legal). Include low-confidence findings, even hedged. Audit behind a login/signup wall. Publish a site's *first* audit without founder review. Promise business outcomes.

**This product will never do, even if asked:**
Implement fixes or generate redesigns ("they generate; we evaluate" — the moment we generate, we compete on the wrong axis and our evaluation becomes self-serving). Use one customer's data in another's audit. Contact or out a third-party site someone submitted (F18: public-page audit only, no outreach to that domain). Silently degrade audit quality to save cost — deferral over dilution.

**We have considered and deliberately declined:**
- Cold outbound teardowns (the original design) — declined for the inbound platform: consent transforms the tone problem, and the customer's answers are better context than scraping.
- A separate Competitor Agent — absorbed into Research; comparison is evidence, not a parallel audit.
- Auto-publish of first audits — declined, permanently: the risky claim is the first judgment on an unseen site, and the asymmetry (one wrong public claim vs. minutes of review) isn't close. Amended 2026-08-07 for the subscription model: **re-audits of an already-reviewed site auto-publish, with 1-in-5 sampled review; any customer correction flips that site back to full review.** Re-audits are diffs against findings a human already vetted — a different risk class, deliberately treated differently.
- Full report for free — three findings free, eleven behind the call; the withhold *is* the business model, and stating "we found 14, here are 3" honestly is on-brand.

---

## 8. Ethical boundaries

**What user autonomy must this always preserve?**
The founder decides what to fix and whether to book — we inform, never pressure. No dark patterns in our own funnel (we'd be auditing ourselves into hypocrisy — UC-11 checks this literally). The email gate takes an address, not a commitment; results remain accessible without a call.

**What data does this handle, and what does it never do with it?**
Captures of public pages (90-day TTL), question answers, an email, engagement events. Never: cross-customer leakage (priors are aggregates by construction), selling or sharing the email, training on customer data, retaining captures past TTL. Deletion = one audit_id cascade.

**Where might this cause harm, and how have we addressed it?**
A wrong public-feeling claim about someone's work → evidence discipline, derived confidence, founder review, correction path (§3, pending). Prompt injection from an audited page turning the system against a visitor → §9.8 defenses + red-team gate at 100%. Discouragement: a brutal audit of a solo founder's life's work → kind-curiosity lint including the mandatory genuine positive.

**Who could be disadvantaged by this, and what have we done about it?**
[PROPOSED] Sites outside our fixture distribution (non-English, heavy-JS apps, unconventional but *intentional* design) risk confident misjudgment — v0 scopes to English and parks on capture failure rather than guessing. Priors trained on tiny n could encode early-customer bias into question weights — delta caps and n≥10 freezes bound this. Flag honestly in course writeup: at n=15, the growth loop is a demonstrated mechanism, not a validated one.

---

## 9. Criteria for AI-generated output

**Every output must:**
Trace to a Finding with a valid evidence pointer; carry derived (never self-declared) confidence; cite a resolving URL or `none`; pass tone lint (no accusatory second person, ≥1 genuine positive, no unearned superlatives); lead by evidence strength while explicitly engaging the stated concern; validate against the handoff schema.

**An output fails the bar if it:**
Contains any sentence without a finding back-reference; cites anything unverifiable; includes a low-confidence finding; echoes imperative text from the audited page (injection tell); promises outcomes; or would embarrass us if the customer screenshotted it to Twitter — the operational test.

**Who reviews output, and what are they specifically looking for?**
Kelly (founder), pre-publish, against exactly four questions: Is finding #1 true of this site? Does any claim outrun its evidence? Would I send this to a friend's site? Does it engage their stated concern, even when the evidence leads elsewhere? Rejection reasons logged: wrong-finding / tone / evidence-weak / off-goal.

**At what stage does review happen? Who has authority to reject and send back?**
First audit of any site: after lint, before publish (REVIEW_PENDING); founder has sole reject authority; rejection routes to redraft (max 2) then PARKED; no agent and no schedule pressure can bypass this gate. Re-audits of subscribed, already-reviewed sites: auto-publish after lint, with 1-in-5 sampled founder review; a customer correction or a failed sample flips that site back to full review until re-earned. A paying subscriber's re-audit never waits on a human by default — but no site's *first* judgment ever skips one.

---

## 10. How we know

**What user signal tells us the bar is being met?**
Preview → email conversion (they traded contact for findings = findings felt valuable); full-results dwell + finding-level clicks; subscriptions started; month-2 retention with monitoring left on (the real verdict on ongoing value); the qualitative gold signal: replies that engage with a specific finding rather than the product ("how do I fix #2" > "cool tool").

**What signal tells us quality has slipped?**
Founder reject rate > 30% trailing-10; sampled re-audit review failures; `none`-citation rate > 50% (evidence corpus going stale); confidence calibration drop in outcome suite; question-flow abandonment rising (we got greedy or boring); month-2 cancellations clustering right after first fixes ship (one-and-done churn = the monitoring framing isn't landing); any customer correction of a published finding (each one is a full retro, not a ticket).

**How often do we review these criteria, and who owns that review?**
[PROPOSED] Kelly owns it; weekly during the course build (alongside the retro habit), then monthly. Any red-team failure or customer correction triggers an immediate out-of-cycle review. Confirm cadence.

---

## Metadata

Last updated: 2026-08-17
Updated by: Kelly (facilitated with Claude)
Version: 0.4 — post-publish correction path decided 2026-08-17 (dated correction on the page; B5); no [UNRESOLVED] items remain. [PROPOSED] items still pending confirmation.
Approved by: —

---

Embed this file in your tooling so it travels with the work.
This document should live where the work lives, not in a folder nobody opens.
MIT Licensed — Owl-Listener (MC Dean)
