import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isBroken, summarize } from "./sources-check.js";

/**
 * The link checker's judgment, without a network.
 *
 * What `npm run sources:check` gets wrong is not "does fetch work" — it is what
 * it decides about the answer. A checker that quietly treats a 404 as fine, or
 * that fails the build on a harmless redirect, is worse than none: the first
 * hides broken evidence and the second trains you to ignore it.
 */
const at = (status: number, movedTo: string | null = null) => ({
  id: "nng-ten-heuristics",
  url: "https://www.nngroup.com/articles/ten-usability-heuristics/",
  status,
  movedTo,
  error: null,
  ms: 12,
});

describe("what counts as a citation that does not resolve", () => {
  test("200 is fine", () => {
    assert.equal(isBroken(at(200)), false);
  });

  test("404 and 410 are broken", () => {
    // The whole reason this exists: an article that moved and left nothing.
    assert.equal(isBroken(at(404)), true);
    assert.equal(isBroken(at(410)), true);
  });

  test("a server error is broken, not ignored", () => {
    // Tempting to treat 5xx as "their problem, try later". But the customer
    // clicking it sees the same nothing we do.
    assert.equal(isBroken(at(500)), true);
    assert.equal(isBroken(at(503)), true);
  });

  test("no answer at all is broken", () => {
    // status 0 is the timeout/DNS case. `0 < 200` must be the broken branch,
    // not a falsy value that slips through a truthiness check.
    assert.equal(isBroken({ ...at(0), error: "timed out" }), true);
  });

  test("a 3xx that fetch already followed is reported by its final status", () => {
    // `redirect: "follow"` means a 301 is never the status we see — we see the
    // 200 it landed on, plus a movedTo. A checker asserting `status === 301` to
    // find moves would find none, for ever.
    assert.equal(isBroken(at(200, "https://www.nngroup.com/articles/renamed/")), false);
  });
});

describe("moved is worth saying and not worth failing", () => {
  test("a redirect is listed as moved, not as broken", () => {
    const { broken, moved } = summarize([at(200, "https://www.nngroup.com/articles/renamed/")]);
    assert.equal(broken.length, 0, "a browser follows it too");
    assert.equal(moved.length, 1, "but the table has drifted and should be updated");
  });

  test("a broken URL is never also counted as moved", () => {
    // Double-counting would make "28 of 28 resolve" and "1 moved" both true of
    // the same row, which is the 200%-review-row shape.
    const { broken, moved } = summarize([at(404, "https://www.nngroup.com/404")]);
    assert.equal(broken.length, 1);
    assert.equal(moved.length, 0);
  });

  test("an untouched table reports nothing at all", () => {
    const { broken, moved } = summarize([at(200), at(200), at(200)]);
    assert.equal(broken.length, 0);
    assert.equal(moved.length, 0);
  });
});
