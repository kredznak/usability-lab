# The Usability Lab

An AI-powered platform that turns a URL and five questions into an evidence-backed UX audit. Subscription = continuous monitoring with re-audit diffs.

## Read first, every session
- `docs/design.md` — system design; **§0 is the v0 cut line, treat it as scope**
- `docs/quality-bar.md` — behavior rules; evidence-leads, kind curiosity, derived confidence
- `docs/use-cases.md` — routing spec; UC-1, UC-4, UC-5 build; others `[designed, not built]`

## Definition of done
One URL + answers → published results page with ≥1 cited finding and annotated screenshot, under 8 min, three consecutive runs on three different sites.

## Rules I won't ask twice
- Six sub-agents only (spawn rules R0–R5, cap 4). Don't invent new ones.
- Every finding needs an evidence pointer; every citation resolves or `source_type: none`.
- Confidence is derived, not declared.
- Audits publish themselves unless `claims.ts` **contradicts** a finding; those
  stop at REVIEW_PENDING for a person. Changed 2026-08-24 — this rule used to
  read "first audits gate on founder review", and the gate's own record is why
  it narrowed rather than vanished: 10 of 165 findings cut, and every written
  reason a count stated as fact and wrong. Re-audits keep 1-in-5 sampling.
- Only build failure handling for F1, F7, F9, F11, F21 in v0. Ask before adding more.

## Habits
- `/boris-plan` before any vertical slice.
- `/karpathy-review` at each merge point.
- Log every model call to `model_calls` from run 1.
