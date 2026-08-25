import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Capture, Finding } from "./types.js";
import type { ContextProfile } from "./profile.js";
import type { CaptureSignals } from "./signals.js";
import type { OrchestrationResult } from "./orchestrator/index.js";
import type { SynthesisResult } from "./agents/synthesizer.js";
import { rubricFor } from "./agents/rubrics.js";
import { pinNumbers } from "./annotate.js";
import { SITE_LIMIT, AUDITS_PER_MONTH } from "./fairuse.js";
import { SOURCES } from "./sources.js";

/**
 * Two pages, written at two different moments.
 *
 * `results-full.html` — every finding plus the audit's own reasoning: which
 * reviewers were sent on what rule, what the Synthesizer set aside and why, what
 * the confidence gate dropped. Written at REVIEW_PENDING. This is what the
 * founder reads at the gate, and an audit that will not show its work is asking
 * to be taken on faith, which is the thing we are selling against.
 *
 * `results.html` — what the visitor sees, written only on PUBLISH. Three
 * findings, and an honest account of how many are held back. quality-bar §7:
 * "three free, eleven behind the call — the withhold *is* the business model."
 * The count is stated plainly, including how severe the withheld ones are,
 * because a teaser that hides its own size is the kind of thing we are
 * competing against.
 */

/**
 * Exported since the question flow, which is the first page here built from
 * text a stranger typed. One escaper, so there is one thing to be right.
 */
export function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

/**
 * `SOURCES` keyed by url. Built once: `citationLabel` runs per finding, and the
 * list is a module constant that cannot change underneath it.
 *
 * Keyed by url and not by id because the id is the one thing that does not
 * survive the trip. `citations.json` records `source_id`, but `Finding.citation`
 * is `{source_type, url}` — so by the time a finding reaches a renderer the id
 * is gone and the url is all that is left to recognise it by. All 28 urls are
 * distinct, so that is enough.
 */
const SOURCE_BY_URL = new Map(SOURCES.map((s) => [s.url, s]));

function citationLabel(finding: Finding): string {
  if (finding.citation.source_type === "none") {
    // quality-bar.md §3: `none` displays as our own evaluation, never a
    // fabricated authority.
    return "Based on our evaluation";
  }
  const url = finding.citation.url;
  if (!url) return escapeHtml(finding.citation.source_type);

  /**
   * `source_type` is a kind — "paper" — and was the link text until
   * 2026-08-23, so twelve published audits told the reader their evidence was
   * called "paper". Naming the publisher and the title is what makes a
   * citation checkable by the person reading it.
   *
   * A url we do not hold falls back to the kind. That case is a citation
   * pointing somewhere `sources.ts` has never verified, and inventing a name
   * for it would be exactly the fabricated authority §3 forbids.
   */
  const known = SOURCE_BY_URL.get(url);
  const label = known ? `${known.publisher} — ${known.title}` : finding.citation.source_type;
  return `<a href="${escapeHtml(url)}" rel="noreferrer">${escapeHtml(label)}</a>`;
}

/**
 * What the footer says about evidence, counted from the page rather than
 * asserted about the system.
 *
 * This sentence used to read "Research and citations are not built, so every
 * finding here shows 'based on our evaluation'". True the day it was written,
 * false the day citations shipped, and nothing failed when it went false —
 * ghost.org/pricing rendered nine resolving sources directly above it.
 *
 * The honest version is the same promise the old one was making: tell the
 * reader which findings stand on a published source and which stand on us. A
 * `none` citation is a refusal to stretch a source to fit, not a gap, so it is
 * worth saying out loud on the page a customer pays for.
 */
function sourceLine(findings: Finding[]): string {
  const n = findings.length;
  const cited = findings.filter((f) => f.citation.source_type !== "none").length;
  const own = n - cited;
  const evaluation = "&ldquo;based on our evaluation&rdquo;";
  const because = "because no source we hold fits the claim";

  if (n === 0) return "No findings survived the confidence gate on this run.";
  if (cited === 0) {
    return `None of the ${n} findings here cite a published source; each shows ${evaluation} ${because} &mdash; honest rather than decorated.`;
  }
  if (own === 0) {
    return `All ${n} findings here cite a published source &mdash; honest rather than decorated.`;
  }
  return `${cited} of the ${n} findings here cite a published source; the other ${own} show ${evaluation} ${because} &mdash; honest rather than decorated.`;
}

export interface RenderInput {
  capture: Capture;
  findings: Finding[];
  dropped: { reason: string; heuristic: string }[];
  annotatedImage: string;
  timings: { step: string; ms: number }[];
  costUsd: number;
  profile: ContextProfile;
  signals: CaptureSignals;
  plan: OrchestrationResult;
  synthesis: SynthesisResult;
  /** §7: DEGRADED is a visible state. Rendered, not just logged. */
  degraded: string[];
}

/**
 * Turns `el_19` into something a person can act on without opening devtools.
 *
 * The ref is kept in the line rather than replaced by it: the prose is for the
 * founder, the ref is what makes the finding checkable, and dropping it would
 * cost us the thing that makes an audit verifiable.
 */
export function locationLine(finding: Finding, capture: Capture): string {
  if (!finding.element_ref) {
    return "Page-level — no single element to point at";
  }
  const el = capture.elements.find((e) => e.ref === finding.element_ref);
  if (!el) {
    // Should be unreachable: claims.ts contradicts findings citing absent
    // elements. Saying so plainly beats rendering a bare ref that looks fine.
    return `${finding.element_ref} — not present in the capture`;
  }

  const raw = (el.text || el.accessible_name || "").replace(/\s+/g, " ").trim();
  const label = raw.length > 48 ? `${raw.slice(0, 47)}…` : raw;
  const what = label ? `the “${label}” <${el.tag}>` : `an unlabelled <${el.tag}>`;
  const where = el.above_fold ? "above the fold" : "below the fold";
  return `${what}, ${where} (${finding.element_ref})`;
}

/** Highest severity first; ties keep the Synthesizer's ranking. */
function bySeverity(findings: Finding[]): Finding[] {
  return findings.map((f, i) => ({ f, i })).sort((a, b) => b.f.severity - a.f.severity || a.i - b.i).map((x) => x.f);
}

function agentLabels(agent: string): string {
  return agent
    .split("+")
    .map((id) => {
      try {
        return rubricFor(id).label;
      } catch {
        return id;
      }
    })
    .join(" + ");
}

export async function renderResults(input: RenderInput, outDir: string): Promise<string> {
  const { capture, findings, dropped, annotatedImage, timings, costUsd } = input;
  const { profile, signals, plan, synthesis, degraded } = input;
  const imageSrc = path.basename(annotatedImage);

  // The Synthesizer's rank order, deliberately not re-sorted by severity. This
  // is the page the founder reads at the gate, `npm run review` walks the
  // findings in this same order, and `npm run outcome` scores rank against the
  // keep/cut calls — three views of one judgment, so they show one order.
  const issues = findings.filter((f) => !f.positive);
  const positives = findings.filter((f) => f.positive);
  const pins = pinNumbers(findings);

  const findingCard = (finding: Finding) => `
    <article class="finding ${finding.positive ? "positive" : ""}">
      <div class="pin">${pins.get(finding.id) ?? "—"}</div>
      <div class="body">
        <div class="meta">
          <span class="heuristic">${escapeHtml(finding.heuristic)}</span>
          <span class="tag sev-${finding.severity}">severity ${finding.severity}</span>
          <span class="tag conf-${finding.confidence}">${finding.confidence} confidence</span>
          <span class="tag agent">${escapeHtml(agentLabels(finding.agent))}</span>
        </div>
        <p class="observation">${escapeHtml(finding.observation)}</p>
        <p class="impact">${escapeHtml(finding.impact_note)}</p>
        <p class="location">Location: ${escapeHtml(locationLine(finding, capture))}</p>
        <p class="citation">${citationLabel(finding)}</p>
      </div>
    </article>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UX audit — ${escapeHtml(capture.title || capture.url)}</title>
<style>
  :root { --ink:#1a1a1a; --muted:#666; --line:#e2e2e2; --accent:#E4572E; --bg:#fbfaf8; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  .wrap { max-width: 880px; margin: 0 auto; padding: 40px 24px 80px; }
  header { border-bottom:1px solid var(--line); padding-bottom:20px; margin-bottom:32px; }
  h1 { font-size:26px; margin:0 0 6px; }
  .url { color:var(--muted); font-size:14px; word-break:break-all; }
  h2 { font-size:18px; margin:40px 0 16px; }
  figure { margin:0 0 32px; }
  figure img { width:100%; height:auto; border:1px solid var(--line); border-radius:6px;
               background:#fff; display:block; }
  figcaption { color:var(--muted); font-size:13px; margin-top:8px; }
  .finding { display:flex; gap:16px; padding:20px 0; border-bottom:1px solid var(--line); }
  .finding.positive { background:rgba(60,150,90,0.05); padding-left:12px; border-radius:6px; }
  .pin { flex:0 0 34px; height:34px; border-radius:50%; background:var(--accent); color:#fff;
         display:flex; align-items:center; justify-content:center; font-weight:700; font-size:15px; }
  .finding.positive .pin { background:#3c965a; }
  .body { flex:1; min-width:0; }
  .meta { display:flex; flex-wrap:wrap; gap:8px; align-items:center; margin-bottom:8px; }
  .heuristic { font-weight:600; }
  .tag { font-size:12px; padding:2px 8px; border-radius:999px; border:1px solid var(--line);
         background:#fff; color:var(--muted); }
  .conf-high { border-color:#3c965a; color:#2c7344; }
  .sev-4, .sev-3 { border-color:var(--accent); color:var(--accent); }
  .observation { margin:0 0 8px; }
  .impact { margin:0 0 8px; color:#444; }
  .location { margin:0 0 6px; font-size:13px; color:var(--muted); }
  .citation { margin:0; font-size:13px; color:var(--muted); }
  table { border-collapse:collapse; width:100%; font-size:14px; }
  th, td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); }
  th { color:var(--muted); font-weight:600; }
  td.num { text-align:right; font-variant-numeric:tabular-nums; }
  .dropped li { color:var(--muted); font-size:14px; }
  .note.degraded { border-left-color:#b8860b; }
  .lead { font-size:15px; color:#444; margin:0 0 16px; }
  .muted-row td { color:var(--muted); }
  .tag.agent { border-color:#c9c2b6; }
  .note { font-size:14px; color:var(--muted); background:#fff; border:1px solid var(--line);
          border-left:3px solid var(--accent); border-radius:4px; padding:12px 14px; }
  footer { margin-top:48px; padding-top:20px; border-top:1px solid var(--line);
           color:var(--muted); font-size:13px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${escapeHtml(capture.title || "Untitled page")}</h1>
    <div class="url">${escapeHtml(capture.final_url)}</div>
  </header>

  <figure>
    <img src="${escapeHtml(imageSrc)}" alt="Annotated screenshot of the audited page">
    <figcaption>Numbered pins mark screenshot-verified findings. Findings inferred
    from page text carry no pin, because there is no box to point at.</figcaption>
  </figure>

  ${
    degraded.length
      ? `<p class="note degraded"><strong>This audit ran degraded.</strong>
         ${degraded.map((d) => escapeHtml(d)).join("<br>")}
         <br>The findings below are real; the audit is just less complete than a clean run.</p>`
      : ""
  }

  <p class="note"><strong>Internal review copy — not published.</strong>
     Everything the audit produced, with the reasoning behind it. Findings are in the
     Synthesizer&rsquo;s rank order &mdash; the same order <code>npm run review</code> walks
     them in, and the order the top three are picked from. Publishing happens at the gate.</p>

  <h2>What we found (${issues.length})</h2>
  ${issues.length ? issues.map((f) => findingCard(f)).join("") : "<p>No issues survived the confidence gate.</p>"}

  ${positives.length ? `<h2>What's working (${positives.length})</h2>${positives.map((f) => findingCard(f)).join("")}` : ""}

  <h2>How this audit was assembled</h2>
  <p class="lead">${escapeHtml(profile.summary)}</p>
  <table>
    <tr><th>Reviewer</th><th>Rule</th><th>Sent because</th></tr>
    ${plan.fired
      .filter((f) => plan.spawn.includes(f.agent))
      .map(
        (f) =>
          `<tr><td>${escapeHtml(agentLabels(f.agent))}</td><td>${escapeHtml(f.rule)}</td>` +
          `<td>${escapeHtml(f.because)}</td></tr>`,
      )
      .join("")}
    ${plan.dropped
      .map(
        (d) =>
          `<tr class="muted-row"><td>${escapeHtml(agentLabels(d.agent))}</td>` +
          `<td>${escapeHtml(d.rule)}</td>` +
          `<td>not sent — ${escapeHtml(d.reason)}</td></tr>`,
      )
      .join("")}
  </table>
  <p class="citation">${escapeHtml(plan.rationale)}</p>

  ${
    synthesis.excluded.length
      ? `<h2>Set aside by the synthesizer (${synthesis.excluded.length})</h2>
         <ul class="dropped">${synthesis.excluded
           .map(
             (e) =>
               `<li>${escapeHtml(agentLabels(e.agent))} — ${escapeHtml(e.reason)}</li>`,
           )
           .join("")}</ul>`
      : ""
  }

  <h2>Run detail</h2>
  <table>
    <tr><td>Page kind</td><td class="num">${escapeHtml(signals.page_kind)}</td></tr>
    <tr><td>Form fields</td><td class="num">${signals.form_fields}</td></tr>
    <tr><td>Text per screen</td><td class="num">${signals.copy_density} chars</td></tr>
    <tr><td>Findings before synthesis</td><td class="num">${
      synthesis.merged.length + synthesis.excluded.length
    }</td></tr>
    ${
      synthesis.rejected.length
        ? `<tr><td>Synthesis references not honoured</td><td class="num">${synthesis.rejected.length}</td></tr>`
        : ""
    }
  </table>
  <table>
    <tr><th>Step</th><th class="num">Duration</th></tr>
    ${timings.map((t) => `<tr><td>${escapeHtml(t.step)}</td><td class="num">${(t.ms / 1000).toFixed(1)}s</td></tr>`).join("")}
    <tr><th>Total</th><th class="num">${(timings.reduce((s, t) => s + t.ms, 0) / 1000).toFixed(1)}s</th></tr>
    <tr><th>Model cost</th><th class="num">$${costUsd.toFixed(4)}</th></tr>
    <tr><td>Elements reviewed</td><td class="num">${capture.elements.length} of ${capture.elements_total}</td></tr>
  </table>
  ${
    capture.elements_total > capture.elements.length
      ? `<p class="note">This page has ${capture.elements_total} visible elements and we reviewed
         the first ${capture.elements.length}. Findings below are drawn from that subset —
         the page was not fully covered.</p>`
      : ""
  }

  ${
    dropped.length
      ? `<h2>Dropped before assembly (${dropped.length})</h2>
         <ul class="dropped">${dropped.map((d) => `<li>${escapeHtml(d.heuristic)} — ${escapeHtml(d.reason)}</li>`).join("")}</ul>`
      : ""
  }

  <footer>
    capture &rarr; context profile &rarr; reviewers &rarr; synthesis &rarr; derived confidence
    &rarr; annotation &rarr; founder review. ${sourceLine(findings)}
  </footer>
</div>
</body>
</html>`;

  const outPath = path.join(outDir, "results-full.html");
  await writeFile(outPath, html, "utf8");
  return outPath;
}

export interface PublishInput {
  capture: Capture;
  /** Findings the founder kept, in the order they should be read. */
  kept: Finding[];
  /**
   * Every finding the audit produced, including the ones the founder cut.
   *
   * Needed only for pin numbers, which are positions in the array `annotate`
   * drew from. Numbering off `kept` would renumber the cards without
   * renumbering the image.
   */
  allFindings: Finding[];
  annotatedImage: string;
  /**
   * How this audit came to be published, because the footer says so out loud.
   *
   * Until 2026-08-24 there was one answer and the footer hardcoded it: "read by
   * a person before publishing". Automating the gate made that sentence false
   * on every audit that published itself — a trust claim, on a customer's page,
   * about the exact thing that changed. Optional so a caller that does not know
   * gets the cautious wording rather than the flattering one.
   */
  decidedBy?: "founder" | "auto";
  /**
   * The profile's one-line summary. Deliberately not the whole ContextProfile:
   * the publish path does not have one, and the version it used to build to
   * satisfy the type was four invented values — `goal: "unknown"`, `site_kind:
   * "other"` — that would have been read as fact the moment this page used them.
   */
  summary: string;
  /**
   * Corrections made after publishing, oldest first — B5.
   *
   * A published page that turns out to be wrong gets fixed *and says so*.
   * Twice before this existed, a page was rewritten in place with a throwaway
   * script that bypassed `review.ts`'s refusal, and nothing anywhere recorded
   * that what the visitor saw had changed. Silence is the option this product
   * sells against.
   */
  corrections?: { at: string; reason: string }[];
  /**
   * Turns the withheld-count block into §6's email gate — B16, 2026-08-18.
   *
   * Optional so the artifact `review.ts` writes to disk is unchanged: a file
   * on a filesystem has nothing to POST to, and a form that goes nowhere is a
   * worse page than a paragraph that explains itself. `server.ts` passes this;
   * the publish path does not.
   */
  gate?: {
    /** Where the form POSTs. */
    action: string;
    /** Shown instead of the form once this visitor has asked. */
    asked?: boolean;
    /**
     * They asked again inside the cooldown, and no second link was sent.
     *
     * Worth its own wording rather than repeating "on its way": the honest
     * thing to say is that the *first* one is still the one to look for. A page
     * that claims to have sent a second mail when it sent none is the small lie
     * that makes a customer distrust the mail that did arrive.
     */
    again?: boolean;
    /** Set when a submission was rejected, so the reason survives the redirect. */
    error?: string;
  };
  /**
   * Show every kept finding instead of §6's free three — the page behind the
   * email gate.
   *
   * This is what "full results" means for a *customer*, and it is deliberately
   * not `results-full.html`. That file is `renderResults`, the founder's view:
   * it carries findings the founder cut and the Synthesizer's set-aside
   * reasoning. Serving it to a visitor would publish exactly the material a
   * person decided to withhold, which is the opposite of what the gate is for.
   *
   * Everything else on the page is unchanged, including the correction history
   * and the citations. The gate buys *more of the same page*, not a different
   * one — a customer should be able to check that the three they saw for free
   * are the same three, worded identically.
   */
  reveal?: boolean;
  /**
   * §0's subscribe step, and the thing a subscription actually buys.
   *
   * Shown on the revealed page only. Offering monitoring to someone who has
   * read three findings out of twelve is selling to a stranger; the reader
   * behind the gate has seen the whole thing and can judge whether more of it
   * is worth $29.
   *
   * A union rather than one shape with optional halves, because a non-subscriber
   * has no re-audit form and therefore no CSRF token — and a field that is
   * "required, except when it isn't" is how an empty `csrf=""` ends up posted
   * and accepted.
   */
  offer?:
    | {
        subscribed: false;
        /** The quiet "prefer to talk it through?" address — §1, zero emphasis. */
        talkTo: string;
        /**
         * Checkout is not wired. Stated on the page rather than hidden behind a
         * button that does nothing, because a dead button is a worse lie than a
         * sentence — the reader finds out either way, and only one of the two
         * ways costs them a click and their trust.
         */
        checkoutLive: false;
        /** They came back from Stripe and the webhook has not landed yet. */
        justPaid?: boolean;
        /**
         * Present on this arm too, because the "Payment received" panel is
         * chosen before `checkoutLive` is looked at — a customer who paid while
         * the keys were configured and reloaded after they were removed lands
         * here. Contrived, but the alternative is a narrowing that only holds
         * while nobody edits the order of two `if`s.
         * @see dashboardHref on the subscribed arm for what it is.
         */
        dashboardHref?: string;
      }
    | {
        subscribed: false;
        talkTo: string;
        /** Stripe is configured, so the button goes somewhere. */
        checkoutLive: true;
        /** Where the subscribe form POSTs. */
        action: string;
        /** Session-bound CSRF token — this route reads `ul_full`, so it needs one. */
        csrf: string;
        justPaid?: boolean;
        /** @see dashboardHref on the subscribed arm. Set only when `justPaid`. */
        dashboardHref?: string;
      }
    | {
        subscribed: true;
        talkTo: string;
        /** Where the re-audit form POSTs. */
        action: string;
        /** Session-bound CSRF token — see tokens.ts. */
        csrf: string;
        /** This reader already has a re-audit queued for this audit. */
        queued?: boolean;
        /** One was just recorded by this request. */
        justRequested?: boolean;
        /** The fair-use refusal, shown to the customer in its own words. */
        refusal?: string;
        /**
         * A signed link into `/account`, or absent.
         *
         * The subscription buys monitoring across every audit this address has
         * asked for, and until now this page was the only door to any of them —
         * a customer who paid here had no route to the index of their own work
         * except asking for a *third* email from `/signin`, to prove an address
         * they had already proved by opening this page.
         *
         * **Minted by the caller, never by this file**, and only from an email
         * that arrived on a verified session. That is the whole rule: `render.ts`
         * cannot sign anything, so a wrong call site cannot invent one.
         *
         * It is a wider credential than the audit token already in this URL —
         * one audit versus every audit — and it lands in browser history the
         * same way. It grants nothing `/signin` would not have mailed to the
         * same person, which is what makes the trade acceptable rather than
         * free. Dropping it out of the URL wants a cookie session on `/account`,
         * which is its own slice.
         */
        dashboardHref?: string;
      };
}

/** quality-bar §7 — three shown free. */
export const FREE_FINDINGS = 3;

/**
 * The visitor's page. Three findings and an honest account of the rest.
 *
 * The withheld count names its own severity spread. A teaser saying only "9
 * more findings" invites the reader to assume filler; saying "9 more, 2 of them
 * severity 4" is both more persuasive and true, and if the withheld findings
 * ever *are* filler this line makes that visible rather than hiding it.
 */
/**
 * Emitted only on a page that has a gate.
 *
 * Held apart from the main stylesheet so `results.html` on disk is unchanged by
 * this slice — it has no form, so it gets no rules for one. Dead CSS in a
 * customer's page is a small thing; a comment claiming the file is untouched
 * while the file grew ten lines is not, and that is what the first version of
 * this said.
 */
const GATE_CSS = `  .gate-form { margin-top:16px; }
  .gate-form label { display:block; font-weight:600; font-size:14px; margin-bottom:6px; }
  .gate-row { display:flex; gap:8px; flex-wrap:wrap; }
  .gate-form input { flex:1 1 220px; padding:9px 11px; font-size:15px; font-family:inherit;
                     border:1px solid #bbb; border-radius:3px; background:#fff; color:var(--ink); }
  .gate-form button { padding:9px 16px; font-size:15px; font-family:inherit; cursor:pointer;
                      border:0; border-radius:3px; background:var(--accent); color:#fff; }
  .gate-fine { margin-top:8px !important; font-size:13px; color:var(--muted); }
  .gate-error { margin-top:8px !important; font-size:14px; color:#a3301a; }
  .gate-sent { margin-top:14px !important; font-size:15px; }`;

/**
 * The gate itself: one field, one button, no persuasion.
 *
 * quality-bar §7 forbids the audit from telling anyone what to do, and the same
 * restraint applies to us asking for something. There is no urgency copy, no
 * "unlock", no count-down. The withheld paragraph above already says exactly
 * how many findings there are and how severe — that is the whole argument, and
 * it is true, which is the only kind of argument this product is allowed to
 * make.
 */
function gateForm(gate: PublishInput["gate"]): string {
  if (!gate) return "";
  if (gate.asked) {
    return gate.again
      ? `<p class="gate-sent">The link we already sent is still the one to look for &mdash;
            we have not sent another. It opens this page and no other, and expires in
            seven days.</p>`
      : `<p class="gate-sent">A link to the full results is on its way to that address.
            It opens this page and no other, and expires in seven days.</p>`;
  }
  return `<form class="gate-form" method="post" action="${escapeHtml(gate.action)}">
            <label for="gate-email">Email me the rest</label>
            <div class="gate-row">
              <input id="gate-email" name="email" type="email" required
                     autocomplete="email" placeholder="you@company.com">
              <button type="submit">Send the link</button>
            </div>
            ${gate.error ? `<p class="gate-error">${escapeHtml(gate.error)}</p>` : ""}
            <p class="gate-fine">One email, for this audit. We don't sell it on.</p>
          </form>`;
}

/**
 * §11's price. One number, one place, quoted on one page.
 */
export const PRICE_USD = 29;

/** Emitted only on a page carrying the offer — same reason as `GATE_CSS`. */
const OFFER_CSS = `  .offer { background:#fff; border:1px solid var(--line); border-radius:4px;
           padding:18px 20px; margin:36px 0 0; }
  .offer h2 { margin:0 0 8px; font-size:17px; }
  .offer p { margin:0 0 8px; }
  .offer form { margin:14px 0 0; }
  .offer button { padding:9px 16px; font-size:15px; font-family:inherit; cursor:pointer;
                  border:0; border-radius:3px; background:var(--accent); color:#fff; }
  .offer-fine { font-size:13px; color:var(--muted); }
  .offer-note { font-size:14px; color:#444; }
  .offer-refusal { font-size:14px; color:#a3301a; }
  .offer-next { font-size:14px; margin-top:14px; padding-top:12px;
    border-top:1px solid var(--line); }`;

/**
 * The subscribe step, and the re-audit button behind it.
 *
 * Two states, one block. What both refuse to do is press: quality-bar §7 stops
 * the audit telling anyone what to do, and the same restraint has to survive
 * contact with the one part of this page that wants money. So there is no
 * urgency, no discount, no "most founders choose", and the case for subscribing
 * is the same sentence the product is: we will look again and tell you what
 * changed.
 *
 * The "prefer to talk it through?" link is §1's, at the emphasis §1 asked for —
 * last line, body colour, no button. It is the honest escape hatch for a reader
 * who wants a person, and it is deliberately not competing with the offer above
 * it.
 */
function offerBlock(offer: PublishInput["offer"]): string {
  if (!offer) return "";

  const talk = `<p class="offer-fine">Prefer to talk it through?
        <a href="mailto:${escapeHtml(offer.talkTo)}">Email us</a>.</p>`;

  if (!offer.subscribed) {
    const pitch = `<h2>Keep watching this page</h2>
      <p>$${PRICE_USD} a month. Ask for a re-audit whenever you have changed something and
         we capture the page again, compare it to this one, and tell you what moved &mdash;
         &ldquo;3 fixed, 1 new&rdquo; &mdash; rather than handing you a fresh report to
         re-read. Up to ${SITE_LIMIT} sites and ${AUDITS_PER_MONTH} re-audits a month.</p>`;

    /**
     * Back from Stripe, before the webhook landed.
     *
     * The gap is real — Stripe redirects the customer immediately and delivers
     * the event separately — and it is measured in seconds, not minutes. Showing
     * the subscribe pitch again to somebody who has just paid is the single
     * worst thing this page could do, so the paid case is checked before
     * anything else and says plainly that the payment arrived and access
     * follows.
     */
    if (offer.justPaid) {
      /**
       * The dashboard link is offered here and not only after the webhook,
       * because this panel is the one moment we are certain the customer is
       * looking. The next page they see is whatever they do next, and for a
       * subscription whose whole value is *the other audits*, ending on a page
       * about this one audit is a dead end.
       */
      const dashboard = offer.dashboardHref
        ? `<p class="offer-next"><a href="${escapeHtml(offer.dashboardHref)}">Go to your dashboard</a>
             &mdash; every audit you have asked for, in one place.</p>`
        : "";
      return `<div class="offer">
      <h2>Payment received</h2>
      <p class="offer-note">Thank you. Access is switched on by a message from Stripe that
         usually arrives within a few seconds &mdash; reload this page and the re-audit
         button will be here. If it is not, email us and we will sort it out the same day.</p>
      ${dashboard}
      ${talk}
    </div>`;
    }

    if (!offer.checkoutLive) {
      return `<div class="offer">
      ${pitch}
      <p class="offer-note">Checkout is not connected yet, so there is nothing to click here.
         That is our missing piece, not yours.</p>
      ${talk}
    </div>`;
    }

    return `<div class="offer">
      ${pitch}
      <form method="post" action="${escapeHtml(offer.action)}">
        <input type="hidden" name="csrf" value="${escapeHtml(offer.csrf)}">
        <button type="submit">Subscribe &mdash; $${PRICE_USD} a month</button>
      </form>
      <p class="offer-fine">Card details go to Stripe and never touch us. Cancel any time.</p>
      ${talk}
    </div>`;
  }

  const inner = offer.justRequested
    ? `<p class="offer-note">Queued. It runs on the next pass, and the result appears here
          with what changed since this page.</p>`
    : offer.queued
      ? `<p class="offer-note">You already have a re-audit queued for this page. Asking again
            would not make it sooner, so we have not recorded a second one.</p>`
      : offer.refusal
        ? `<p class="offer-refusal">${escapeHtml(offer.refusal)}</p>`
        : `<form method="post" action="${escapeHtml(offer.action)}">
             <input type="hidden" name="csrf" value="${escapeHtml(offer.csrf)}">
             <button type="submit">Ask for a re-audit</button>
           </form>`;

  /**
   * Repeated on the subscribed panel deliberately.
   *
   * A customer who reloads past the "Payment received" panel — or arrives here
   * a week later from a link in their mail — would otherwise never see the door
   * again. A one-time pointer to a permanent place is a pointer most people
   * miss.
   */
  const dashboard = offer.dashboardHref
    ? `<p class="offer-next"><a href="${escapeHtml(offer.dashboardHref)}">Go to your dashboard</a>
         &mdash; every audit you have asked for, in one place.</p>`
    : "";

  return `<div class="offer">
      <h2>Ask for a re-audit</h2>
      <p>We capture this page again and compare it to the version above. If nothing has
         changed we say so and run no audit.</p>
      <p class="offer-fine">Each ask counts toward your ${AUDITS_PER_MONTH} for the month,
         whether or not the page turned out to have changed.</p>
      ${inner}
      ${dashboard}
      ${talk}
    </div>`;
}

/**
 * The published page as a string.
 *
 * Split out from `renderPublic` so `server.ts` can serve this page over HTTP
 * without writing a file first. Everything that decides *what a visitor sees* —
 * the free three, the withheld count, the pin numbers — lives here, so the
 * served page and the file on disk cannot drift apart into two answers.
 */
export function publicHtml(input: PublishInput): string {
  const { capture, kept, allFindings, annotatedImage, summary } = input;
  const corrections = input.corrections ?? [];
  const imageSrc = path.basename(annotatedImage);

  const issues = kept.filter((f) => !f.positive);
  const positives = kept.filter((f) => f.positive);

  /**
   * Pin numbers are only meaningful if `allFindings` is the array `annotate`
   * drew from. Nothing in the type system says so, and a caller who filters
   * first would produce a page pointing at the wrong boxes — silently, because
   * a wrong number looks exactly like a right one.
   *
   * That is the bug this page shipped with once already, so it gets a guard
   * rather than a comment. db.ts makes the same call about status: a value that
   * lies is worse than a crash, because every later reader takes it as fact.
   */
  const known = new Set(allFindings.map((f) => f.id));
  const orphan = kept.find((f) => !known.has(f.id));
  if (orphan) {
    throw new Error(
      `renderPublic: kept finding ${orphan.id} is not in allFindings. ` +
        `allFindings must be every finding the audit produced, in the order annotate drew them.`,
    );
  }

  const pins = pinNumbers(allFindings);

  /**
   * Selection is by rank, presentation is by severity, and the two are
   * different jobs. Rank is the Synthesizer weighing severity, fixability and
   * the visitor's stated concern together (see synthesizer-v2); raw severity
   * knows only the first of those, so picking the free three by severity would
   * throw away the goal-following we asked for and the founder confirmed at the
   * gate. Within the three, severity decides what the eye hits first.
   *
   * This does mean a severity 4 the Synthesizer ranked low can be withheld.
   * That is a real risk and it is deliberately unguarded: `npm run outcome`
   * measures it, and a guard added now would pre-empt the measurement.
   */
  const shown = bySeverity(input.reveal ? issues : issues.slice(0, FREE_FINDINGS));
  const withheld = input.reveal ? [] : issues.slice(FREE_FINDINGS);
  const severeWithheld = withheld.filter((f) => f.severity >= 3).length;

  /**
   * The badge is the pin number, not the severity.
   *
   * It used to be severity, under a caption promising every finding pointed at
   * something on the screenshot — three cards reading "2" beside an image
   * pinned 1..n, with nothing connecting them. Severity is still here, in
   * words, where it cannot be mistaken for a coordinate.
   */
  const card = (finding: Finding, n: number) => `
    <article class="finding">
      <div class="sev sev-${finding.severity}">${pins.get(finding.id) ?? "&mdash;"}</div>
      <div class="body">
        <h3>${escapeHtml(finding.heuristic)}</h3>
        <p class="observation">${escapeHtml(finding.observation)}</p>
        <p class="impact">${escapeHtml(finding.impact_note)}</p>
        <p class="location">Location: ${escapeHtml(locationLine(finding, capture))}</p>
        <p class="citation">${citationLabel(finding)} &middot; severity ${finding.severity}
           &middot; ${finding.confidence} confidence &middot; finding ${n} of ${issues.length}</p>
      </div>
    </article>`;

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>UX audit — ${escapeHtml(capture.title || capture.url)}</title>
<style>
  :root { --ink:#1a1a1a; --muted:#666; --line:#e2e2e2; --accent:#E4572E; --bg:#fbfaf8; }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink);
         font:16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  .wrap { max-width: 780px; margin: 0 auto; padding: 40px 24px 80px; }
  header { border-bottom:1px solid var(--line); padding-bottom:20px; margin-bottom:28px; }
  h1 { font-size:26px; margin:0 0 6px; }
  .url { color:var(--muted); font-size:14px; word-break:break-all; }
  .lead { font-size:15px; color:#444; margin:0 0 24px; }
  h2 { font-size:18px; margin:36px 0 16px; }
  figure { margin:0 0 28px; }
  figure img { width:100%; height:auto; border:1px solid var(--line); border-radius:6px;
               background:#fff; display:block; }
  figcaption { color:var(--muted); font-size:13px; margin-top:8px; }
  .finding { display:flex; gap:16px; padding:22px 0; border-bottom:1px solid var(--line); }
  .sev { flex:0 0 34px; height:34px; border-radius:6px; display:flex; align-items:center;
         justify-content:center; font-weight:700; font-size:15px; background:#efe9e2; color:#6b5f52; }
  .sev-4 { background:var(--accent); color:#fff; }
  .sev-3 { background:#f0b429; color:#4a3708; }
  .body { flex:1; min-width:0; }
  h3 { font-size:16px; margin:0 0 8px; }
  .observation { margin:0 0 8px; }
  .impact { margin:0 0 8px; color:#444; }
  .location, .citation { margin:0 0 4px; font-size:13px; color:var(--muted); }
  .gate { background:#fff; border:1px solid var(--line); border-left:3px solid var(--accent);
          border-radius:4px; padding:18px 20px; margin:32px 0; }
  .gate h2 { margin:0 0 8px; font-size:17px; }
  .gate p { margin:0 0 6px; }${input.gate ? `\n${GATE_CSS}` : ""}${input.offer ? `\n${OFFER_CSS}` : ""}
  .corrections { border-left:3px solid var(--accent); padding:2px 0 2px 14px; margin:0 0 24px;
                 font-size:14px; color:#444; }
  .corrections p { margin:0 0 4px; }
  .positive { border-left:3px solid #3c965a; padding-left:14px; margin-bottom:14px; }
  .positive p { margin:0 0 4px; }
  footer { margin-top:44px; padding-top:20px; border-top:1px solid var(--line);
           color:var(--muted); font-size:13px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${escapeHtml(capture.title || "Untitled page")}</h1>
    <div class="url">${escapeHtml(capture.final_url)}</div>
  </header>

  <p class="lead">${escapeHtml(summary)}</p>
${
    corrections.length > 0
      ? `  <div class="corrections">
    ${corrections
      .map(
        (c) =>
          `<p><strong>Corrected ${escapeHtml(c.at.slice(0, 10))}</strong> &middot; ${escapeHtml(c.reason)}</p>`,
      )
      .join("\n    ")}
  </div>
`
      : ""
  }
  <figure>
    <img src="${escapeHtml(imageSrc)}" alt="Annotated screenshot of the audited page">
    <figcaption>The number on each finding below is its pin on this screenshot. Findings
    inferred from page text carry no pin, because there is no box to point at.</figcaption>
  </figure>

  <h2>${
    shown.length === 0
      ? "No issues found"
      : input.reveal
        ? `All ${shown.length} finding${shown.length === 1 ? "" : "s"}, most important first`
        : `The ${shown.length} that matter most`
  }</h2>
  ${shown.map((f, i) => card(f, i + 1)).join("")}

  ${
    withheld.length > 0
      ? `<div class="gate">
           <h2>${withheld.length} more finding${withheld.length === 1 ? "" : "s"}</h2>
           <p>This audit found ${issues.length} issues on this page. ${shown.length} are above.${
             severeWithheld > 0
               ? ` ${severeWithheld} of the ${withheld.length} held back ${
                   severeWithheld === 1 ? "is" : "are"
                 } severity 3 or higher.`
               : ` None of the ${withheld.length} held back ${
                   withheld.length === 1 ? "is" : "are"
                 } above severity 2.`
           }</p>
           <p>Each one names the element it is about and what it costs you.</p>${gateForm(input.gate)}
         </div>`
      : ""
  }

  ${
    positives.length > 0
      ? `<h2>What's already working</h2>${positives
          .map(
            (f) =>
              // The citation belongs here as much as on an issue. On
              // notion.com/pricing every one of the three sources we resolved
              // sat on a positive, so the published page carried three
              // citations and displayed none of them — while the footer
              // promised the reader that unsourced findings say so. A page
              // that hides its evidence on the findings that have it is
              // strictly worse than one with no evidence at all.
              `<div class="positive"><p><strong>${escapeHtml(f.heuristic)}</strong></p>` +
              `<p>${escapeHtml(f.observation)}</p>` +
              `<p class="citation">${citationLabel(f)}</p></div>`,
          )
          .join("")}`
      : ""
  }
${offerBlock(input.offer)}
  <footer>
    ${
      /*
       * Both branches open with who wrote it, added 2026-08-25. The founder
       * branch is the one that needed it most and looked like it needed it
       * least: "read by a person before publishing" is true, it is the only
       * mention of a human on the whole page, and standing alone at the bottom
       * of an audit it invites exactly the wrong inference about the eight
       * hundred words above it. A true sentence can mislead by being the only
       * one there.
       */
      input.decidedBy === "founder"
        ? `Written by AI reviewers, checked against the page as captured, read by a person
           before publishing, and carries the element it refers to so you can verify it
           yourself.`
        : `Written by AI reviewers and checked against the page as captured &mdash; the
           element it names, the text it quotes and the measurements it states &mdash; and
           carries that element so you can verify it yourself. Those checks are automatic;
           an audit is held for a person only when one of them disagrees.`
    }
    Findings show &ldquo;based on our evaluation&rdquo; where we have no external source to cite.
  </footer>
</div>
</body>
</html>`;

  return html;
}

/** `publicHtml` written to `results.html`. The publish path's entry point. */
export async function renderPublic(input: PublishInput, outDir: string): Promise<string> {
  const outPath = path.join(outDir, "results.html");
  await writeFile(outPath, publicHtml(input), "utf8");
  return outPath;
}
