# Homepage and question flow — design spec

**Date:** 2026-08-20
**Status:** approved, not built
**Touches:** `server.ts`, a new `marketing.ts`, a new `assets.ts`, `funnel.ts`
**Does not touch:** `render.ts`, `profile.ts`, the orchestrator, any agent

---

## 1. What this is

`/` is currently the product's only front door and it is a bare form: an `h1`, one
sentence, a URL field, five stacked textareas, a button. Nothing explains what an
audit is, what it costs, or why anyone should trust it.

This spec replaces it with a scrolling marketing page, moves the question flow to
its own stepped page at `/start`, and gives both a visual language derived from
the founder's "clinical white minimal" reference board.

**The audit pages are explicitly not part of this.** Kelly's call, 2026-08-20:
*"the audits don't need to be design, let them as is."*

---

## 2. Scope

### In

- A new one-page marketing homepage at `/`, above and below the fold.
- A new stepped question flow at `/start`, six steps, degrading to today's form
  without JavaScript.
- A shared token set and page shell for every non-audit surface — which means
  `page()` in `server.ts` moves and gets restyled, so the status page, the 404
  and the error pages come along.
- One self-hosted webfont and the minimal static-asset route needed to serve it.
- Splitting `question.started` so the funnel keeps its meaning (§7).

### Out — deliberately, and each for a reason

| Not doing | Why |
|---|---|
| Restyling `render.ts` / audit pages | Kelly's call above. Accepted seam: marketing is bone-and-air, results stay warm-editorial. |
| Changing the five questions | `profile.ts` feeds the §3 spawn rules. Question *presentation* is free; question *content* is an orchestrator change and gets priced separately. |
| Per-question drop-off analytics | Needs a beacon endpoint, and §8 makes events permanent while forbidding them from holding answer text. Two events (§7) cover the funnel without opening that door. |
| Real testimonial content | There are no customers. The slot holds a sample audit instead (§5.4). |
| Nav, secondary pages, footer links | The page has exactly one action. Adding a nav gives it competitors. |

---

## 3. The visual language

Derived from six pins on the board `kredznak/clinical-white-miminal`: draped
plaster, limestone stairs, white pebbles, layered cream waves. Warm off-whites
throughout — **no pure white anywhere on that board, and no cool tone**.

### 3.1 Tokens

```
--paper    #FBFAF8   page ground — unchanged from today's --bg
--bone     #F2EFE9   raised surfaces (cards, footer)
--plaster  #EAE5DC   hairlines, tag fills
--sand     #DDD6C9   drifting forms
--shade    #C9C0B2   field underlines, placeholder text
--sage     #D6D8D0   drifting forms, the one near-cool note
--ink      #26221E   text — a warm black
--ink-soft #6E665C   secondary text
```

Two notes on these. `--paper` is the **existing** `--bg` and it survived contact
with the board unchanged; pure white would have been wrong. And `--ink` moves
from today's neutral `#1a1a1a` to a warm `#26221E`, because a neutral black on a
warm ground reads faintly blue.

There is **no accent colour.** The palette is achromatic-warm end to end. That is
a departure from today's `--accent:#E4572E`, which stays alive in `render.ts` and
is therefore unaffected.

### 3.2 The rule that actually matters

**Depth comes from tonal steps and soft shadow, not from lines.** Not one of the
six pins has a hard edge on it. Concretely:

- Surfaces are a lighter or darker tone on the ground, with a soft ambient
  shadow — not `1px solid`.
- Form fields are **underline-only**. No boxes.
- Radii are large: 20–22px on surfaces, 100px on buttons.
- The only hairlines on the page are the section dividers and the price-table
  rows, both `--plaster`, both barely present.

### 3.3 Type

Inter, self-hosted (§6.2). Five roles:

| Role | Spec |
|---|---|
| Display (h1) | 300 weight, ~56px, line-height 1.14, tracking −0.018em |
| Section lead | 300 weight, ~27px, line-height 1.42 |
| Body | 400 weight, 15px |
| Eyebrow / meta | 400, 11px, uppercase, tracking 0.14em |
| Button | 500, 15px |

The chosen voice is **"light and airy"** — Inter Light at large sizes with wide
tracking on small caps. Kelly picked it against two alternatives, with one
amendment: *"B's voice, I'd take A's button into it."* So the CTA is a **solid
ink pill**, not the outlined button the light voice would suggest. It is the only
conversion point on the page and it should not whisper.

### 3.4 The drifting forms

The hero background is **four blurred radial gradients** on `--paper`, in
`--plaster`, `--sand`, `--sage` and `--shade`, `filter: blur(56px)`,
`mix-blend-mode: multiply`, drifting on independent 26–40 second cycles.

This replaces the `WovenLightHero` component that prompted the work. That
component was rejected on 2026-08-20 for three reasons, recorded here because the
third one is a standing constraint and not a one-off:

1. It needs React, Next, Tailwind and shadcn. This repo has five runtime
   dependencies and no bundler.
2. Its particle physics runs on the CPU — ~200,000 `Vector3` allocations per
   frame across 50,000 particles, plus a square root each — where it belongs in
   a vertex shader. It also never disposes its geometry, material or renderer.
3. **It would fail our own audit.** White text over a moving multicoloured field
   has no contrast ratio to measure (WCAG 1.4.3), it ignores
   `prefers-reduced-motion` entirely, and a `requestAnimationFrame` scene never
   settles — which is exactly the non-determinism B15 spent a week measuring, and
   our own capture pipeline would see a different homepage on every run.

The board also settles it on taste: those pins are continuous soft volumes.
A field of discrete dots is granular and unmistakably digital, which is a
different material.

**`prefers-reduced-motion: reduce` sets `animation: none` on every form.** The
page then renders one static frame, which is a complete and correct version of
the design — not a degraded one.

---

## 4. Routes

| Route | Method | Change | Event |
|---|---|---|---|
| `/` | GET | Replaced: marketing page, **no form** | `home.viewed` *(new)* |
| `/start` | GET | **New**: the stepped question flow | `question.started` |
| `/request` | POST | **Unchanged handler.** Re-renders `/start` on error. | unchanged |
| `/s/<asset>` | GET | **New**: static assets, allowlisted (§6.1) | none |

Everything else — `/r/<id>`, `/a/<id>/`, `/a/<id>/full`, `/a/<id>/email`,
`/a/<id>/subscribe`, `/a/<id>/reaudit`, `/stripe/webhook` — is untouched.

`/request` keeps its existing rate limiters (`asksGlobally`, `asksByClient`) and
its existing validation. **No new state-changing route is introduced**, so §CSRF
does not come into play: nothing added here reads `ul_full`.

---

## 5. The homepage

One scrolling page. Hero above the fold, three sections below it, a closing block
with the price.

### 5.1 Hero

- Brandmark top-left, 11px uppercase tracked.
- H1: *"A design critique of your site, backed by research"*
- Sub: *"Five questions to shape your critique. Under ten minutes. Real
  screenshots of your site."*
- CTA: **Get started** → `/start`
- Scroll cue: *"Scroll to discover"*, anchored to the first section.

"Under ten minutes" is deliberately looser than the §0 definition of done, which
is eight. Under-promising a number we already meet.

### 5.2 What we do

> Your URL and five answers become a **research-backed critique** of your site —
> with cited findings and annotated screenshots, so you can check every one of
> them.

### 5.3 Where the research comes from

> Every finding points at a source, **or says plainly that it couldn't find one.**

That sentence is the `source_type: none` rule from `quality-bar.md`, told to a
customer. It is a claim most competitors cannot make.

Below it, per-publisher counts read from `sources.ts` — **15** Nielsen Norman
Group, **5** WCAG, **5** Laws of UX, **2** Baymard Institute, **1** Growth.Design.
Twenty-eight total.

This replaces the list of four publisher names in the original design. For a
product selling evidence, a checkable number beats four logos.

> **Maintenance risk, stated plainly.** These numbers are hardcoded copy about a
> table that changes — `sources.ts` went 15 → 22 → 28 in one day this week. A
> stale count on the page that brags about accuracy is the worst kind of wrong.
> **The build must derive them from `SOURCES` at render time, not type them in.**

### 5.4 See one

> Here is **this page**, audited by the thing this page is selling.

An embedded finding: annotated thumbnail with a numbered pin, the heuristic, a
severity tag, the observation, and the citation.

**Content is blocked and the block is intentional.** All nine published audits
are of named third parties — basecamp, notion, irs.gov, duolingo, linear,
cotopaxi, asana. Giving a company a private link to its own critique is one
thing; putting that critique on our marketing page as an advertisement is
another, and we should not do it without asking them.

So the section ships with a **clearly-labelled placeholder** and becomes real
when we run our own pipeline against this page. See §10.

### 5.5 Closing block, with the price

On `--bone`. Heading *"One page. Five questions."*, then a two-row price table
above the CTA:

| | |
|---|---|
| Your first audit | **Free** |
| Keep watching the page | **$29 / month** |

Then **Get started**, then fine print: *"No card to start. The subscription buys
re-audits — we capture the page again and tell you what moved. Three sites, ten
re-audits a month. Cancel any time."*

**Two rows, not one number, and this is load-bearing.** The audit is free —
`FREE_FINDINGS = 3`, then an email reveals the rest. The `$29` is monitoring:
re-audits and diffs, `SITE_LIMIT = 3`, `AUDITS_PER_MONTH = 10`. A bare "$29"
above the button would tell visitors it costs $29 to try, which is false, and it
would be the only untrue claim on a page whose entire subject is honesty.

All four figures — 29, free, 3, 10 — **must be imported from `render.ts` and
`fairuse.ts`, never retyped.** `PRICE_USD` exists because §11 wants one number in
one place.

---

## 6. Assets

### 6.1 The static route

`GET /s/<name>` serves from an **explicit in-memory allowlist**, built at startup:

```
Map<string, { body: Buffer; type: string }>
```

Files are read **once at boot**. The request handler does no filesystem access
whatsoever and never joins a path from user input, so directory traversal is not
mitigated here — it is structurally impossible. An unknown name is a 404 through
the existing `notFound`.

Headers: `Cache-Control: public, max-age=31536000, immutable`.

### 6.2 The font

Inter, variable, latin subset, `woff2`, vendored at `assets/inter.woff2` and
served at `/s/inter.woff2` with `font-display: swap`.

Not Google Fonts. A CDN link would make every page depend on a third party and
would hand that third party the IP address of every reader — and since audit
pages are static HTML people open weeks later, a CDN link there would be
permanent. Restricting the redesign to marketing pages limits that exposure, but
self-hosting removes it.

Inter is SIL Open Font License 1.1; **the license file ships alongside the font.**

Stack: `Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial,
sans-serif`.

---

## 7. The funnel change

### The bug this prevents

`funnel.ts:215` prints:

```
form opened            N   visits, not audits
questions answered     M   requests queued
```

`form opened` is `question.started`, which fires on `GET /` today. That is
accurate right now because `/` **is** the form.

The moment `/` becomes a marketing page, the row counts homepage views while
still reading "form opened," and the ratio between those two lines — the form's
completion rate — silently becomes a whole-site conversion rate. The number keeps
printing to the same precision and means something else. This is the same failure
as the 85%-uncited figure: an honest-looking metric over a changed population.

### The fix

- `GET /` records **`home.viewed`** — a new type.
- `GET /start` records **`question.started`** — unchanged type, unchanged
  meaning: *the form was opened.*
- `POST /request` records `question.completed` as it does today.

Because `question.started` keeps its exact meaning, **the historical series stays
continuous and comparable across the redesign.** That is the reason for reusing
the name rather than inventing one.

`funnel.ts` gains a row above `form opened`:

```
  homepage viewed        N   visits, not audits
  form opened            N   visits, not audits
  questions answered     M   requests queued
```

### Known, pre-existing, out of scope

Every `GET /` writes a permanent event row, so a crawler can grow the table
without limit. That is true today; this change adds a second such route and makes
it modestly worse. **Not fixed here** — flagged for the backlog rather than
folded into a design change.

---

## 8. The question flow at `/start`

Six steps: the URL, then the five questions from `profile.ts`.

### 8.1 The architecture, which is the whole trick

**All six fields are in the HTML from the first byte.** JavaScript hides five of
them and reveals them one at a time. There is a single `POST` to `/request` at
the end carrying all six values.

Consequences, all of them good:

- **No server state.** No partial answers stored, so no expiry policy for a
  stranger's free text, so nothing new under §8.
- **No new endpoint**, so no new rate-limit surface.
- **`/request` is untouched.** Same handler, same validation, same limiters.
- **The no-JS fallback is not a second implementation.** With JS off, all six
  fields simply display — which is today's form, with today's handler behind it.

A `POST`-per-step design was considered and rejected: it buys a progress bar at
the cost of storing half-finished answers.

### 8.2 Behaviour

- Progress: six segments, filled to the current step, plus "Step *n* of 6".
- **Back** on every step but the first.
- **Skip this one** on all five question steps; absent on the URL step.
- Enter advances (Shift+Enter for a newline).
- Final button reads **"Ask for the audit"**.

### 8.3 Why Skip is a real button and not small print

Every answer is optional in `profile.ts` and the profiler is built to come back
honest about a gap. A stepper that hides its exit pressures people into filling
boxes with noise — and **noise here is worse than blank**, because `concerns[0]`
decides which specialists get hired when more §3 rules fire than the cap of 4
allows. An invented concern actively mis-staffs the audit.

For the same reason, step 2 states what the answer does: *"It decides which
reviewers we put on the page."* True, and it produces better answers than an
unexplained box.

### 8.4 Errors

`/request` already re-renders the form with typed values echoed so nobody retypes
five answers over a mistyped URL. That behaviour is preserved: on error the
server re-renders `/start` with values filled, the error visible, and a
`data-error-step` attribute telling the stepper which step to open on.

Every interpolation continues through `escapeHtml` — this is still the one page
rendered from a stranger's text.

---

## 9. Files and tests

### Files

| File | Change |
|---|---|
| `src/marketing.ts` | **New.** Owns `SHELL_CSS`, `page()` (moved out of `server.ts`), `homePage()`, `questionsPage(state)`, and the stepper script as a string. |
| `src/assets.ts` | **New.** The boot-time allowlist and its lookup. |
| `src/server.ts` | `/` replaced, `/start` and `/s/*` added, `page()` and its CSS block removed (~25 lines lighter). |
| `src/funnel.ts` | One new row; `home.viewed` counted. |
| `assets/inter.woff2` + `assets/inter-LICENSE.txt` | **New.** Vendored. |

### Tests

| Test | Guards |
|---|---|
| `/` contains no `<form>` posting to `/request` | The form really moved |
| `/` records `home.viewed`, not `question.started` | §7's metric bug |
| `/start` records `question.started` | The historical series stays continuous |
| **`/start` contains all six field names in raw HTML** | §8.1's no-JS guarantee. The load-bearing test: if someone later "optimises" by rendering one step server-side, this fails. |
| `/request` error re-renders `/start` with values echoed | No retyping five answers |
| `/s/inter.woff2` serves; `/s/../secret` and unknown names 404 | §6.1 |
| Source counts and price figures are derived, not literals | §5.3 and §5.5 — the two places a stale number would embarrass us |
| Snapshot check still passes | Existing 7 request snapshots |

**Every new test gets watched failing with its fix reverted before it counts as
evidence.** Standing rule; 134 green tests once missed four capture bugs.

---

## 10. Sequencing note

§5.4 wants a real audit of this page, and this page does not exist yet. Order:

1. Build the page.
2. Run `npm run audit` against it locally.
3. Read the findings. Fix what is real — *this is the point, not a formality.*
4. Embed the resulting finding in §5.4 and re-render.

Ten sites will have been through the pipeline and the tenth will be ours. That is
a better claim than any testimonial would have been, and it is the only honest way
to fill that slot before there are customers.

---

## 11. Open questions

- **Does "your first audit is free" belong in the hero?** It is the strongest
  sentence on the page and currently waits until the bottom. Offered and passed
  over on 2026-08-20; the hero's three-beat rhythm won. Revisit after the page is
  real.
- **Mobile.** The design is responsive by construction (single column, relative
  units) but has only been reviewed at desktop width. Check before launch.
- **The seam.** Marketing is bone-and-air; results are warm-editorial. Accepted
  for now. If it grates once it is live, restyling `render.ts` affects future
  audits only and never rewrites a page a customer has already read.
