import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

/**
 * `npm run audit`, at the two doors that cost nothing to open.
 *
 * Everything past argument handling in `index.ts` launches a browser and spends
 * money, which is why this file only tests what happens *before* that — and why
 * both cases below run with `ANTHROPIC_API_KEY` deliberately removed. If either
 * of them ever gets far enough to want a key, the test fails loudly rather than
 * quietly buying an audit.
 *
 * **`runQueue` beyond the empty case is not covered here.** It shells out per
 * request, so exercising it means a real capture. It is verified by hand and the
 * backlog says so, so the green tick below is not read as more than it is.
 */

function run(args: string[]): { code: number | null; err: string } {
  const dir = mkdtempSync(path.join(tmpdir(), "ulab-cli-"));
  try {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      USABILITY_LAB_DB: path.join(dir, "t.db"),
      USABILITY_LAB_OUT: dir,
    };
    delete env.ANTHROPIC_API_KEY;
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", path.resolve("src/index.ts"), ...args],
      { env, encoding: "utf8" },
    );
    return { code: result.status, err: `${result.stderr}${result.stdout}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("the audit CLI's front door", () => {
  test("--audit-id must be a UUID, and is checked before the API key is", () => {
    // The ordering is the assertion. A caller who mistypes an id should be told
    // that, not told about their credentials — and this id becomes a directory
    // name under `out/` and a primary key, so "whatever the caller said" is not
    // a thing either of those should be.
    const bad = run(["https://example.com/", "--audit-id", "../../etc"]);
    assert.equal(bad.code, 2);
    assert.match(bad.err, /--audit-id must be a UUID/);
    assert.doesNotMatch(bad.err, /ANTHROPIC_API_KEY/);
  });

  test("a real UUID gets past that check and stops at the missing key", () => {
    // The other half: without this, the test above would pass just as well if
    // the flag were ignored entirely.
    const good = run([
      "https://example.com/",
      "--audit-id",
      "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
    ]);
    assert.equal(good.code, 2);
    assert.match(good.err, /ANTHROPIC_API_KEY/);
  });

  test("an empty queue says so, and spends nothing finding out", () => {
    const empty = run(["--queue"]);
    assert.equal(empty.code, 0);
    assert.match(empty.err, /Nothing queued/);
    // It never reached the key check, because there was nothing to run.
    assert.doesNotMatch(empty.err, /ANTHROPIC_API_KEY/);
  });
});
