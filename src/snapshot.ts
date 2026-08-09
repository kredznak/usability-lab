import { readFileSync } from "node:fs";
import { requestFor, loadCapture, writeFixture, fixturePath } from "./agents/snapshot-request.js";
import { runSubAgent } from "./agents/runner.js";
import { RUBRICS } from "./agents/rubrics.js";

/**
 * Writes (or checks) the request-body fixtures for every sub-agent.
 * See src/agents/snapshot-request.ts for why this exists.
 */

/** The capture each agent's fixture is built from. One is enough to pin the shape. */
const FIXTURE_CAPTURE = "govuk";

const AGENTS: Record<string, Parameters<typeof requestFor>[0]> = Object.fromEntries(
  Object.values(RUBRICS).map((rubric) => [
    rubric.id,
    (client, capture, log) => runSubAgent(client, rubric, capture, log),
  ]),
);

const check = process.argv.includes("check");
const capture = loadCapture(FIXTURE_CAPTURE);
let drift = 0;

for (const [name, fn] of Object.entries(AGENTS)) {
  const request = await requestFor(fn, capture);
  const serialized = JSON.stringify(request, null, 2) + "\n";

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
