import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Capture, Finding } from "./types.js";
import type { ContextProfile } from "./profile.js";
import type { CaptureSignals } from "./signals.js";
import type { OrchestrationResult } from "./orchestrator/index.js";
import type { SynthesisResult } from "./agents/synthesizer.js";
import { rubricFor } from "./agents/rubrics.js";
import { pinNumbers } from "./annotate.js";

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

function escapeHtml(s: string): string {
  return s.replace(/[<>&"']/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[c] as string,
  );
}

function citationLabel(finding: Finding): string {
  if (finding.citation.source_type === "none") {
    // quality-bar.md §3: `none` displays as our own evaluation, never a
    // fabricated authority.
    return "Based on our evaluation";
  }
  const url = finding.citation.url;
  return url
    ? `<a href="${escapeHtml(url)}" rel="noreferrer">${escapeHtml(finding.citation.source_type)}</a>`
    : escapeHtml(finding.citation.source_type);
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
    &rarr; annotation &rarr; founder review. Research and citations are not built, so every
    finding here shows &ldquo;based on our evaluation&rdquo; &mdash; honest rather than decorated.
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
   * The profile's one-line summary. Deliberately not the whole ContextProfile:
   * the publish path does not have one, and the version it used to build to
   * satisfy the type was four invented values — `goal: "unknown"`, `site_kind:
   * "other"` — that would have been read as fact the moment this page used them.
   */
  summary: string;
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
export async function renderPublic(input: PublishInput, outDir: string): Promise<string> {
  const { capture, kept, allFindings, annotatedImage, summary } = input;
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
  const shown = bySeverity(issues.slice(0, FREE_FINDINGS));
  const withheld = issues.slice(FREE_FINDINGS);
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
  .gate p { margin:0 0 6px; }
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

  <figure>
    <img src="${escapeHtml(imageSrc)}" alt="Annotated screenshot of the audited page">
    <figcaption>The number on each finding below is its pin on this screenshot. Findings
    inferred from page text carry no pin, because there is no box to point at.</figcaption>
  </figure>

  <h2>${shown.length === 0 ? "No issues found" : `The ${shown.length} that matter most`}</h2>
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
           <p>Each one names the element it is about and what it costs you.</p>
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

  <footer>
    Every finding above was checked against the page as captured, read by a person before
    publishing, and carries the element it refers to so you can verify it yourself.
    Findings show &ldquo;based on our evaluation&rdquo; where we have no external source to cite.
  </footer>
</div>
</body>
</html>`;

  const outPath = path.join(outDir, "results.html");
  await writeFile(outPath, html, "utf8");
  return outPath;
}
