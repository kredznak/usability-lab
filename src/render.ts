import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { Capture, Finding } from "./types.js";
import type { ContextProfile } from "./profile.js";
import type { CaptureSignals } from "./signals.js";
import type { OrchestrationResult } from "./orchestrator/index.js";
import type { SynthesisResult } from "./agents/synthesizer.js";
import { rubricFor } from "./agents/rubrics.js";

/**
 * Slice-2 results page. Deliberately plain — the Content agent (§2) owns voice
 * and top-3 selection in a later slice. This page's job is to show that a
 * finding, its evidence, and its derived confidence survived the pipeline
 * intact, and to show the audit's own reasoning: which reviewers were sent, on
 * what rule, and what was dropped on the way. An audit that will not show its
 * work is asking to be taken on faith, which is the thing we are selling
 * against.
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

  const issues = findings.filter((f) => !f.positive);
  const positives = findings.filter((f) => f.positive);

  const findingCard = (finding: Finding, index: number) => `
    <article class="finding ${finding.positive ? "positive" : ""}">
      <div class="pin">${finding.evidence.bbox ? index + 1 : "—"}</div>
      <div class="body">
        <div class="meta">
          <span class="heuristic">${escapeHtml(finding.heuristic)}</span>
          <span class="tag sev-${finding.severity}">severity ${finding.severity}</span>
          <span class="tag conf-${finding.confidence}">${finding.confidence} confidence</span>
          ${finding.element_ref ? `<span class="tag ref">${escapeHtml(finding.element_ref)}</span>` : ""}
          <span class="tag agent">${escapeHtml(agentLabels(finding.agent))}</span>
        </div>
        <p class="observation">${escapeHtml(finding.observation)}</p>
        <p class="impact">${escapeHtml(finding.impact_note)}</p>
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

  <h2>What we found (${issues.length})</h2>
  ${issues.length ? issues.map((f) => findingCard(f, findings.indexOf(f))).join("") : "<p>No issues survived the confidence gate.</p>"}

  ${positives.length ? `<h2>What's working (${positives.length})</h2>${positives.map((f) => findingCard(f, findings.indexOf(f))).join("")}` : ""}

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
    Slice 1 of the v0 build: capture &rarr; heuristics &rarr; derived confidence &rarr; annotation.
    Research citations, synthesis, tone lint, and founder review are not in this slice —
    every finding here shows &ldquo;based on our evaluation&rdquo; by design.
  </footer>
</div>
</body>
</html>`;

  const outPath = path.join(outDir, "results.html");
  await writeFile(outPath, html, "utf8");
  return outPath;
}
