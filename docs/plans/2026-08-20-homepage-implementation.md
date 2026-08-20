# Homepage and Question Flow — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the bare form at `/` with a scrolling marketing page, and move the five questions to a stepped flow at `/start` that still works with JavaScript disabled.

**Architecture:** All HTML is generated as TypeScript strings — there is no bundler, no framework, no template engine, and none is being added. A new `marketing.ts` owns every non-audit surface (the shell, the homepage, the question flow) and `page()` moves out of `server.ts` into it. A new `assets.ts` serves one webfont from a boot-time in-memory allowlist. `render.ts` and the audit pages are untouched.

**Tech Stack:** TypeScript ESM, `tsx` loader, Node's built-in `node:http` and `node:test`, better-sqlite3. No new runtime dependencies.

**Spec:** [`docs/specs/2026-08-20-homepage-design.md`](../specs/2026-08-20-homepage-design.md)
**Approved visual reference:** [`docs/specs/2026-08-20-homepage-mockups/homepage.html`](../specs/2026-08-20-homepage-mockups/homepage.html) and [`questions.html`](../specs/2026-08-20-homepage-mockups/questions.html) — these are the signed-off designs. Port CSS from them; do not reinvent spacing.

---

## Global Constraints

Every task's requirements implicitly include this section.

- **Tokens, exact values:** `--paper:#FBFAF8` `--bone:#F2EFE9` `--plaster:#EAE5DC` `--sand:#DDD6C9` `--shade:#C9C0B2` `--sage:#D6D8D0` `--ink:#26221E` `--ink-soft:#6E665C`.
- **No accent colour on marketing pages.** `--accent:#E4572E` stays alive in `render.ts` and must not appear in `marketing.ts`.
- **Depth is tonal, never linear.** No `1px solid` borders on surfaces. Form fields are underline-only. Radii 20–22px on surfaces, 100px on buttons.
- **Never retype a number that exists in code.** Publisher counts derive from `SOURCES`; money and limits derive from `PRICE_USD`, `FREE_FINDINGS`, `SITE_LIMIT`, `AUDITS_PER_MONTH`.
- **Every interpolation of visitor text goes through `escapeHtml`** (exported from `render.ts`).
- **Events never carry page content, answer text, email addresses or tokens.** §8 makes them permanent.
- **`send()`'s CSP argument defaults to strict.** New routes are locked down unless they explicitly ask otherwise.
- **No new state-changing route.** Nothing added here reads the `ul_full` cookie, so no CSRF token is required. If that ever changes, it needs one the same day.
- **`render.ts`, `profile.ts`, the orchestrator and every agent are out of bounds.**
- **Watch every new test fail with its fix reverted before calling it evidence.** Standing rule — 134 green tests once missed four capture bugs.
- Run the full suite with `npm test`. Typecheck with `npm run typecheck`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/marketing.ts` | **New.** Every non-audit surface: tokens, shell CSS, `page()`, `homePage()`, `questionsPage()`, the stepper script and its hash, and the three CSP strings. |
| `src/marketing.test.ts` | **New.** Pure-function tests for derived numbers and the script hash. |
| `src/assets.ts` | **New.** Boot-time asset allowlist and lookup. |
| `src/assets.test.ts` | **New.** Allowlist behaviour, including traversal attempts. |
| `src/server.ts` | `send()` gains a CSP argument; `page()` and its `<style>` block are deleted; `/` replaced; `/start` and `/s/*` added. |
| `src/server.test.ts` | Two existing tests move from `/` to `/start`; new tests for events, CSP and the no-JS guarantee. |
| `src/funnel.ts` | One new printed row. |
| `src/funnel.test.ts` | Assert the new row. |
| `assets/inter.woff2`, `assets/inter-LICENSE.txt` | **New.** Vendored font + its SIL OFL licence. |

---

## Task 1: The CSP seam

The current policy denies scripts and fonts on every response. Nothing else in this plan can work until `send()` can be told otherwise — and the audit pages must keep the strict policy, because that is what stops a `<script>` captured from a stranger's site executing in a customer's browser.

**Files:**
- Modify: `src/server.ts:137-155` (`send`)
- Create: `src/marketing.ts`
- Test: `src/server.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `STRICT_CSP: string` exported from `src/marketing.ts`. `send(res, code, body, type?, extra?, csp?)` — sixth positional parameter, `csp` defaults to `STRICT_CSP`.

- [ ] **Step 1: Write the failing test**

Add to `src/server.test.ts`, inside the top-level describe that already has access to `A` (a published audit):

```ts
describe("content-security-policy", () => {
  test("an audit page denies scripts and fonts, because it quotes captured pages", async () => {
    const res = await fetch(`${BASE}/a/${A}/`);
    const csp = res.headers.get("content-security-policy")!;
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /script-src/, "an audit page must never authorise a script");
    assert.doesNotMatch(csp, /font-src/, "an audit page has no font to fetch");
    assert.doesNotMatch(csp, /unsafe-eval/);
  });

  test("a 404 is strict too — the default has to be the safe one", async () => {
    const res = await fetch(`${BASE}/a/${NEVER_SEEDED}/`);
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-security-policy")!, /default-src 'none'/);
    assert.doesNotMatch(res.headers.get("content-security-policy")!, /script-src/);
  });
});
```

- [ ] **Step 2: Run it and watch it pass — then break it on purpose**

Run: `node --import tsx --test src/server.test.ts`

Expected: **PASS**, because the policy is already strict. This test guards existing behaviour, so its value is proven by breaking it, not by watching it go red first.

Temporarily change `server.ts:150` to append `; script-src 'unsafe-inline'`. Re-run. Expected: **FAIL** on "an audit page must never authorise a script". Revert the change.

This is the standing rule applied to a guard test: a test that has never been observed failing is decoration.

- [ ] **Step 3: Create `src/marketing.ts` with the policy constants**

```ts
/**
 * Every surface that is not a rendered audit — the shell, the homepage, the
 * question flow — and the three Content-Security-Policy strings they need.
 *
 * ## Why the policies live here and not in server.ts
 *
 * Two of the three are derived from the stepper script, which lives in this
 * file. Putting them next to `send()` would mean server.ts importing the script
 * to hash it, and this file importing server.ts for the base policy — a cycle
 * to hold three strings. server.ts imports this; this imports nothing of
 * server.ts.
 */

import { createHash } from "node:crypto";

/**
 * What every response gets unless it asks for otherwise, unchanged from the
 * policy that has been on every response since the server shipped.
 *
 * `default-src 'none'` is doing the work: it denies scripts, fonts, frames,
 * connections and everything else not explicitly re-allowed. An audit page
 * quotes text captured from a stranger's site, so a `<script>` smuggled through
 * a finding must have nowhere to run. That is not loosened for anything.
 */
export const STRICT_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'";
```

- [ ] **Step 4: Give `send()` the seam**

In `src/server.ts`, add to the import from `./marketing.js` (create the import):

```ts
import { STRICT_CSP } from "./marketing.js";
```

Replace `send` (currently `server.ts:137-155`):

```ts
function send(
  res: ServerResponse,
  code: number,
  body: string,
  type = "text/html; charset=utf-8",
  extra: Record<string, string> = {},
  /**
   * Defaults to the strict policy on purpose. A route that needs more has to
   * say so at the call site, which means a route added later without thinking
   * about it is locked down rather than accidentally permissive.
   */
  csp = STRICT_CSP,
): void {
  res.writeHead(code, {
    ...extra,
    "content-type": type,
    "content-security-policy": csp,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
  });
  res.end(body);
}
```

Delete the old inline comment above the CSP line — it now lives on `STRICT_CSP` in `marketing.ts`.

- [ ] **Step 5: Run the suite**

Run: `npm run typecheck && npm test`
Expected: PASS, all existing tests unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/server.ts src/marketing.ts src/server.test.ts
git commit -m "send() takes a CSP, defaulting to the strict one

The policy on every response denies scripts and fonts. The stepped question
flow needs one script and the marketing pages need one font, and the audit
pages must keep denying both — they quote captured pages, and that header is
what stops a smuggled <script> running in a customer's browser.

So: a parameter that defaults to strict. A route added later without thinking
about it gets locked down rather than accidentally opened.

The header was previously untested — one occurrence in the repo, the line that
set it. Both new tests were watched failing with 'unsafe-inline' appended."
```

---

## Task 2: The static asset route and the font

**Files:**
- Create: `src/assets.ts`, `src/assets.test.ts`
- Create: `assets/inter.woff2`, `assets/inter-LICENSE.txt`
- Modify: `src/server.ts` (route)

**Interfaces:**
- Consumes: `send` from Task 1.
- Produces: `asset(name: string): { body: Buffer; type: string } | null` exported from `src/assets.ts`.

- [ ] **Step 1: Vendor the font**

Download Inter variable, latin subset, `woff2`. Place at `assets/inter.woff2`. Place the SIL Open Font License 1.1 text at `assets/inter-LICENSE.txt` — redistribution requires shipping it.

Verify it is a real woff2 and note its size:

```bash
file assets/inter.woff2 && ls -lh assets/inter.woff2
```

Expected: `Web Open Font Format (Version 2)`, well under 200K.

- [ ] **Step 2: Write the failing test**

Create `src/assets.test.ts`:

```ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { asset, ASSET_NAMES } from "./assets.js";

/**
 * The asset route, and the one property that matters about it.
 *
 * server.ts's header already says it "refuses any file it was not asked to
 * serve" — audit images are matched against an allowlist built from the audit
 * id rather than sanitised for `..`. This is the same rule for a second kind of
 * file, taken one step further: the files are read into memory at boot, so the
 * request path never reaches the filesystem at all. Traversal is not mitigated
 * here, it is unreachable.
 */

describe("the asset allowlist", () => {
  test("serves the font it was built with", () => {
    const got = asset("inter.woff2");
    assert.ok(got, "the font must be readable at boot");
    assert.equal(got.type, "font/woff2");
    assert.ok(got.body.length > 1000, "a woff2 that small is not a font");
  });

  test("a traversal attempt is just an unknown name", () => {
    for (const name of ["../.env", "../../etc/passwd", "/etc/passwd", "..%2f.env", ""]) {
      assert.equal(asset(name), null, name);
    }
  });

  test("an unknown name is null, not a guess", () => {
    assert.equal(asset("inter.woff"), null);
    assert.equal(asset("INTER.WOFF2"), null, "the lookup is exact, not case-folded");
  });

  test("the allowlist is a fixed set, not a directory listing", () => {
    assert.deepEqual(ASSET_NAMES, ["inter.woff2"]);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `node --import tsx --test src/assets.test.ts`
Expected: FAIL — `Cannot find module './assets.js'`.

- [ ] **Step 4: Write `src/assets.ts`**

```ts
/**
 * The handful of static files the marketing pages need, read once at boot.
 *
 * ## Why a map and not a directory
 *
 * The request path never touches the filesystem. `asset()` is a lookup in a
 * `Map` whose keys were fixed before the server accepted a connection, so there
 * is no path to join, nothing to normalise, and no `..` to strip. Directory
 * traversal is not defended against here — it has nowhere to happen.
 *
 * This is the same rule server.ts already applies to audit images, and it is
 * cheap enough at this size to be strictly better: the files are in memory, so
 * a request costs no I/O either.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "assets");

interface Asset {
  body: Buffer;
  type: string;
}

/**
 * Read eagerly. A missing font should stop the server at boot with a clear
 * error, not serve a broken page for a week and be noticed by a customer.
 */
const FILES: [name: string, type: string][] = [["inter.woff2", "font/woff2"]];

const TABLE = new Map<string, Asset>(
  FILES.map(([name, type]) => [name, { body: readFileSync(path.join(ROOT, name)), type }]),
);

/** In declaration order, so a test can assert the whole set. */
export const ASSET_NAMES: string[] = FILES.map(([name]) => name);

export function asset(name: string): Asset | null {
  return TABLE.get(name) ?? null;
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `node --import tsx --test src/assets.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 6: Add the route**

In `src/server.ts`, add the import:

```ts
import { asset } from "./assets.js";
```

In `handle()`, immediately after the `const parts = ...` line (`server.ts:454`), before the `/` route:

```ts
  // --- static assets -------------------------------------------------------
  /**
   * One year, immutable. The name is fixed and the bytes behind it never change
   * without a deploy, so re-validating it on every page view would be pure
   * round trip.
   */
  if (parts[0] === "s" && parts.length === 2) {
    const found = asset(parts[1]!);
    if (!found) return notFound(res);
    res.writeHead(200, {
      "content-type": found.type,
      "cache-control": "public, max-age=31536000, immutable",
      "content-security-policy": STRICT_CSP,
      "x-content-type-options": "nosniff",
    });
    return void res.end(found.body);
  }
```

Note this does not go through `send()` — `send` writes a string and sets a text content-type. A Buffer response with its own headers is clearer than a sixth branch inside `send`.

- [ ] **Step 7: Test the route over HTTP**

Add to `src/server.test.ts`:

```ts
describe("static assets", () => {
  test("the font is served, cached hard, and typed correctly", async () => {
    const res = await fetch(`${BASE}/s/inter.woff2`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("content-type"), "font/woff2");
    assert.match(res.headers.get("cache-control")!, /immutable/);
    assert.ok((await res.arrayBuffer()).byteLength > 1000);
  });

  test("anything not on the list is a 404, traversal included", async () => {
    for (const p of ["/s/.env", "/s/..%2F.env", "/s/nope.woff2", "/s/", "/s/a/b"]) {
      assert.equal((await fetch(`${BASE}${p}`)).status, 404, p);
    }
  });
});
```

Run: `npm test`
Expected: PASS.

- [ ] **Step 8: Watch the traversal test fail**

Temporarily replace the body of `asset()` with `return { body: readFileSync(path.join(ROOT, name)), type: "font/woff2" };`. Re-run `src/assets.test.ts`.
Expected: **FAIL** on the traversal case.
Revert.

- [ ] **Step 9: Commit**

```bash
git add src/assets.ts src/assets.test.ts src/server.ts src/server.test.ts assets/
git commit -m "Serve one font from an allowlist read at boot

The request path never reaches the filesystem — asset() is a Map lookup whose
keys were fixed before the server accepted a connection. Traversal is not
mitigated, it is unreachable. Same rule server.ts already applies to audit
images, one step further.

Inter is vendored rather than linked from a CDN. A CDN would hand a third party
the IP address of every reader, and audit pages are static HTML people open
weeks later, so a link there would be permanent. SIL OFL text ships with it.

The traversal test was watched failing against a path-joining implementation."
```

---

## Task 3: The shell — tokens, and `page()` moves

Restyles every non-audit surface at once: the status page, the 404, and the error pages all render through `page()`.

**Files:**
- Modify: `src/marketing.ts` (add), `src/server.ts:169-193` (delete `page`)
- Test: `src/server.test.ts`

**Interfaces:**
- Consumes: `STRICT_CSP` from Task 1, `/s/inter.woff2` from Task 2.
- Produces: `SHELL_CSS: string`, `page(title: string, body: string): string`, `MARKETING_CSP: string` — all exported from `src/marketing.ts`.

- [ ] **Step 1: Write the failing test**

```ts
describe("the shell", () => {
  test("a status page carries the new tokens and the self-hosted font", async () => {
    const res = await fetch(`${BASE}/r/${randomUUID()}`);
    const html = await res.text();
    assert.match(html, /--paper:\s*#FBFAF8/);
    assert.match(html, /--ink:\s*#26221E/);
    assert.match(html, /\/s\/inter\.woff2/);
    assert.doesNotMatch(html, /#E4572E/i, "the accent belongs to render.ts, not here");
    assert.match(res.headers.get("content-security-policy")!, /font-src 'self'/);
    assert.doesNotMatch(res.headers.get("content-security-policy")!, /script-src/);
  });
});
```

Note: `/r/<unknown-uuid>` 404s, which still renders through `page()`. That is the point — the shell is what is under test, not the route.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test src/server.test.ts`
Expected: FAIL — the old shell has `#fbfaf8` lowercase, no `--paper`, no font link, and the CSP has no `font-src`.

- [ ] **Step 3: Add the shell to `src/marketing.ts`**

```ts
/** The marketing surfaces need a font; they still run no script. */
export const MARKETING_CSP = `${STRICT_CSP}; font-src 'self'`;

/**
 * The token set, from `docs/specs/2026-08-20-homepage-design.md` §3.1.
 *
 * Every white here is warm. That is not a preference, it is the reference
 * board — plaster, limestone, bone — and pure white would be wrong against it.
 * `--paper` is the pre-existing `--bg`, which survived the redesign unchanged.
 *
 * There is deliberately **no accent**. `--accent:#E4572E` is alive and correct
 * in render.ts, where severity pins use it; on these pages the palette is
 * achromatic-warm end to end.
 *
 * Depth is tonal. Nothing on the reference board has a hard edge, so surfaces
 * are a lighter tone plus a soft shadow rather than a border, and form fields
 * are underlined rather than boxed.
 */
export const SHELL_CSS = `
  @font-face { font-family:Inter; src:url(/s/inter.woff2) format('woff2');
               font-weight:300 600; font-display:swap; font-style:normal; }
  :root { --paper:#FBFAF8; --bone:#F2EFE9; --plaster:#EAE5DC; --sand:#DDD6C9;
          --shade:#C9C0B2; --sage:#D6D8D0; --ink:#26221E; --ink-soft:#6E665C; }
  * { box-sizing:border-box; }
  body { margin:0; background:var(--paper); color:var(--ink);
         font:400 16px/1.65 Inter,-apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif;
         -webkit-font-smoothing:antialiased; }
  a { color:var(--ink); text-decoration-color:var(--shade); text-underline-offset:3px; }
  .wrap { max-width:640px; margin:0 auto; padding:96px 28px; }
  h1 { font-size:38px; font-weight:300; letter-spacing:-.02em; line-height:1.18; margin:0 0 18px; }
  .lead { font-size:17px; margin:0 0 18px; }
  .hint { color:var(--ink-soft); font-size:14px; margin:8px 0 24px; }
  .err  { color:#8C3A22; font-size:15px; margin:0 0 18px; }
  code { background:var(--plaster); padding:2px 6px; border-radius:4px; font-size:14px; }
  .btn { display:inline-block; font:500 15px Inter,sans-serif; letter-spacing:-.01em;
         background:var(--ink); color:var(--paper); border:0; border-radius:100px;
         padding:15px 32px; cursor:pointer; text-decoration:none; }
`;

/** The frame for every page that is not a rendered audit. */
export function page(title: string, body: string, extraCss = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — The Usability Lab</title>
<style>${SHELL_CSS}${extraCss}</style></head>
<body><div class="wrap"><h1>${title}</h1>${body}</div></body></html>`;
}
```

`title` is interpolated unescaped exactly as it was before this change — every caller passes a literal. Do not start passing visitor text to it.

- [ ] **Step 4: Delete `page()` from `server.ts` and import it**

Delete `server.ts:168-193` entirely. Extend the marketing import:

```ts
import { STRICT_CSP, MARKETING_CSP, page } from "./marketing.js";
```

Change `notFound` and the status/error routes to pass `MARKETING_CSP`:

```ts
function notFound(res: ServerResponse): void {
  send(res, 404, page("Not found", `<p>No audit at this address.</p>`), "text/html; charset=utf-8", {}, MARKETING_CSP);
}
```

Do the same at every `send(res, …, page(…))` call site. Leave every `send(res, …, publicHtml(…))` call alone — audit pages keep the strict default.

- [ ] **Step 5: Run the tests**

Run: `npm run typecheck && npm test`
Expected: PASS. The new shell test now passes; the two `/` tests still pass because `/` still renders the old form through the new shell.

- [ ] **Step 6: Commit**

```bash
git add src/marketing.ts src/server.ts src/server.test.ts
git commit -m "Move page() into marketing.ts and give it the new tokens

Every non-audit surface at once — status page, 404, error pages. The audit
pages are untouched, which is Kelly's call and also what keeps this safe:
published pages are static HTML written at publish time, so nothing a customer
has already read can change underneath them.

--paper is the pre-existing --bg, unchanged. The reference board has no pure
white on it anywhere. There is no accent here at all; #E4572E stays in
render.ts where the severity pins need it."
```

---

## Task 4: The homepage

**Files:**
- Modify: `src/marketing.ts` (add `homePage`), `src/server.ts` (`/` route)
- Create: `src/marketing.test.ts`
- Modify: `src/server.test.ts`

**Interfaces:**
- Consumes: `page`, `SHELL_CSS`, `MARKETING_CSP` from Task 3.
- Produces: `homePage(): string`, `publisherCounts(): { publisher: string; n: number }[]` — exported from `src/marketing.ts`.

- [ ] **Step 1: Write the failing test for the derived numbers**

Create `src/marketing.test.ts`:

```ts
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { publisherCounts, homePage } from "./marketing.js";
import { SOURCES } from "./sources.js";
import { PRICE_USD } from "./render.js";
import { SITE_LIMIT, AUDITS_PER_MONTH } from "./fairuse.js";

/**
 * The two places on the homepage where a stale number would be worse than no
 * number at all.
 *
 * `sources.ts` went 15 -> 22 -> 28 rows in a single day on 2026-08-19. A page
 * that brags about citing its sources, printing a count that stopped being true
 * a week ago, is the exact failure the product exists to find in other people's
 * sites.
 */

describe("the homepage's numbers are read, not typed", () => {
  test("publisher counts add up to the whole table", () => {
    assert.equal(
      publisherCounts().reduce((n, p) => n + p.n, 0),
      SOURCES.length,
      "every source belongs to exactly one publisher",
    );
  });

  test("counts are ordered largest first", () => {
    const ns = publisherCounts().map((p) => p.n);
    assert.deepEqual(ns, [...ns].sort((a, b) => b - a));
  });

  test("adding a source to the table changes the page", () => {
    // Not a mock — the real table, asserted against the real render. If someone
    // hardcodes "15" this fails the day the table moves.
    const html = homePage();
    for (const { publisher, n } of publisherCounts()) {
      assert.match(html, new RegExp(`>${n}<`), `${publisher} count`);
    }
    assert.match(html, new RegExp(`${SOURCES.length}`), "the total");
  });

  test("money and limits come from the constants that define them", () => {
    const html = homePage();
    assert.match(html, new RegExp(`\\$${PRICE_USD}`));
    assert.match(html, new RegExp(`${SITE_LIMIT} sites`));
    assert.match(html, new RegExp(`${AUDITS_PER_MONTH} re-audits`));
  });

  test("the first audit is described as free", () => {
    // The audit costs nothing; $29 is monitoring. A page that implied otherwise
    // would carry the only false claim on it.
    assert.match(homePage(), /Free/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test src/marketing.test.ts`
Expected: FAIL — `publisherCounts` and `homePage` are not exported.

- [ ] **Step 3: Implement in `src/marketing.ts`**

```ts
import { SOURCES } from "./sources.js";
import { PRICE_USD } from "./render.js";
import { SITE_LIMIT, AUDITS_PER_MONTH } from "./fairuse.js";

/**
 * How many sources each publisher contributes, largest first.
 *
 * Derived rather than written down, and the reason is on the record: the table
 * went from 15 rows to 28 in one day. A hardcoded "15" on the page that claims
 * we cite our sources would be a false claim about honesty, which is the worst
 * kind this product can print.
 */
export function publisherCounts(): { publisher: string; n: number }[] {
  const counts = new Map<string, number>();
  for (const s of SOURCES) counts.set(s.publisher, (counts.get(s.publisher) ?? 0) + 1);
  return [...counts]
    .map(([publisher, n]) => ({ publisher, n }))
    .sort((a, b) => b.n - a.n || a.publisher.localeCompare(b.publisher));
}
```

Then `homePage()`. Port the markup and CSS from `docs/specs/2026-08-20-homepage-mockups/homepage.html` — that file is the approved design, scoped under `.ul`; strip the wrapper class and use the shell's tokens. Structure, in order:

1. `<section class="hero">` — four drifting `.blob` forms, brandmark, `h1` *"A design critique of your site, backed by research"*, sub *"Five questions to shape your critique. Under ten minutes. Real screenshots of your site."*, `<a class="btn" href="/start">Get started</a>`, scroll cue anchored to `#what`.
2. `<section id="what">` — eyebrow *What we do*, the lead paragraph.
3. `<section>` — eyebrow *Where the research comes from*, the lead *"Every finding points at a source, or says plainly that it couldn't find one."*, then `publisherCounts()` rendered as columns, then `${SOURCES.length}` in the aside.
4. `<section>` — eyebrow *See one*, and the sample-audit card **with its placeholder label intact** (see Task 4 note below).
5. `<footer>` — *One page. Five questions.*, the two-row price table built from `PRICE_USD`, the `btn`, and fine print built from `SITE_LIMIT` and `AUDITS_PER_MONTH`.

The hero background CSS, verbatim from the approved mockup, including:

```css
  @media (prefers-reduced-motion: reduce) { .blob { animation:none !important; } }
```

Not optional. The page must render one still frame for anyone who has asked their machine to stop moving things.

**On the sample audit:** ship the placeholder card exactly as the mockup has it, *including the visible line saying the finding is invented.* It becomes real in Task 7. Do not quietly present a fabricated finding as a real one on the page selling evidence.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test src/marketing.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Replace the `/` route**

In `server.ts`, replace the whole `if (url.pathname === "/")` block (`server.ts:457-470`):

```ts
  if (url.pathname === "/") {
    events.record({ audit_id: null, type: "home.viewed", data: {} });
    return send(res, 200, homePage(), "text/html; charset=utf-8", {}, MARKETING_CSP);
  }
```

Add `homePage` to the marketing import.

- [ ] **Step 6: Move the two existing `/` tests to `/start` and add the event test**

In `src/server.test.ts`, change `server.test.ts:965` and `:973` to fetch `${BASE}/start` instead of `${BASE}/`. Rename the first to `"the question flow asks the same five questions the CLI does"`. Then add:

```ts
  test("the homepage has no form on it at all", async () => {
    const html = await (await fetch(`${BASE}/`)).text();
    assert.doesNotMatch(html, /<form/i, "the form moved to /start");
    assert.match(html, /href="\/start"/);
  });

  test("the homepage records a view, not a form open", async () => {
    await fetch(`${BASE}/`);
    const events = new EventLog(dbPath);
    const all = events.all();
    events.close();
    const home = all.filter((e) => e.type === "home.viewed");
    assert.ok(home.length > 0, "a homepage view is its own event");
    assert.deepEqual(Object.keys(home[home.length - 1]!.data), [], "no content in a permanent log");
  });
```

The homepage still must list no audits — `server.test.ts:972` keeps guarding that, now against `/start`; add the same assertion for `/` in the no-form test if it is not already covered.

- [ ] **Step 7: Run everything**

Run: `npm run typecheck && npm test`
Expected: the two moved tests FAIL, because `/start` does not exist yet. That is correct and Task 5 fixes it. Everything else passes.

If you would rather not leave the suite red between tasks, do Steps 6–7 at the top of Task 5 instead. Do not "fix" it by pointing the tests back at `/`.

- [ ] **Step 8: Commit**

```bash
git add src/marketing.ts src/marketing.test.ts src/server.ts src/server.test.ts
git commit -m "The homepage

A scrolling page instead of a bare form. Four blurred gradients drift behind
the headline, frozen entirely under prefers-reduced-motion — which is the whole
reason this is CSS and not the 50,000-particle Three.js component that started
the conversation. That one had no measurable contrast ratio, ignored
reduced-motion, and never settled, so our own capture pipeline would have seen
a different homepage every run.

Publisher counts and every price figure are derived from sources.ts, render.ts
and fairuse.ts. sources.ts went 15 -> 22 -> 28 in one day this week; a
hardcoded count on the page that claims we cite our sources is a false claim
about honesty.

The sample-audit card ships with its placeholder label visible. It becomes real
when we audit this page with our own pipeline."
```

---

## Task 5: The stepped question flow at `/start`

**Files:**
- Modify: `src/marketing.ts` (add `questionsPage`, `STEPPER_JS`, `STEPPED_CSP`), `src/server.ts`
- Modify: `src/marketing.test.ts`, `src/server.test.ts`

**Interfaces:**
- Consumes: everything above.
- Produces: `questionsPage(state?: { url?: string; answers?: Answers; error?: string }): string`, `STEPPER_JS: string`, `STEPPED_CSP: string`.

- [ ] **Step 1: Write the failing test — the no-JS guarantee**

This is the load-bearing test in the whole plan. Add to `src/marketing.test.ts`:

```ts
import { questionsPage, STEPPER_JS, STEPPED_CSP } from "./marketing.js";
import { QUESTIONS } from "./profile.js";
import { createHash } from "node:crypto";

describe("the stepped flow degrades to the form it replaced", () => {
  test("all six fields are in the HTML before a line of script runs", () => {
    // The whole architecture in one assertion. The stepper hides five of these;
    // it does not fetch them. If someone later 'optimises' this by rendering one
    // step server-side, the page stops working without JavaScript and this test
    // is what says so.
    const html = questionsPage();
    assert.match(html, /name="url"/);
    for (const [i] of QUESTIONS.entries()) {
      assert.match(html, new RegExp(`name="q${i}"`), `q${i} must be present at first byte`);
    }
  });

  test("every question's text is in the markup, not built by script", () => {
    const html = questionsPage();
    for (const q of QUESTIONS) {
      const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/'/g, "&#39;");
      assert.match(html, new RegExp(escaped), q);
    }
  });

  test("there is exactly one form and it posts to /request", () => {
    const html = questionsPage();
    assert.equal(html.match(/<form/g)?.length, 1, "one submit, not one per step");
    assert.match(html, /action="\/request"/);
    assert.match(html, /method="post"/i);
  });

  test("typed answers are echoed back escaped", () => {
    const html = questionsPage({
      url: `"><script>alert(1)</script>`,
      answers: { [QUESTIONS[0]!]: `<img src=x onerror=1>` },
      error: "nope",
    });
    assert.doesNotMatch(html, /<script>alert/);
    assert.doesNotMatch(html, /<img src=x/);
    assert.match(html, /&lt;img src=x/);
  });

  test("the CSP authorises exactly the script on the page", () => {
    const digest = createHash("sha256").update(STEPPER_JS, "utf8").digest("base64");
    assert.match(STEPPED_CSP, new RegExp(`'sha256-${digest.replace(/[+/=]/g, "\\$&")}'`));
    assert.doesNotMatch(STEPPED_CSP, /unsafe-inline'[^;]*script|script-src[^;]*unsafe-inline/);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test src/marketing.test.ts`
Expected: FAIL — `questionsPage` is not exported.

- [ ] **Step 3: Add the stepper and the page to `src/marketing.ts`**

```ts
import { QUESTIONS, type Answers } from "./profile.js";
import { escapeHtml } from "./render.js";

/** Matches server.ts's per-answer cap. */
const MAX_ANSWER = 1000;

/**
 * The stepper. Six steps, one submit, and it hides fields rather than fetching
 * them.
 *
 * Every field is already in the DOM when this runs — that is the design, not an
 * implementation detail. With JavaScript off, all six simply show, which is the
 * form this page replaced, posting to the handler that has always been behind
 * it. So there is no server-side step state, nothing half-finished is stored,
 * and `/request` did not change.
 *
 * `data-error-step` lets the server say which step to open on when it re-renders
 * after a refusal, so a rejected URL does not leave someone on step 6.
 */
export const STEPPER_JS = `
(function () {
  var form = document.getElementById('flow');
  if (!form) return;
  var steps = Array.prototype.slice.call(form.querySelectorAll('.step'));
  if (steps.length < 2) return;
  var segs = Array.prototype.slice.call(document.querySelectorAll('.seg'));
  var count = document.getElementById('count');
  var back = document.getElementById('back');
  var skip = document.getElementById('skip');
  var next = document.getElementById('next');
  var submit = document.getElementById('submit');
  var i = Number(form.getAttribute('data-error-step') || 0);

  form.classList.add('stepped');
  function draw() {
    steps.forEach(function (s, n) { s.hidden = n !== i; });
    segs.forEach(function (s, n) { s.className = 'seg' + (n <= i ? ' done' : ''); });
    count.textContent = 'Step ' + (i + 1) + ' of ' + steps.length;
    back.hidden = i === 0;
    skip.hidden = i === 0;
    next.hidden = i === steps.length - 1;
    submit.hidden = i !== steps.length - 1;
    var field = steps[i].querySelector('input, textarea');
    if (field) field.focus();
  }
  function go(n) { i = Math.max(0, Math.min(steps.length - 1, n)); draw(); }

  next.addEventListener('click', function (e) { e.preventDefault(); go(i + 1); });
  back.addEventListener('click', function (e) { e.preventDefault(); go(i - 1); });
  skip.addEventListener('click', function (e) {
    e.preventDefault();
    var field = steps[i].querySelector('input, textarea');
    if (field) field.value = '';
    go(i + 1);
  });
  form.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' || e.shiftKey) return;
    if (i === steps.length - 1) return;
    e.preventDefault();
    go(i + 1);
  });
  draw();
})();
`;

/**
 * The policy for the one page that runs a script, naming that script by hash.
 *
 * A hash and not `'unsafe-inline'`, which would hand back everything the header
 * exists to prevent. A hash and not a nonce, because the script is a fixed
 * string we own — so the digest is computed from the script itself and the
 * policy cannot drift out of sync with the code it authorises.
 */
export const STEPPED_CSP =
  `${MARKETING_CSP}; script-src 'sha256-` +
  createHash("sha256").update(STEPPER_JS, "utf8").digest("base64") +
  `'`;
```

Then `questionsPage(state)`. Port markup and CSS from `docs/specs/2026-08-20-homepage-mockups/questions.html`. Requirements the mockup encodes:

- A single `<form id="flow" method="post" action="/request">`.
- Step 0 is the URL: `<input id="url" name="url" type="url" required inputmode="url">`, help text *"One page, not a whole site. We stop at any login wall."*, no Skip.
- Steps 1–5 are `QUESTIONS` in order as `<textarea name="q${i}" maxlength="${MAX_ANSWER}" rows="2">`, each with its help line. Question 2's help text is *"Lead with the thing that actually bothers you. It decides which reviewers we put on the page."* — true, and it is why the answers matter.
- Every `.step` is a plain block. **Do not set `hidden` server-side.** The script adds `.stepped` and hides them; without the script they all show.
- Six `.seg` progress segments, `#count`, `#back`, `#skip`, `#next`, `#submit`.
- `#submit` reads *"Ask for the audit"*.
- `<script>${STEPPER_JS}</script>` at the end of `<body>`.
- `state.error` renders into `.err`; `state.url` and `state.answers` echo back through `escapeHtml`; `data-error-step` is `"0"` for a URL refusal and otherwise omitted.

Buttons `#back`, `#skip`, `#next` must be `type="button"` so they never submit the form when the script has not loaded.

- [ ] **Step 4: Run the test to verify it passes**

Run: `node --import tsx --test src/marketing.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the route and wire the error path**

In `server.ts`, add `/start` immediately after the `/` route:

```ts
  if (url.pathname === "/start") {
    // Unchanged event type on purpose: this is still "the form was opened", so
    // the series stays comparable across the redesign. What moved is the URL,
    // not the meaning.
    events.record({ audit_id: null, type: "question.started", data: {} });
    return send(res, 200, questionsPage(), "text/html; charset=utf-8", {}, STEPPED_CSP);
  }
```

In the `/request` handler, replace the two `page(... questionForm(...))` renders. At `server.ts:477`:

```ts
      return send(res, 413, questionsPage({ error: "That was more than we can take in one go." }),
                  "text/html; charset=utf-8", {}, STEPPED_CSP);
```

And `again` at `server.ts:486`:

```ts
    const again = (error: string, code = 400) =>
      send(res, code, questionsPage({ url: typed, answers, error }),
           "text/html; charset=utf-8", {}, STEPPED_CSP);
```

Delete `questionForm` from `server.ts` (`server.ts:280-299`) — `questionsPage` replaces it. Remove the now-unused `QUESTIONS` import if nothing else in `server.ts` uses it.

- [ ] **Step 6: Add the HTTP-level tests**

```ts
  test("/start records the form being opened, and / does not", async () => {
    const before = (() => {
      const e = new EventLog(dbPath); const n = e.all().filter((x) => x.type === "question.started").length; e.close(); return n;
    })();
    await fetch(`${BASE}/`);
    const afterHome = (() => {
      const e = new EventLog(dbPath); const n = e.all().filter((x) => x.type === "question.started").length; e.close(); return n;
    })();
    assert.equal(afterHome, before, "a homepage view is not a form open");
    await fetch(`${BASE}/start`);
    const afterStart = (() => {
      const e = new EventLog(dbPath); const n = e.all().filter((x) => x.type === "question.started").length; e.close(); return n;
    })();
    assert.equal(afterStart, before + 1);
  });

  test("a refusal re-renders the flow with the answers still in it", async () => {
    const res = await submit({ url: "javascript:alert(1)", q0: "A shop that sells rope" });
    assert.equal(res.status, 400);
    const html = await res.text();
    assert.match(html, /A shop that sells rope/, "nobody retypes five answers over a bad URL");
    assert.match(html, /name="q4"/, "the whole flow comes back, not one step");
    assert.match(html, /data-error-step="0"/, "and it opens on the field that was wrong");
  });

  test("the flow page authorises its script by hash and nothing else", async () => {
    const csp = (await fetch(`${BASE}/start`)).headers.get("content-security-policy")!;
    assert.match(csp, /script-src 'sha256-/);
    assert.doesNotMatch(csp, /unsafe-inline'[^;]*script/);
    assert.match(csp, /font-src 'self'/);
  });
```

- [ ] **Step 7: Run everything**

Run: `npm run typecheck && npm test`
Expected: PASS, including the two tests moved in Task 4.

- [ ] **Step 8: Watch the no-JS test fail**

In `questionsPage`, temporarily add `hidden` to every `.step` except the first. Re-run `src/marketing.test.ts`.
Expected: the fields are still present so the name assertions pass — **which means the test is too weak.** Strengthen it: assert that no `.step` carries a `hidden` attribute in the server-rendered HTML.

```ts
  test("no step is hidden before the script runs", () => {
    assert.doesNotMatch(questionsPage(), /class="step"[^>]*hidden/);
  });
```

Re-run with the `hidden` attribute still in place. Expected: **FAIL**. Revert, re-run, expect PASS.

This step is the reason the rule exists. The obvious version of this test passes against a broken implementation.

- [ ] **Step 9: Verify by hand, with JavaScript off**

```bash
npm run serve
```

Open `http://localhost:4000/start`, disable JavaScript in devtools, reload. Expected: all six fields visible, submit works, redirect to `/r/<id>`. Re-enable, reload, expect the stepper.

- [ ] **Step 10: Commit**

```bash
git add src/marketing.ts src/marketing.test.ts src/server.ts src/server.test.ts
git commit -m "The five questions, one at a time, at /start

All six fields are in the HTML from the first byte; the script hides five of
them. So there is no server-side step state, nothing half-finished is stored,
no new endpoint, and /request is byte-for-byte the handler it was. With
JavaScript off the fields simply show, which is the form this replaces.

question.started moves from GET / to GET /start and keeps its name, because it
keeps its meaning — the form was opened. The historical series stays
comparable; only the URL moved.

Skip is a real button. Every answer is optional in profile.ts, and a stepper
that hides its exit pressures people into filling boxes with noise — which is
worse than blank, because concerns[0] decides which specialists get hired when
more spawn rules fire than the cap allows.

The first version of the no-JS test passed against an implementation that
hid five steps server-side. Strengthened until it failed."
```

---

## Task 6: The funnel keeps its meaning

**Files:**
- Modify: `src/funnel.ts:213-217`
- Test: `src/funnel.test.ts`

**Interfaces:**
- Consumes: the `home.viewed` event from Task 4.
- Produces: nothing other tasks read.

- [ ] **Step 1: Write the failing test**

Add to `src/funnel.test.ts`:

```ts
test("a homepage view and a form open are counted apart", () => {
  /**
   * Before /start existed, `question.started` fired on GET / and the dashboard
   * printed it as "form opened" — true, because / was the form. The moment /
   * became a marketing page that label would have counted homepage views, and
   * the ratio between it and "questions answered" — the form's completion rate
   * — would have silently become a whole-site conversion rate, printed to the
   * same precision as before.
   */
  const counts = countsByType([
    { type: "home.viewed" }, { type: "home.viewed" }, { type: "home.viewed" },
    { type: "question.started" },
    { type: "question.completed" },
  ]);
  assert.equal(counts.get("home.viewed"), 3);
  assert.equal(counts.get("question.started"), 1);
});
```

If `funnel.ts` has no exported counting helper, extract one rather than testing `main()`:

```ts
export function countsByType(events: { type: string }[]): Map<string, number> {
  const byType = new Map<string, number>();
  for (const e of events) byType.set(e.type, (byType.get(e.type) ?? 0) + 1);
  return byType;
}
```

and have `main()` call it. This is the same move `corpus.ts` got when the arithmetic came out of `outcome.ts`: a top-level script has no tests, which is why that bug lived for days.

- [ ] **Step 2: Run it to verify it fails**

Run: `node --import tsx --test src/funnel.test.ts`
Expected: FAIL — `countsByType` is not exported.

- [ ] **Step 3: Add the row**

In `funnel.ts`, replace the first line of the visits block (`funnel.ts:215`):

```ts
      `  homepage viewed        ${String(byType.get("home.viewed") ?? 0).padStart(4)}   visits, not audits`,
      `  form opened            ${String(byType.get("question.started") ?? 0).padStart(4)}   visits, not audits`,
      `  questions answered     ${String(byType.get("question.completed") ?? 0).padStart(4)}   requests queued`,
```

Extend the block comment above it to record that `form opened` now means `/start`, and that the name was kept precisely so the series spans the redesign.

- [ ] **Step 4: Run the tests**

Run: `npm run typecheck && npm test`
Expected: PASS.

- [ ] **Step 5: Look at it**

```bash
npm run funnel
```

Expected: `homepage viewed` appears above `form opened`. Both are honest for the current data — historical `question.started` rows meant "form opened" then and still do.

- [ ] **Step 6: Commit**

```bash
git add src/funnel.ts src/funnel.test.ts
git commit -m "Count homepage views apart from form opens

'form opened' was question.started, which fired on GET /. That was true while /
was the form. It stopped being true this week, and the number would have kept
printing to the same precision while measuring a different population — the
same shape as the 85%-uncited figure.

The counting came out of main() and into a tested function for the same reason
the corpus arithmetic left outcome.ts: a top-level script has no tests, which
is how that one lived for days."
```

---

## Task 7: Audit our own homepage

The spec's §5.4 and §10. This is the task that turns the placeholder card into the thing the section promises, and it is the reason the sample-audit slot exists at all.

**Files:**
- Modify: `src/marketing.ts` (the sample card's content)

- [ ] **Step 1: Serve the page somewhere the capture can reach**

```bash
npm run serve
```

- [ ] **Step 2: Run the pipeline against it**

```bash
npm run audit -- --url http://127.0.0.1:4000/
```

If `urlcheck.ts` refuses a loopback address — it should, that is the SSRF guard doing its job and `server.test.ts:980` asserts it — then deploy the page first and audit the public URL. **Do not weaken `urlcheck.ts` to make this convenient.**

- [ ] **Step 3: Read every finding**

Not a formality. Fix what is real. A usability lab whose own front door has a finding it chose to ignore is worse off than one that never ran the audit.

- [ ] **Step 4: Replace the placeholder**

Put one real finding into the sample card — heuristic, severity, observation, resolved citation, annotated thumbnail. Delete the line saying it is invented.

- [ ] **Step 5: Commit**

```bash
git add src/marketing.ts
git commit -m "The sample audit is our own page, audited by our own pipeline

Ten sites through the pipeline; the tenth is ours. All nine published audits
are of named third parties, and putting someone else's critique on our
marketing page as an advertisement is not the same act as giving them a private
link to it.

The placeholder label is gone because the finding is real."
```

---

## Self-Review

**Spec coverage.** §3 tokens → Task 3. §3.4 drifting forms and reduced-motion → Task 4. §4 routes → Tasks 2, 4, 5. §5.1–5.5 homepage → Task 4. §6.1–6.2 assets and font → Task 2. §6.3 CSP → Task 1, enforced again in Task 5. §7 funnel → Tasks 4 and 6. §8 question flow → Task 5. §9 tests → distributed, every row covered. §10 sequencing → Task 7.

**Gaps found and closed while reviewing:**

- §11's **mobile** open question has no task. It is a review activity, not a deliverable, and it is listed below rather than faked as a step.
- §7's note that `GET /` writes an unbounded permanent event row per crawler hit is explicitly out of scope in the spec. Still true, still unaddressed, belongs in `backlog.md`.

**Type consistency.** `asset()` returns `{ body: Buffer; type: string } | null` in Task 2 and is consumed that way in the route. `publisherCounts()` returns `{ publisher, n }[]` in Task 4 and is read that way in both the test and the render. `questionsPage(state?)` takes the same shape `questionForm` took, so the two `/request` call sites port directly. `STEPPER_JS` is hashed in exactly one place and that place is asserted in Task 5 Step 1.

---

## Before calling this done

- [ ] `npm run check` (typecheck + tests + snapshot) passes.
- [ ] The page is looked at on a phone, or at 375px. §11 flags this as reviewed at desktop width only.
- [ ] `/start` submits with JavaScript disabled.
- [ ] `prefers-reduced-motion: reduce` set at the OS level renders a still hero.
- [ ] A backlog entry exists for unbounded `home.viewed` rows from crawlers.
- [ ] `npm run funnel` reads honestly against real data.
