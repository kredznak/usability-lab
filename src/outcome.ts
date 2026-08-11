import { writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { loadCorpus, type LabelledFinding } from "./corpus.js";
import { FREE_FINDINGS } from "./render.js";

/**
 * Outcome suite — docs/design.md §10, at the smallest size that is useful.
 *
 *   npm run outcome        # score the frozen corpus, write the review queue
 *
 * Scores saved findings, so it costs nothing and runs in milliseconds. What it
 * measures and what it does NOT are both worth being explicit about:
 *
 *   measured   — precision (are reported findings true?), and whether
 *                high-confidence findings are more often true than the rest,
 *                which is the whole claim "high confidence" makes.
 *   deferred   — recall. §10 wants it against hand-labelled issue lists per
 *                site, roughly two hours of work each. Without those lists any
 *                recall number here would be invented, so none is printed.
 *
 * A mechanical `verified` is provisional: it means nothing checkable is wrong,
 * not that a person agreed it was worth reporting. Where human labels exist
 * they win, and the report always says how much of the score rests on which.
 */

/** §10: "precision of reported findings ≥ 80%". */
const MIN_PRECISION = 0.8;
/** §10: "confidence calibration (high-confidence findings verified correct ≥ 90%)". */
const MIN_HIGH_CONFIDENCE_CORRECT = 0.9;

const QUEUE = "fixtures/labelled/review-queue.md";

type Truth = "true" | "false" | "unknown";

/**
 * Is the claim true? Human adjudication overrules the checker where it exists;
 * otherwise the mechanical verdict stands.
 *
 * Deliberately separate from usefulness. A true-but-trivial finding is a
 * precision success and a product failure, and a single label conflating the
 * two would report it as neither.
 */
function truthOf(f: LabelledFinding): Truth {
  if (f.human_true === true) return "true";
  if (f.human_true === false) return "false";
  if (f.auto.status === "contradicted") return "false";
  if (f.auto.status === "verified") return "true";
  return "unknown";
}

function pct(n: number, d: number): string {
  return d === 0 ? "  n/a" : `${((n / d) * 100).toFixed(1).padStart(5)}%`;
}

const corpus = loadCorpus();
if (corpus.findings.length === 0) {
  console.error("No corpus. Run `npm run corpus` first (it reads completed audits from out/).");
  process.exit(2);
}

const scored = corpus.findings.map((f) => ({ f, truth: truthOf(f) }));
const judged = scored.filter((s) => s.truth !== "unknown");
const trueOnes = judged.filter((s) => s.truth === "true");
const falseOnes = judged.filter((s) => s.truth === "false");

const high = judged.filter((s) => s.f.confidence === "high");
const highTrue = high.filter((s) => s.truth === "true");
const medium = judged.filter((s) => s.f.confidence !== "high");
const mediumTrue = medium.filter((s) => s.truth === "true");

const precision = judged.length === 0 ? 0 : trueOnes.length / judged.length;
const highCorrect = high.length === 0 ? 0 : highTrue.length / high.length;

console.log(`\ncorpus: ${corpus.findings.length} findings from ${corpus.built_from.length} audits`);
if (corpus.skipped.length > 0) {
  console.log(`        ${corpus.skipped.length} audit(s) skipped — see fixtures/labelled/findings.json`);
}

const humanLabelled = corpus.findings.filter(
  (f) => f.human_true !== null || f.human_useful !== null,
).length;
console.log(
  `labels: ${humanLabelled} human, ${corpus.findings.length - humanLabelled} mechanical only\n`,
);

console.log(`  precision                   ${pct(trueOnes.length, judged.length)}   ` +
  `(${trueOnes.length}/${judged.length}, floor ${MIN_PRECISION * 100}%)`);
console.log(`  high-confidence correct     ${pct(highTrue.length, high.length)}   ` +
  `(${highTrue.length}/${high.length}, floor ${MIN_HIGH_CONFIDENCE_CORRECT * 100}%)`);
console.log(`  medium-confidence correct   ${pct(mediumTrue.length, medium.length)}   ` +
  `(${mediumTrue.length}/${medium.length})`);

// Which lane produces the false claims is the actionable number — it points at
// a rubric to fix rather than a score to worry about.
const byAgent = new Map<string, { n: number; bad: number }>();
for (const s of judged) {
  for (const agent of s.f.agent.split("+").map((a) => a.trim())) {
    const row = byAgent.get(agent) ?? { n: 0, bad: 0 };
    row.n++;
    if (s.truth === "false") row.bad++;
    byAgent.set(agent, row);
  }
}
console.log(`\n  by reviewer:`);
for (const [agent, row] of [...byAgent.entries()].sort((a, b) => b[1].bad - a[1].bad)) {
  console.log(
    `    ${agent.padEnd(22)} ${String(row.n).padStart(3)} findings, ` +
      `${row.bad} false${row.bad > 0 ? `  <- ${pct(row.bad, row.n).trim()} of its output` : ""}`,
  );
}

// Per audit, because an aggregate hides the thing you most want to know: a
// corpus built mostly from runs made before a fix will report the quality of
// the code that was replaced, and read as if it were current.
console.log(`\n  by audit:`);
for (const a of corpus.built_from) {
  const rows = judged.filter((s) => s.f.audit_id === a.audit_id);
  const bad = rows.filter((s) => s.truth === "false").length;
  console.log(
    `    ${a.audit_id.slice(0, 8)} ${String(rows.length).padStart(3)} findings, ` +
      `${bad} false   ${a.url}`,
  );
}

if (falseOnes.length > 0) {
  console.log(`\n  false findings:`);
  for (const s of falseOnes) {
    // A finding a person marked false with no note leaves nothing to print, and
    // a blank line reads like a bug. Fall back to what the finding claimed.
    const why =
      s.f.auto.contradictions[0] ??
      s.f.human_note ??
      `judged false: ${s.f.observation}`;
    console.log(
      `    ${s.f.audit_id.slice(0, 8)} ${s.f.agent.slice(0, 20).padEnd(20)} ${why.slice(0, 90)}`,
    );
  }
}

// Usefulness — the axis no check can reach, and the one that decides whether
// the audit is worth paying for. Reported only where a person has actually
// answered; there is no defensible way to guess it.
const withUsefulness = corpus.findings.filter((f) => f.human_useful !== null);
if (withUsefulness.length === 0) {
  console.log(
    `\n  signal rate                  not measured` +
      `\n${"".padEnd(4)}  Of the findings that are true, how many would a founder act on?` +
      `\n${"".padEnd(4)}  Nothing mechanical can answer this. Run \`npm run label\`.`,
  );
} else {
  const usefulCount = withUsefulness.filter((f) => f.human_useful).length;
  console.log(
    `\n  signal rate                 ${pct(usefulCount, withUsefulness.length)}   ` +
      `(${usefulCount}/${withUsefulness.length} judged actionable)`,
  );
  const trivial = withUsefulness.filter(
    (f) => !f.human_useful && truthOf(f) === "true",
  ).length;
  if (trivial > 0) {
    console.log(
      `  true but nobody would act   ${String(trivial).padStart(6)}   ` +
        `<- what the Synthesizer should have excluded`,
    );
  }
}

/**
 * Rank agreement — does the Synthesizer's order survive contact with a founder?
 *
 * This is the number the business rests on. Three findings are shown free and
 * the rest are held back, so if the Synthesizer's top three are the ones a
 * founder would have cut, the visitor's whole impression of the product is
 * formed by our worst work while the good findings sit behind the gate.
 *
 * Measured only on audits that have been through `npm run review`. Rank is the
 * position among an audit's non-positive findings, which is the order the
 * pipeline preserved from synthesis.
 */
const reviewed = corpus.built_from.filter((a) =>
  corpus.findings.some((f) => f.audit_id === a.audit_id && f.review_keep !== null),
);

if (reviewed.length === 0) {
  console.log(
    `\n  rank agreement               not measured` +
      `\n${"".padEnd(4)}  No audit has been through \`npm run review\` yet. The gate records` +
      `\n${"".padEnd(4)}  keep/cut, and that is what this compares the ranking against.`,
  );
} else {
  let freeShown = 0;
  let freeKept = 0;
  let severeWithheld = 0;
  const keptRanks: number[] = [];
  const cutRanks: number[] = [];

  for (const a of reviewed) {
    const issues = corpus.findings.filter((f) => f.audit_id === a.audit_id && !f.positive);
    for (const [rank, f] of issues.entries()) {
      if (f.review_keep === null) continue;
      const free = rank < FREE_FINDINGS;
      if (free) {
        freeShown++;
        if (f.review_keep) freeKept++;
      }
      // The unguarded risk in renderPublic: rank may withhold something severe.
      if (!free && f.review_keep && f.severity >= 3) severeWithheld++;
      (f.review_keep ? keptRanks : cutRanks).push(rank + 1);
    }
  }

  const mean = (xs: number[]) => (xs.length === 0 ? 0 : xs.reduce((s, x) => s + x, 0) / xs.length);

  console.log(
    `\n  rank agreement              ${pct(freeKept, freeShown)}   ` +
      `(${freeKept}/${freeShown} of the free three survived review)`,
  );
  if (cutRanks.length > 0) {
    // Cuts belong at the bottom. If the two means converge, rank is carrying no
    // information about what a founder actually wants shown.
    console.log(
      `  mean rank  kept ${mean(keptRanks).toFixed(1).padStart(4)}   ` +
        `cut ${mean(cutRanks).toFixed(1).padStart(4)}   ` +
        (mean(cutRanks) > mean(keptRanks)
          ? `<- cuts sit lower, as they should`
          : `<- cuts are NOT sitting lower; rank is not tracking usefulness`),
    );
  }
  if (severeWithheld > 0) {
    console.log(
      `  severe findings withheld    ${String(severeWithheld).padStart(6)}   ` +
        `<- severity 3+ kept by review but ranked outside the free three`,
    );
  }
}

// The review queue: everything a person still has to judge, phrased so each
// entry is answerable without reopening the audited page.
const queue = scored.filter((s) =>
  s.f.auto.status === "contradicted" ? s.f.human_true === null : s.f.human_useful === null,
);
mkdirSync(path.dirname(QUEUE), { recursive: true });
writeFileSync(
  QUEUE,
  [
    `# Review queue`,
    ``,
    `${queue.length} findings await a human label. The fastest way through this is`,
    `\`npm run label\`, which asks one question at a time and saves as it goes.`,
    ``,
    `The machine has already checked what it can: cited elements exist, quotes appear`,
    `on the page, measurements match. What it cannot judge is whether anyone would act`,
    `on a true statement — that is the question below.`,
    ``,
    ...queue.flatMap(({ f, truth }) => [
      `## ${f.key}`,
      ``,
      `- **${f.agent}** · severity ${f.severity} · ${f.confidence} confidence` +
        `${f.positive ? " · positive" : ""} · ${f.element_ref ?? "page-level"}`,
      `- ${f.url}`,
      `- mechanical: **${f.auto.status}**${
        f.auto.contradictions.length ? ` — ${f.auto.contradictions.join("; ")}` : ""
      }`,
      ``,
      `> ${f.observation}`,
      ``,
      `> ${f.impact_note}`,
      ``,
      f.auto.status === "contradicted"
        ? `**Question:** the check above says this contradicts the capture. Is the check right?`
        : `**Question:** would a founder change something because of this?`,
      ``,
    ]),
  ].join("\n"),
  "utf8",
);
console.log(`\n  review queue: ${QUEUE} (${queue.length} to judge)`);

const failures: string[] = [];
if (judged.length > 0 && precision < MIN_PRECISION) {
  failures.push(`precision ${(precision * 100).toFixed(1)}% is below §10's ${MIN_PRECISION * 100}% floor`);
}
if (high.length > 0 && highCorrect < MIN_HIGH_CONFIDENCE_CORRECT) {
  failures.push(
    `high-confidence findings are correct ${(highCorrect * 100).toFixed(1)}% of the time, ` +
      `below §10's ${MIN_HIGH_CONFIDENCE_CORRECT * 100}% floor — "high" is claiming more than it earns`,
  );
}

if (failures.length > 0) {
  console.error(`\nFAIL`);
  for (const f of failures) console.error(`  ${f}`);
  console.error("");
  process.exitCode = 1;
} else {
  console.log(`\nPASS — both §10 floors met on the labels available.\n`);
}
