import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Capture, Finding } from "./types.js";
import { checkClaim } from "./claims.js";
import { ALL_RUBRICS } from "./agents/rubrics.js";

/**
 * Builds the labelled corpus the outcome suite scores against — docs/design.md §10.
 *
 *   npm run corpus        # rebuild fixtures/labelled/findings.json from out/
 *
 * Findings are lifted out of completed audits in `out/` and frozen, so a prompt
 * change can be scored without spending anything or waiting on four sub-agents.
 * The audits already on disk include two runs made BEFORE the capture fixes,
 * which is the most valuable thing here: they contain known-false findings with
 * known root causes, and any harness worth keeping has to rediscover them.
 *
 * Labels come from two places and the file records which:
 *   - `auto`   — the mechanical verdict from claims.ts
 *   - `human`  — Kelly's adjudication, preserved across rebuilds
 *
 * A mechanical contradiction never deletes a finding. It routes it to a person.
 * The machine is good at "this sentence disagrees with what we measured" and
 * has no opinion at all on "this is worth a founder's attention".
 */

const CORPUS = "fixtures/labelled";
const CORPUS_FILE = path.join(CORPUS, "findings.json");

export type HumanLabel = "true" | "false" | "unsure";

export interface LabelledFinding {
  /** Stable across rebuilds: audit + finding id. */
  key: string;
  audit_id: string;
  url: string;
  agent: string;
  heuristic: string;
  severity: number;
  confidence: string;
  positive: boolean;
  element_ref: string | null;
  observation: string;
  impact_note: string;
  /** Mechanical verdict, recomputed on every rebuild. */
  auto: {
    status: "verified" | "contradicted" | "unverifiable";
    contradictions: string[];
  };
  /** Set by a person, preserved across rebuilds. Null until adjudicated. */
  human: HumanLabel | null;
  human_note: string | null;
}

/**
 * The subset of a Finding the corpus and the claim checker actually read.
 * A recovered finding cannot supply `evidence` or `citation`, and neither is
 * needed to decide whether a sentence is true.
 */
type RecoveredFinding = Pick<
  Finding,
  | "id"
  | "agent"
  | "heuristic"
  | "severity"
  | "confidence"
  | "positive"
  | "element_ref"
  | "observation"
  | "impact_note"
>;

export interface Corpus {
  built_from: { audit_id: string; url: string; findings: number }[];
  /**
   * Audits on disk we could not score, and why. Listed rather than dropped —
   * a corpus that silently ignores half the evidence reads as cleaner than it is.
   */
  skipped: { audit_id: string; reason: string }[];
  findings: LabelledFinding[];
}

export function loadCorpus(): Corpus {
  if (!existsSync(CORPUS_FILE)) return { built_from: [], skipped: [], findings: [] };
  return JSON.parse(readFileSync(CORPUS_FILE, "utf8")) as Corpus;
}

/** Every completed audit on disk: a capture plus findings in either form. */
function completedAudits(): string[] {
  if (!existsSync("out")) return [];
  return readdirSync("out")
    .filter((d) => !d.startsWith("smoke-") && !d.startsWith("fixture-"))
    .filter((d) => existsSync(path.join("out", d, "capture.json")))
    .filter(
      (d) =>
        existsSync(path.join("out", d, "findings.json")) ||
        existsSync(path.join("out", d, "results.html")),
    )
    .sort();
}

/**
 * Canonical rubric ids, whatever form the source used.
 *
 * Findings recovered from HTML carry display labels ("Accessibility + Heuristics")
 * while the findings.json sidecar carries ids ("a11y+heuristics"). Left alone,
 * the outcome report splits one lane across two rows and halves both counts —
 * which is how a lane responsible for 4 of 5 false findings can look like two
 * lanes with two each.
 */
function canonicalAgent(agent: string): string {
  const byLabel = new Map(ALL_RUBRICS.map((r) => [r.label.toLowerCase(), r.id]));
  return agent
    .split("+")
    .map((part) => {
      const key = part.trim().toLowerCase();
      return byLabel.get(key) ?? key;
    })
    .filter(Boolean)
    .sort()
    .join("+");
}

function decodeEntities(s: string): string {
  return s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/&rarr;/g, "→")
    .replace(/&amp;/g, "&");
}

/**
 * Recovers findings from a rendered results page.
 *
 * Only needed for audits run before the pipeline persisted findings.json —
 * which happens to include the two runs holding our known-false findings, the
 * most valuable rows in the corpus. Parsing our own generated HTML is
 * acceptable precisely because we generate it; it is a migration path, not an
 * interface, and it goes unused the moment every audit on disk has a sidecar.
 */
function findingsFromHtml(html: string): unknown[] {
  // Note the \s*: render.ts interpolates the positive class, so an ordinary
  // finding emits `class="finding "` with a trailing space. Matching only
  // `finding` or `finding positive` silently recovered a third of each audit.
  const cards = [...html.matchAll(/<article class="finding\s*(positive)?">([\s\S]*?)<\/article>/g)];
  const pick = (block: string, re: RegExp): string =>
    decodeEntities((block.match(re)?.[1] ?? "").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());

  return cards.map((m, i) => {
    const positive = Boolean(m[1]);
    const block = m[2] ?? "";
    const meta = block.match(/<div class="meta">([\s\S]*?)<\/div>/)?.[1] ?? "";
    return {
      id: `recovered-f${i + 1}`,
      agent: pick(meta, /<span class="tag agent">([\s\S]*?)<\/span>/) || "unknown",
      heuristic: pick(meta, /<span class="heuristic">([\s\S]*?)<\/span>/),
      severity: Number(meta.match(/severity (\d)/)?.[1] ?? 2),
      confidence: meta.includes("high confidence") ? "high" : "medium",
      positive,
      element_ref: meta.match(/<span class="tag ref">(el_\d+)<\/span>/)?.[1] ?? null,
      observation: pick(block, /<p class="observation">([\s\S]*?)<\/p>/),
      impact_note: pick(block, /<p class="impact">([\s\S]*?)<\/p>/),
    };
  });
}

export function buildCorpus(): Corpus {
  // Human labels survive a rebuild; that work is expensive and must not be
  // thrown away because a claim check was refined.
  const previous = new Map(loadCorpus().findings.map((f) => [f.key, f]));

  const built: Corpus = { built_from: [], skipped: [], findings: [] };

  for (const auditId of completedAudits()) {
    const dir = path.join("out", auditId);

    // Audits from before the capture schema grew input types, accessible names
    // and font sizes cannot be claim-checked against it. Skipped loudly.
    const parsed = Capture.safeParse(
      JSON.parse(readFileSync(path.join(dir, "capture.json"), "utf8")),
    );
    if (!parsed.success) {
      const missing = [...new Set(parsed.error.issues.map((i) => i.path.join(".")))]
        .filter(Boolean)
        .slice(0, 4);
      built.skipped.push({
        audit_id: auditId,
        reason: `capture predates the current schema (missing ${missing.join(", ")})`,
      });
      continue;
    }
    const capture = parsed.data;
    const sidecar = path.join(dir, "findings.json");
    const findings = existsSync(sidecar)
      ? (JSON.parse(readFileSync(sidecar, "utf8")) as unknown[]).map((f) => Finding.parse(f))
      : (findingsFromHtml(readFileSync(path.join(dir, "results.html"), "utf8")) as RecoveredFinding[]);

    built.built_from.push({ audit_id: auditId, url: capture.final_url, findings: findings.length });

    for (const f of findings) {
      const key = `${auditId}:${f.id}`;
      const verdict = checkClaim(f, capture);
      const prior = previous.get(key);
      built.findings.push({
        key,
        audit_id: auditId,
        url: capture.final_url,
        agent: canonicalAgent(f.agent),
        heuristic: f.heuristic,
        severity: f.severity,
        confidence: f.confidence,
        positive: f.positive,
        element_ref: f.element_ref,
        observation: f.observation,
        impact_note: f.impact_note,
        auto: { status: verdict.status, contradictions: verdict.contradictions },
        human: prior?.human ?? null,
        human_note: prior?.human_note ?? null,
      });
    }
  }

  mkdirSync(CORPUS, { recursive: true });
  writeFileSync(CORPUS_FILE, JSON.stringify(built, null, 2) + "\n");
  return built;
}
