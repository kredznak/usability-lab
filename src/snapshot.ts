import { readFileSync } from "node:fs";
import { requestFor, loadCapture, writeFixture, fixturePath, digestImages } from "./agents/snapshot-request.js";
import { runSubAgent } from "./agents/runner.js";
import { pageTiles } from "./agents/tiles.js";
import { runResearcher } from "./agents/researcher.js";
import { RUBRICS } from "./agents/rubrics.js";
import { Finding } from "./types.js";

/**
 * Writes (or checks) the request-body fixtures for every sub-agent.
 * See src/agents/snapshot-request.ts for why this exists.
 */

/** The capture each agent's fixture is built from. One is enough to pin the shape. */
const FIXTURE_CAPTURE = "govuk";

/**
 * Fixed input for the Research snapshot. Two findings on different lenses, so
 * the fixture pins both the prompt and which sources the shortlist includes —
 * an accidental widening of `sourcesFor` shows up as a diff rather than as a
 * larger bill and a stretched citation.
 */
const RESEARCH_FINDINGS = [
  {
    id: "snap-f1",
    agent: "forms",
    heuristic: "Labels",
    severity: 3,
    element_ref: "el_4",
    observation: "Three of the six fields use placeholder text in place of a visible label.",
    impact_note: "The prompt disappears once typing starts, so a corrected entry cannot be checked.",
    positive: false,
    screen_ref: "s",
    confidence: "high",
    citation: { source_type: "none", url: null },
    evidence: { screenshot_id: "s", bbox: { x: 10, y: 20, width: 300, height: 40 } },
  },
  {
    id: "snap-f2",
    agent: "visual-hierarchy",
    heuristic: "Emphasis",
    severity: 2,
    element_ref: null,
    observation: "Five above-the-fold elements are set at the largest type size on the page.",
    impact_note: "With everything emphasised, nothing is, and the eye has no entry point.",
    positive: false,
    screen_ref: "s",
    confidence: "medium",
    citation: { source_type: "none", url: null },
    evidence: { screenshot_id: "s", bbox: null },
  },
].map((f) => Finding.parse(f));

const AGENTS: Record<string, Parameters<typeof requestFor>[0]> = {
  ...Object.fromEntries(
    Object.values(RUBRICS).map((rubric) => [
      rubric.id,
      async (client, capture, log) => runSubAgent(client, rubric, capture, log, await pageTiles(capture)),
    ]),
  ),
  researcher: (client, _capture, log) =>
    runResearcher(client, RESEARCH_FINDINGS, "snapshot", log),
};

const check = process.argv.includes("check");
const capture = loadCapture(FIXTURE_CAPTURE);
let drift = 0;

for (const [name, fn] of Object.entries(AGENTS)) {
  const request = await requestFor(fn, capture);
  // Digested here as well as in writeFixture, so `check` compares like for
  // like instead of diffing a digest against megabytes of base64.
  const serialized = JSON.stringify(digestImages(request), null, 2) + "\n";

  if (!check) {
    writeFixture(name, request);
    console.log(`wrote ${fixturePath(name)} (${serialized.length} bytes)`);
    continue;
  }

  let saved: string;
  try {
    saved = readFileSync(fixturePath(name), "utf8");
  } catch {
    console.error(`MISSING  ${name}: no fixture at ${fixturePath(name)}`);
    drift++;
    continue;
  }

  if (saved === serialized) {
    console.log(`ok       ${name}: request unchanged (${serialized.length} bytes)`);
  } else {
    console.error(`DRIFT    ${name}: request differs from ${fixturePath(name)}`);
    // Show the first differing line so the diff is actionable without a tool.
    const a = saved.split("\n");
    const b = serialized.split("\n");
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i] !== b[i]) {
        console.error(`  line ${i + 1}\n  saved: ${a[i] ?? "(eof)"}\n  now:   ${b[i] ?? "(eof)"}`);
        break;
      }
    }
    drift++;
  }
}

if (drift > 0) {
  console.error(
    `\n${drift} request(s) drifted. If the change was intended, re-run \`npm run snapshot\`` +
      ` and review the diff in the commit.`,
  );
  process.exitCode = 1;
}
