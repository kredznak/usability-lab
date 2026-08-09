import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline/promises";
import { loadCorpus } from "./corpus.js";

/**
 * `npm run label` — adjudicate findings one keystroke at a time.
 *
 *   npm run label                  # everything unlabelled
 *   npm run label -- 1e6d5d13      # one audit (prefix match)
 *   npm run label -- --redo        # revisit findings already labelled
 *
 * The machine has already settled what is checkable: the cited element exists,
 * quotes appear on the page, measurements match. It cannot settle the only
 * question that decides whether this product is worth £29 — is a true statement
 * worth a founder's attention? That judgment has to come from a person once,
 * and then it makes an LLM judge calibratable and everything after it cheap.
 *
 * Answers write straight into fixtures/labelled/findings.json and survive
 * `npm run corpus`. Quitting mid-way keeps everything answered so far, because
 * a labelling tool you cannot walk away from does not get used.
 */

const CORPUS_FILE = "fixtures/labelled/findings.json";

const args = process.argv.slice(2);
const redo = args.includes("--redo");
const filter = args.find((a) => !a.startsWith("--"));

const corpus = loadCorpus();
if (corpus.findings.length === 0) {
  console.error("No corpus yet. Run `npm run corpus` first.");
  process.exit(2);
}

const unanswered = (f: { human_true: boolean | null; human_useful: boolean | null; auto: { status: string } }) =>
  f.auto.status === "contradicted" ? f.human_true === null : f.human_useful === null;

const queue = corpus.findings.filter(
  (f) => (redo || unanswered(f)) && (!filter || f.audit_id.startsWith(filter)),
);

if (queue.length === 0) {
  console.log(
    filter
      ? `Nothing to label in ${filter}. Use --redo to revisit, or check the id.`
      : "Everything is labelled. `npm run label -- --redo` to revisit.",
  );
  process.exit(0);
}

const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";
const YELLOW = "\x1b[33m";

function wrap(text: string, width = 76, indent = "  "): string {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    if ((line + " " + w).trim().length > width) {
      lines.push(line.trim());
      line = w;
    } else {
      line += " " + w;
    }
  }
  if (line.trim()) lines.push(line.trim());
  return lines.map((l) => indent + l).join("\n");
}

/** Written once at the end, so a crash cannot lose a session of judgments. */
function save(): void {
  writeFileSync(CORPUS_FILE, JSON.stringify(corpus, null, 2) + "\n");
}

const rl = createInterface({ input: process.stdin, output: process.stdout });

/**
 * Resolves to null when the input closes instead of hanging forever.
 *
 * `rl.question()` never settles once the stream ends, so Ctrl-D — or any piped
 * input — left the process waiting on a promise that could not resolve, and the
 * findings judged in that session were never written. A labelling tool that
 * loses your work when you close it is a labelling tool you use once.
 */
let closed = false;
rl.on("close", () => {
  closed = true;
});

async function ask(prompt: string): Promise<string | null> {
  if (closed) return null;
  return Promise.race([
    rl.question(prompt),
    new Promise<null>((resolve) => rl.once("close", () => resolve(null))),
  ]);
}

console.log(
  `\n${BOLD}${queue.length} findings to judge.${RESET}\n\n` +
    `  Most ask one question: ${BOLD}would you show this to a founder paying for the audit?${RESET}\n` +
    `  I have already checked what is checkable, so this is not about accuracy.\n\n` +
    `  A few are marked ${RED}contradicts the capture${RESET} — for those the question changes to\n` +
    `  ${BOLD}is my check right?${RESET}, and the prompt says so.\n\n` +
    `  ${GREEN}y${RESET} yes     ${RED}n${RESET} no     ${YELLOW}s${RESET} unsure     ` +
    `${DIM}q${RESET} save and quit     ${DIM}(anything else skips)${RESET}\n` +
    `  Add a note after the letter, e.g. ${DIM}n true but nobody would care${RESET}\n`,
);

let done = 0;
for (const [i, f] of queue.entries()) {
  const flag =
    f.auto.status === "contradicted"
      ? `${RED}contradicts the capture${RESET}`
      : f.auto.status === "unverifiable"
        ? `${YELLOW}nothing checkable${RESET}`
        : `${GREEN}checks out${RESET}`;

  console.log(
    `${DIM}${"─".repeat(80)}${RESET}\n` +
      `${DIM}[${i + 1}/${queue.length}]${RESET} ${BOLD}${f.agent}${RESET} ` +
      `${DIM}·${RESET} severity ${f.severity} ${DIM}·${RESET} ${f.confidence} confidence` +
      `${f.positive ? ` ${DIM}·${RESET} ${GREEN}positive${RESET}` : ""}\n` +
      `${DIM}${f.url} · ${f.element_ref ?? "page-level"} · ${flag}${RESET}\n`,
  );
  console.log(wrap(f.observation));
  console.log(`\n${DIM}${wrap(f.impact_note)}${RESET}`);
  if (f.auto.contradictions.length > 0) {
    console.log(`\n${RED}${wrap(f.auto.contradictions.join("; "))}${RESET}`);
  }
  if (redo && (f.human_true !== null || f.human_useful !== null)) {
    const was = f.auto.status === "contradicted"
      ? `check ${f.human_true === false ? "right" : "wrong"}`
      : `${f.human_useful ? "worth showing" : "not worth it"}`;
    console.log(`\n${DIM}  previously: ${was}${f.human_note ? ` — ${f.human_note}` : ""}${RESET}`);
  }

  const isTruthQuestion = f.auto.status === "contradicted";
  const prompt = isTruthQuestion
    ? `\n  ${BOLD}Is my check right — is this finding wrong?${RESET}\n  > `
    : `\n  ${BOLD}Would you show this?${RESET}\n  > `;

  const answer = await ask(prompt);
  if (answer === null) break;

  const raw = answer.trim();
  const key = raw.charAt(0).toLowerCase();
  const note = raw.slice(1).trim();

  if (key === "q") break;

  // An unrecognised key skips rather than guesses. Recording a judgment the
  // person did not make is worse than recording none.
  if (!["y", "n", "s"].includes(key)) {
    console.log(`${DIM}  skipped${RESET}\n`);
    continue;
  }

  if (isTruthQuestion) {
    // y = my check is right, so the finding is false.
    f.human_true = key === "s" ? null : key === "n";
    if (key === "n") {
      // The check was wrong, so the finding stands and still needs judging.
      console.log(`${DIM}  noted — I will still ask whether it is worth showing${RESET}`);
    }
  } else {
    f.human_useful = key === "s" ? null : key === "y";
  }
  f.human_note = note || null;
  done++;
  save();
  console.log("");
}

rl.close();
save();

const judged = corpus.findings.filter((f) => f.human_useful !== null);
const useful = judged.filter((f) => f.human_useful).length;

console.log(
  `\n${BOLD}${done} judged this session.${RESET} ` +
    `${judged.length} of ${corpus.findings.length} have a usefulness call.\n` +
    (judged.length > 0
      ? `  worth showing: ${useful}   not worth it: ${judged.length - useful}` +
        `   (${Math.round((useful / judged.length) * 100)}% signal)\n`
      : "") +
    `\n  Saved to ${CORPUS_FILE}. Run ${BOLD}npm run outcome${RESET} to score with these.\n`,
);
