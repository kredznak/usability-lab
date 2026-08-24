import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `npm run worker` — drains the audit queue on a timer, so nobody has to.
 *
 * ## What this changes, said plainly
 *
 * "No HTTP request may spend money" is why the question flow writes a row and
 * stops: a stranger filling the queue could otherwise fill the bill. That rule
 * is still literally true — this is not an HTTP request — but the practical
 * protection it bought is gone. A stranger's submission now becomes a paid
 * audit with no human in between, and what stands in the way is arithmetic
 * rather than a person:
 *
 *   - the daily ceiling ($25 by default, F11), re-read before every audit
 *   - the per-audit ceiling ($3, §11), which stops spawning further reviewers
 *     inside one run rather than killing it
 *   - the rate limits and fair-use checks the form already applies
 *
 * Those were always the design. Until 2026-08-24 they had a person standing in
 * front of them, and now they are the whole of it.
 *
 * ## Why it shells out
 *
 * The same reason `runQueue` shells out per request: one crashed run takes down
 * one pass rather than the daemon, and "what an audit is" stays defined in
 * exactly one place. A worker that re-implemented any of it would drift.
 *
 * ## Why a sleep and not a cron
 *
 * A cron entry lives outside the repository, which `deploy-runbook.md` has
 * already been burned by once — the tunnel's ingress sat in an untracked
 * dotfile and a new machine could not know it existed. This is `npm run
 * worker`, tracked, and it stops when you stop it.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** How long to wait between passes. Short enough to feel immediate on a form. */
const INTERVAL_MS = Number(process.env.USABILITY_LAB_WORKER_INTERVAL_MS || 20_000);

let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    // The pass in flight is a subprocess of its own and is left to finish; an
    // audit killed halfway has spent its tokens and produced nothing, which is
    // the most expensive way to stop.
    console.error(`\n  ${signal} — stopping after this pass.\n`);
    stopping = true;
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

console.error(
  `\nworker started — draining the queue every ${Math.round(INTERVAL_MS / 1000)}s.\n` +
    `  Ctrl-C to stop. Ceilings still apply: this spends money without asking.\n`,
);

while (!stopping) {
  const started = Date.now();

  const run = spawnSync(
    process.execPath,
    ["--env-file-if-exists=.env", "--import", "tsx", path.join(HERE, "index.ts"), "--queue"],
    { stdio: "inherit", cwd: path.join(HERE, "..") },
  );

  // A pass that fails is reported and retried on the next tick. The alternative
  // — exiting — turns one bad URL into a stopped worker nobody notices until
  // the queue is a day deep.
  if (run.status !== 0 && run.status !== null) {
    console.error(`  queue pass exited ${run.status}; retrying next tick.`);
  }

  if (stopping) break;
  const elapsed = Date.now() - started;
  await sleep(Math.max(0, INTERVAL_MS - elapsed));
}

console.error(`  worker stopped.\n`);
