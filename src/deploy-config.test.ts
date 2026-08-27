import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * The tunnel's config, guarded — added 2026-08-27, runbook §12.
 *
 * Nothing in the product imports this file; cloudflared reads it, and cloudflared
 * is not something a test can start. So these are text assertions on a YAML file,
 * which is a weak kind of test and worth being honest about: they cannot prove
 * the tunnel works. What they can do is notice the two edits that would be made
 * for good reasons and would not look wrong afterwards.
 *
 * Both are failures of the same kind as the ones in §11 and §12 — silent.
 */

const CONFIG = new URL("../deploy/cloudflared-config.yml", import.meta.url);
const source = readFileSync(CONFIG, "utf8");

/** Strip comments; every claim here is about a directive, not about prose. */
const directives = source
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

describe("the tunnel keeps a record of itself", () => {
  test("it writes a log at all", () => {
    /**
     * On 2026-08-27 the site answered a 1033 and recovered, and the reason was
     * unrecoverable: the tunnel was writing to a shell that no longer existed.
     * Deleting this line restores that state exactly, and nothing about the
     * running site would look any different.
     */
    assert.match(
      directives,
      /^log-directory:\s*\S+/m,
      "the tunnel is back to writing its log nowhere, so the next 1033 is unexplainable",
    );
  });

  test("the log rotates, rather than growing until the disk does", () => {
    // `logfile` is the obvious alternative and is wrong for a process that runs
    // for days: it is a single file with no bound. `log-directory` gets
    // cloudflared's rolling logger, five files of 1MB. `.logs/worker.log` is the
    // local demonstration — 95KB of the words "Nothing queued."
    assert.doesNotMatch(
      directives,
      /^logfile:/m,
      "logfile grows without limit; log-directory rotates",
    );
  });

  test("the log path is relative, so the config survives another machine", () => {
    /**
     * The same argument the file already makes for leaving `credentials-file`
     * out: an absolute path carries a username, and this config exists because
     * the ingress was once in an untracked dotfile that did not survive a move.
     */
    const path = directives.match(/^log-directory:\s*(\S+)/m)?.[1];
    assert.ok(path, "no log-directory to check");
    assert.doesNotMatch(path, /^[/~]/, `${path} is absolute and will not move machines`);
    assert.doesNotMatch(path, /Users|home/i, `${path} names somebody's account`);
  });
});

describe("raising the log level would put credentials on disk", () => {
  /**
   * The one that matters, and the one most likely to be undone by someone doing
   * the right thing. At `debug` cloudflared logs every request URL and every
   * request and response header. On this site that is magic-link tokens, which
   * arrive *in the URL* and are bearer credentials for an account, and the
   * `ul_full` cookie — written in the clear into a file in the working tree.
   *
   * Debugging a tunnel problem is exactly when somebody raises this, and the
   * leak leaves no trace: the site keeps working and the log looks informative.
   */
  test("the level is pinned, and pinned below debug", () => {
    const level = directives.match(/^loglevel:\s*(\S+)/m)?.[1];
    assert.ok(level, "loglevel is unset, so nothing stops it being raised silently");
    assert.doesNotMatch(
      level,
      /^(debug|trace)$/i,
      "debug logs request URLs and all headers — magic-link tokens and ul_full in the clear",
    );
  });

  test("the transport level cannot be used as a way round it", () => {
    // `--transport-loglevel` is a separate setting with its own default. It logs
    // the connection layer rather than requests, so it is less dangerous, but it
    // is the obvious next thing to raise and it is worth it being a deliberate
    // edit against a named expectation rather than an unnoticed one.
    const proto = directives.match(/^(?:transport-loglevel|proto-loglevel):\s*(\S+)/m)?.[1];
    if (proto === undefined) return; // unset is the default, which is `info`
    assert.doesNotMatch(proto, /^(debug|trace)$/i, "transport logging raised to debug");
  });
});

describe("the origin the tunnel dials", () => {
  test("every hostname points at the same local port, and it is loopback", () => {
    /**
     * Two ingress rules exist so `www` reaches the same process as the apex.
     * They drifting apart is a plausible edit — someone points `www` at a second
     * port while testing — and the symptom would be that magic links work on one
     * hostname and not the other, which is `server.ts`'s cookie-scope problem
     * arriving by a different road.
     */
    const services = [...directives.matchAll(/^\s*service:\s*(http:\/\/\S+)/gm)].map((m) => m[1]);
    assert.ok(services.length >= 2, `expected both hostnames to have an origin, saw ${services.length}`);
    assert.equal(new Set(services).size, 1, `the hostnames dial different origins: ${services.join(", ")}`);
    assert.match(services[0]!, /^http:\/\/127\.0\.0\.1:\d+$/, "the origin should be loopback");
  });

  test("the last rule has no hostname, which cloudflared requires", () => {
    // Without it cloudflared refuses the config at startup — a failure that
    // happens before the log exists, which is why the runbook runs
    // `ingress validate` before starting rather than after.
    const rules = directives.slice(directives.indexOf("ingress:")).trimEnd().split(/\n(?=\s*-\s)/);
    assert.doesNotMatch(rules.at(-1)!, /hostname:/, "the catch-all rule has grown a hostname");
  });
});
