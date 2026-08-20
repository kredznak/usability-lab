import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuditStore, CallLog } from "./db.js";

/**
 * `npm run research:replay` — the population it picks, and the money it does not spend.
 *
 * ## Why this is a subprocess test
 *
 * `replay.ts` is a top-level script: importing it runs it. The same shape as
 * `outcome.ts`, and the same reason `review.test.ts` spawns rather than imports.
 * `USABILITY_LAB_DB` and `USABILITY_LAB_OUT` redirect everything, so no test
 * here can touch the real database or the real `out/`.
 *
 * ## What is actually being protected
 *
 * **The population.** The replay's whole purpose is a before/after against
 * `npm run outcome`'s 61.6%. If it scores a different set of audits than the
 * corpus does, the comparison is arithmetic between two unrelated numbers — and
 * it will still print, neatly, to one decimal place.
 *
 * The first version of this script did exactly that: twelve audits where the
 * corpus holds six, including two Cotopaxi runs retired for resting on a broken
 * capture. Those runs score **0 false** — `claims.ts` cannot see a capture that
 * lost half the page — so including them raises whatever is being measured while
 * looking like more evidence.
 *
 * **The money.** `--dry-run` must not need an API key, because the point of it
 * is to be safe to run before deciding to spend. Asserted by running it with the
 * key removed from the environment.
 */

interface Fixture {
  root: string;
  dbPath: string;
  outRoot: string;
}

/** An audit on disk with everything the replay needs, plus a research call. */
function seed(
  fx: Fixture,
  auditId: string,
  opts: { status?: string; researchOk?: boolean; researchRan?: boolean; reauditOf?: string } = {},
): void {
  const dir = path.join(fx.outRoot, auditId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "findings.json"),
    JSON.stringify([
      {
        id: "f1",
        agent: "heuristics",
        heuristic: "Consistency and Standards",
        severity: 2,
        element_ref: null,
        observation: "Two labels for one thing.",
        impact_note: "Readers hesitate.",
        positive: false,
        screen_ref: "s",
        confidence: "high",
        citation: { source_type: "none", url: null },
        evidence: { screenshot_id: "s", bbox: null },
      },
    ]),
  );
  writeFileSync(
    path.join(dir, "citations.json"),
    JSON.stringify([{ finding_id: "f1", source_id: null, why: "nothing fits" }]),
  );
  writeFileSync(path.join(dir, "capture.json"), JSON.stringify({ final_url: `https://${auditId}.example/` }));

  const store = new AuditStore(fx.dbPath);
  store.create(auditId, `https://${auditId}.example/`, opts.reauditOf ?? null);

  /**
   * Walk to REVIEW_PENDING, then either publish or fail.
   *
   * **PUBLISHED is terminal** — `LEGAL.PUBLISHED` is empty and `TERMINAL`
   * excludes it from the any-step-can-fail rule, so a published audit can never
   * be retired. The first version of this fixture published first and then tried
   * to fail, which silently left it PUBLISHED and made the exclusion test pass
   * an audit it meant to exclude. That is how the real ones were retired too:
   * from REVIEW_PENDING, before publishing.
   */
  for (const to of ["CAPTURING", "AUDITING", "ASSEMBLING", "REVIEW_PENDING"] as const) {
    store.transition(auditId, to);
  }
  store.transition(auditId, (opts.status ?? "PUBLISHED") as never);
  store.close();

  if (opts.researchRan !== false) {
    const log = new CallLog(fx.dbPath);
    log.record({
      audit_id: auditId,
      agent: "researcher",
      model: "claude-sonnet-5",
      prompt_version: "researcher-v1",
      input_tokens: 1,
      output_tokens: 1,
      cache_read_tokens: 0,
      cache_write_tokens: 0,
      latency_ms: 1,
      cost_usd: 0,
      ok: opts.researchOk !== false,
      error: opts.researchOk === false ? "boom" : null,
    });
    log.close();
  }
}

function makeFixture(): Fixture {
  const root = mkdtempSync(path.join(tmpdir(), "ulab-replay-"));
  return { root, dbPath: path.join(root, "db.sqlite"), outRoot: path.join(root, "out") };
}

function runDry(fx: Fixture): string {
  // The API key is deliberately stripped: --dry-run that needs a key is not a
  // dry run, it is a run you have to be brave to try.
  const { ANTHROPIC_API_KEY: _dropped, ...env } = process.env;
  return execFileSync(
    "node",
    ["--import", "tsx", "src/replay.ts", "--dry-run"],
    {
      encoding: "utf8",
      env: { ...env, USABILITY_LAB_DB: fx.dbPath, USABILITY_LAB_OUT: fx.outRoot },
    },
  );
}

describe("which audits the replay is allowed to score", () => {
  test("a retired audit is excluded, however complete its artifacts look", () => {
    /**
     * The bug this test exists for. A FAILED audit has findings, citations and a
     * successful research call on disk — it looks perfect. `corpus.ts` skips it
     * because the capture underneath was wrong, and the replay is compared
     * against the corpus's number, so it has to skip the same rows.
     */
    const fx = makeFixture();
    try {
      seed(fx, "aaaaaaaa-0000-4000-8000-000000000001");
      seed(fx, "bbbbbbbb-0000-4000-8000-000000000002", { status: "FAILED" });
      const out = runDry(fx);
      assert.match(out, /aaaaaaaa/);
      assert.doesNotMatch(out, /bbbbbbbb/, "a retired audit must not reach the replay set");
      assert.match(out, /1 audit\(s\)/);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("a re-audit is excluded — monitoring is not eval data", () => {
    // Kelly's call, 2026-08-17, and the corpus already enforces it. basecamp was
    // 3 of 9 published audits before anyone chose this.
    const fx = makeFixture();
    try {
      seed(fx, "cccccccc-0000-4000-8000-000000000003");
      seed(fx, "dddddddd-0000-4000-8000-000000000004", {
        reauditOf: "cccccccc-0000-4000-8000-000000000003",
      });
      const out = runDry(fx);
      assert.match(out, /cccccccc/);
      assert.doesNotMatch(out, /dddddddd/, "a re-audit must not reach the replay set");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("an audit whose research never ran has no baseline and is skipped", () => {
    const fx = makeFixture();
    try {
      seed(fx, "eeeeeeee-0000-4000-8000-000000000005");
      seed(fx, "ffffffff-0000-4000-8000-000000000006", { researchRan: false });
      const out = runDry(fx);
      assert.match(out, /eeeeeeee/);
      assert.doesNotMatch(out, /ffffffff/, "no research call means nothing to compare against");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("an audit whose research crashed is skipped, not counted as zero", () => {
    // Its citations.json is empty by failure, not by judgment. Included, it would
    // show a spectacular improvement from nothing and mean nothing.
    const fx = makeFixture();
    try {
      seed(fx, "11111111-0000-4000-8000-000000000007");
      seed(fx, "22222222-0000-4000-8000-000000000008", { researchOk: false });
      const out = runDry(fx);
      assert.match(out, /11111111/);
      assert.doesNotMatch(out, /22222222/, "a crashed step is not a baseline");
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});

describe("--dry-run spends nothing", () => {
  test("it runs with no API key at all, and writes no replay files", () => {
    const fx = makeFixture();
    try {
      const auditId = "33333333-0000-4000-8000-000000000009";
      seed(fx, auditId);
      const out = runDry(fx);
      assert.match(out, /nothing was sent and nothing was spent/);
      assert.match(out, /1 research call/, "it should say what it would do");

      const dir = path.join(fx.outRoot, auditId);
      assert.ok(
        !readdirSync(dir).includes("replays"),
        "a dry run must not create the directory a real run writes to",
      );
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });

  test("the baseline it reports is read from citations.json, not recomputed", () => {
    // If this drifted from what `npm run outcome` reads, the before/after would
    // compare two different definitions of "cited" and still print cleanly.
    const fx = makeFixture();
    try {
      const auditId = "44444444-0000-4000-8000-000000000010";
      seed(fx, auditId);
      writeFileSync(
        path.join(fx.outRoot, auditId, "citations.json"),
        JSON.stringify([{ finding_id: "f1", source_id: "nng-ten-heuristics", why: "supported" }]),
      );
      assert.match(runDry(fx), /baseline 1\/1 cited/);
    } finally {
      rmSync(fx.root, { recursive: true, force: true });
    }
  });
});
