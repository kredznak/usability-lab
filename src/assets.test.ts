import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { asset, ASSET_NAMES } from "./assets.js";

/**
 * The asset route, and the one property that matters about it.
 *
 * `server.ts`'s header already promises this repo "refuses any file it was not
 * asked to serve" — audit images are matched against an allowlist built from
 * the audit id rather than sanitised for `..`. This is that rule for a second
 * kind of file, taken one step further: the files are read into memory at boot,
 * so a request path never reaches the filesystem at all. Traversal is not
 * mitigated here. It has nowhere to happen.
 *
 * The image-route tests two hundred lines away in `server.test.ts` carry a
 * warning worth repeating: the first version of those asserted that
 * `../../../etc/passwd` was refused, and it was — but deleting the allowlist
 * entirely did not turn them red, because `new URL()` resolves dot-segments
 * before a router sees them and a missing file 404s on its own. Four green
 * assertions covering nothing.
 *
 * So the load-bearing test below is not the traversal one. It is
 * `an unknown name is null` — a name with no `..` in it, which a path-joining
 * implementation would happily try to open.
 */

describe("the asset allowlist", () => {
  test("serves the font it was built with", () => {
    const got = asset("inter.woff2");
    assert.ok(got, "the font must be readable at boot");
    assert.equal(got.type, "font/woff2");
    // wOF2 — if the subsetting step ever emits a bare ttf, this is what says so.
    assert.equal(got.body.subarray(0, 4).toString("latin1"), "wOF2");
    assert.ok(got.body.length > 20_000, "a woff2 that small is not a whole typeface");
  });

  test("a traversal attempt is just an unknown name", () => {
    for (const name of ["../.env", "../../etc/passwd", "/etc/passwd", "..%2f.env", "", "."]) {
      assert.equal(asset(name), null, name);
    }
  });

  /**
   * The one that separates an allowlist from a `readFileSync`. No dot-segments,
   * nothing a router would normalise away — just a file that exists on disk
   * beside the one we meant to serve.
   */
  test("a real neighbouring file is still not servable", () => {
    assert.equal(asset("inter-LICENSE.txt"), null, "it ships, but nothing serves it");
    assert.equal(asset("README.md"), null);
  });

  test("an unknown name is null, not a guess", () => {
    assert.equal(asset("inter.woff"), null);
    assert.equal(asset("INTER.WOFF2"), null, "the lookup is exact, not case-folded");
  });

  test("the allowlist is a fixed set, not a directory listing", () => {
    assert.deepEqual(ASSET_NAMES, ["inter.woff2"]);
  });
});
