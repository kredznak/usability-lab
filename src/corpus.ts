import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { Capture, Finding, type ReviewDecision, type ReviewRecord } from "./types.js";
import { checkClaim } from "./claims.js";
import { ALL_RUBRICS } from "./agents/rubrics.js";
import { OUT_ROOT, CORPUS_ROOT } from "./paths.js";
import { AuditStore } from "./db.js";

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

const CORPUS = CORPUS_ROOT;
const CORPUS_FILE = path.join(CORPUS, "findings.json");

/**
 * Truth and usefulness are different questions and are stored separately.
 *
 * The machine can settle truth: does this contradict what we measured? It has
 * no opinion at all on usefulness, which is a judgment about a specific
 * customer. Folding them into one label makes a true-but-trivial finding look
 * like a false one, which would drag down precision — a truth metric — and hide
 * the ratio that actually decides whether the audit is worth paying for.
 */
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
  /**
   * What the finding cites, if anything. `none` is a legal, unpunished output
   * (§9.3) — it is tracked so we can see the corpus going stale, not to punish
   * a finding for being honest. §10 alerts above a 50% `none` rate.
   */
  source_type: "paper" | "competitor" | "none";
  /** Mechanical verdict, recomputed on every rebuild. */
  auto: {
    status: "verified" | "contradicted" | "unverifiable";
    contradictions: string[];
  };
  /**
   * Is the claim true? Only asked when the mechanical check flagged something,
   * so a person can overrule it. Null means "defer to `auto`".
   */
  human_true: boolean | null;
  /**
   * Would a founder change something because of this? The machine cannot answer
   * this at all, so null means genuinely unknown — never assumed.
   */
  human_useful: boolean | null;
  human_note: string | null;
  /**
   * The keep/cut call made at the founder gate, recorded separately from
   * `human_useful` on purpose.
   *
   * The gate asks the same question, so it seeds usefulness — that is how the
   * eval set grows without anyone doing eval chores. But keeping it in its own
   * field means a later `npm run label -- --redo` can overrule it and survive
   * the next rebuild. Folding the two together would make every rebuild quietly
   * revert the correction.
   */
  review_keep: boolean | null;
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
  if (!existsSync(OUT_ROOT)) return [];
  return readdirSync(OUT_ROOT)
    .filter((d) => !d.startsWith("smoke-") && !d.startsWith("fixture-"))
    .filter((d) => existsSync(path.join(OUT_ROOT, d, "capture.json")))
    .filter(
      (d) =>
        existsSync(path.join(OUT_ROOT, d, "findings.json")) ||
        existsSync(path.join(OUT_ROOT, d, "results.html")),
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

/**
 * Audits the state machine has retired, which must not be scored.
 *
 * A FAILED audit is one we decided is not a real audit — a timeout, or a run
 * superseded because the capture it rested on was wrong. On 2026-08-16 three
 * retired Cotopaxi runs were still contributing 38 findings here, including
 * the four built on the off-canvas capture, and they scored **0 false**:
 * `claims.ts` cannot see a visibility problem, so a broken capture reads as a
 * clean audit and quietly raises precision.
 *
 * Unknown is not failed. The six oldest audits predate the `audits` table and
 * have no row at all; they stay in. Only an explicit FAILED is removed.
 */
function retiredAudits(): Map<string, string> {
  const out = new Map<string, string>();
  try {
    const store = new AuditStore();
    for (const status of ["FAILED", "CAPTURE_FAILED"] as const) {
      for (const row of store.list(status)) out.set(row.audit_id, status);
    }
    store.close();
  } catch {
    // No database yet is a legitimate state — corpus predates the audits table.
  }
  return out;
}

export function buildCorpus(): Corpus {
  // Human labels survive a rebuild; that work is expensive and must not be
  // thrown away because a claim check was refined.
  const previous = new Map(loadCorpus().findings.map((f) => [f.key, f]));

  const built: Corpus = { built_from: [], skipped: [], findings: [] };
  const retired = retiredAudits();

  for (const auditId of completedAudits()) {
    const dir = path.join(OUT_ROOT, auditId);

    const retiredAs = retired.get(auditId);
    if (retiredAs) {
      built.skipped.push({
        audit_id: auditId,
        reason: `${retiredAs} — retired by the state machine, not scored`,
      });
      continue;
    }

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

    // The founder gate's keep/cut decisions, where this audit has been through
    // it. See LabelledFinding.review_keep for why these stay in their own field.
    const reviewFile = path.join(dir, "review.json");
    const review = existsSync(reviewFile)
      ? new Map(
          (JSON.parse(readFileSync(reviewFile, "utf8")) as ReviewRecord).decisions.map((d) => [
            d.finding_id,
            d,
          ]),
        )
      : new Map<string, ReviewDecision>();

    for (const f of findings) {
      const key = `${auditId}:${f.id}`;
      const verdict = checkClaim(f, capture);
      const prior = previous.get(key);
      const decision = review.get(f.id);
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
        // Recovered-from-HTML findings predate citations entirely, and every
        // one of them genuinely shipped uncited, so `none` is the fact rather
        // than a stand-in for missing data.
        source_type: "citation" in f ? (f as Finding).citation.source_type : "none",
        auto: { status: verdict.status, contradictions: verdict.contradictions },
        human_true: prior?.human_true ?? null,
        // An explicit label wins over the gate decision, so a `--redo` survives
        // the next rebuild. With no label, the gate's keep/cut is the answer.
        human_useful: prior?.human_useful ?? decision?.keep ?? null,
        human_note: prior?.human_note ?? decision?.note ?? null,
        review_keep: decision?.keep ?? null,
      });
    }
  }

  mkdirSync(CORPUS, { recursive: true });
  writeFileSync(CORPUS_FILE, JSON.stringify(built, null, 2) + "\n");
  return built;
}
