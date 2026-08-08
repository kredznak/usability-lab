# The Usability Lab — Use Cases

Each use case is the same pipeline with different orchestration: the visitor's answers route to a question-flow path, which determines the spawn set, research direction, and output emphasis. This file is the routing spec.

**Course scope:** UC-1, UC-4, UC-5 fully built (visibly different rosters + evidence = demo contrast). UC-2/3/6 are near-free variants. UC-7 through UC-10 are roadmap. UC-11 is internal QA + demo beat.

---

## Routing overview

| # | Use case | Persona | Spawn set | Lead evidence | Status |
|---|---|---|---|---|---|
| 1 | Conversion leak | Solo founder | heuristics + forms + conversion-CTA | Conversion benchmarks | **Build** |
| 2 | Pre-launch check | Solo founder | broad spawn (cap 4) | General usability | Variant |
| 3 | Post-redesign validation | Small team | heuristics + visual-hierarchy + copy | Before/after patterns | Variant |
| 4 | Checkout abandonment | E-commerce | forms (lead) + conversion-CTA + heuristics | Baymard checkout studies | **Build** |
| 5 | Signup/onboarding friction | SaaS | forms (lead) + conversion-CTA + copy | Form-field & onboarding research | **Build** |
| 6 | Pricing page confusion | SaaS | copy (lead) + conversion-CTA | Competitor pricing pages | Variant |
| 7 | Accessibility posture | Compliance-driven | a11y (lead) | WCAG / EAA guidance | Roadmap |
| 8 | Agency white-label | Freelancers/agencies | per client answers | Client-facing citations | Roadmap |
| 9 | A/B hypothesis generation | Growth marketer | per concern | Test-result literature | Roadmap |
| 10 | Demo-day polish | Founder pre-raise | visual-hierarchy (lead) + copy | First-impression research | Roadmap |
| 11 | Self-audit | The Usability Lab itself | broad spawn (cap 4) | Own priors | Internal |

---

## Core use cases (build)

### UC-1 · Conversion leak — "Why aren't visitors converting?"

**Story.** As a solo founder with real traffic but flat signups, I want to know exactly where my funnel leaks and why, so I can fix the highest-impact issues without hiring a consultant.

**Question-flow path.** "What's your biggest concern?" → *visitors don't convert* · "What should a visitor do on your site?" → signup / purchase / book · "Where do they seem to drop?" → landing / mid-funnel / final step.

**Spawn set.** Heuristics (always) + Forms & Flow + Conversion-CTA (goal action named + landing page captured, rule R4). Copy spawned only if answers mention messaging ("they don't get what we do") — that would hit the cap of 4.

**Research direction.** Conversion benchmarks for the stated funnel type; one competitor example of the same step done well.

**Output emphasis.** Findings ranked by estimated conversion impact; each tied to the visitor-goal the founder named.

**Success signal.** Email captured → full results viewed → subscription started; month-2 retention with monitoring left on.

---

### UC-4 · Checkout abandonment (e-commerce)

**Story.** As an e-commerce operator, I want to know why shoppers abandon at checkout, so I can recover revenue I'm already paying to acquire.

**Question-flow path.** "What kind of site?" → *online store* · "Biggest concern?" → *cart/checkout abandonment* · "Checkout style?" → single-page / multi-step / hosted (e.g. Shopify).

**Spawn set.** Forms & Flow leads (checkout mechanics); Conversion-CTA supports (trust signals, cost transparency, motivation at the payment moment — R4 fires on purchase goal + checkout page); heuristics baseline. Copy skipped unless messaging flagged.

**Research direction.** Baymard Institute checkout studies — the strongest evidence corpus in UX; cite field-count, guest-checkout, and cost-transparency findings. Competitor capture: one comparable store's checkout via page-inspector.

**Output emphasis.** Step-by-step friction map of the actual checkout path; every finding paired with a Baymard citation or marked `no source found`.

**Success signal.** Same funnel + finding-click rate on checkout findings (feeds evidence weights in priors).

---

### UC-5 · Signup/onboarding friction (SaaS)

**Story.** As a SaaS founder, I want to know why trial signups stall or churn in the first session, so activation stops being my leakiest metric.

**Question-flow path.** "What kind of site?" → *SaaS* · "Biggest concern?" → *signups stall / users don't activate* · "What happens right after signup?" → empty state / setup wizard / straight to app.

**Spawn set.** Forms & Flow leads (signup form + first-run path); Conversion-CTA supports (persuasion at the commitment moment — R4 fires on signup goal); Copy supports (value clarity). That's the cap of 4 with heuristics — A11y only spawns here if compliance is mentioned, displacing Copy per the cap rule.

**Research direction.** Form-length and social-signup research; onboarding pattern examples from comparable SaaS competitors.

**Output emphasis.** The commitment moment: fields asked vs. value shown, trust signals, first-session path.

**Success signal.** Same funnel; watch drop-off inside the question flow itself (SaaS founders are the most impatient respondents — feeds question weights).

---

## Variant use cases (near-free once core paths exist)

### UC-2 · Pre-launch check
As a founder about to ship, I want a "did I miss anything obvious" pass, so I don't launch with an embarrassing flaw. Routes from "haven't launched yet" answer → broad spawn (Orchestrator picks 4 of 6 by page mix), breadth over depth, findings framed as pre-flight checklist.

### UC-3 · Post-redesign validation
As a team that just rebuilt its site, I want to confirm the redesign didn't make anything worse. Routes from "recently changed" answer → heuristics + copy; urgency framing in output ("changed 3 weeks ago" mirrors the trigger-event logic).

### UC-6 · Pricing page confusion
As a SaaS founder whose pricing page bleeds visitors, I want to know whether the problem is comprehension or trust. Copy leads (comprehension) with Conversion-CTA (trust and motivation); research retrieves two competitor pricing pages; output contrasts structure side-by-side.

---

## Roadmap use cases (acknowledge, don't build)

### UC-7 · Accessibility posture check
As an operator selling into the EU or public sector, I want to know my exposure under WCAG / the European Accessibility Act (in force since 2025), so compliance doesn't ambush a deal. A11y agent leads; regulatory tailwind slide.

### UC-8 · Agency white-label
As a freelancer or small agency, I want branded audits as my client deliverable and sales tool, so I can scale judgment I currently sell by the hour. Most plausible paid-B2B path; the standard plan's fair-use cap (3 sites) deliberately routes them to a future agency tier rather than blocking them.

### UC-9 · A/B hypothesis generation
As a growth marketer, I want evidence-backed test hypotheses rather than fixes, so my testing queue stops being guesswork. Same findings, reframed output ("test this against that, expected direction, source").

### UC-10 · Demo-day polish
As a founder prepping for investor scrutiny, I want the first-impression issues found this week. Time-boxed, low price sensitivity; Visual Hierarchy leads (R5 — this use case *is* the "something looks off" complaint) with Copy support.

---

## UC-11 · Self-audit (internal)

The Usability Lab runs on its own homepage and results page after each significant change; findings feed the team's iteration queue like any customer's would. Serves as regression QA for the pipeline, a live demo beat ("here's what it found on itself"), and an honesty check — if the audit isn't useful on our own site, priors need work before customers see it.

---

## Design rule this file enforces

A new use case is admitted only if it changes at least one of: the question path, the spawn set, or the research direction. If it changes none, it is marketing copy for an existing use case, not a new route.
