/**
 * `npm run sources:check` — does every citation still resolve?
 *
 * CLAUDE.md: *"Every finding needs an evidence pointer; every citation resolves
 * or `source_type: none`."* Half of that is enforced by construction. A model
 * never writes a URL — it names a source id and `resolveCitation` reads the URL
 * out of `SOURCES`, so a citation cannot be invented (`sources.test.ts` holds
 * that line, hermetically, on every run).
 *
 * The other half was enforced by nothing. The table's URLs are ordinary links
 * to nngroup.com, lawsofux.com, baymard.com and w3.org, and links rot. The
 * failure is silent and slow: a finding keeps its `source_type: paper`, the
 * results page keeps rendering a link, and the link 404s for the customer we
 * asked to trust us because we cite our work. **A dead citation is worse than
 * no citation**, because `source_type: none` is honest and a broken link looks
 * like evidence.
 *
 * ## Why this is a command and not a test
 *
 * `npm test` is hermetic and takes five seconds. Putting 28 network calls in it
 * would make a green suite depend on nngroup.com's uptime and on whoever runs
 * it having wifi — so a red suite would stop meaning "the code is wrong". Same
 * reasoning that keeps `npm run redteam` out of the suite while
 * `src/injection.test.ts` stays in it: the hermetic assertions run always, the
 * ones that reach the network run when asked.
 *
 * ## What counts as broken
 *
 * A non-2xx status, or no answer at all. A redirect is reported but not failed:
 * following one is what a reader's browser does too, and the interesting case is
 * a *permanent* move, which means the table has drifted from where the article
 * actually lives and should be updated before it becomes a 404.
 *
 * First run, 2026-08-21: **28 of 28 resolved, no redirects.** So this starts by
 * confirming the invariant rather than finding a breach — which is the point.
 * A checker written the day something breaks has no baseline to compare against.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SOURCES } from "./sources.js";

const TIMEOUT_MS = 20_000;

/** A browsable user agent. Several publishers refuse an unidentified client outright. */
const UA = "Mozilla/5.0 (compatible; UsabilityLab-linkcheck/1.0)";

interface Result {
  id: string;
  url: string;
  /** HTTP status, or 0 when nothing answered. */
  status: number;
  /** Where it ended up, when that differs from where we pointed. */
  movedTo: string | null;
  error: string | null;
  ms: number;
}

/** Trailing slashes are not a move. Everything else is. */
const same = (a: string, b: string): boolean => a.replace(/\/$/, "") === b.replace(/\/$/, "");

export async function checkOne(source: { id: string; url: string }): Promise<Result> {
  const started = Date.now();
  try {
    const res = await fetch(source.url, {
      redirect: "follow",
      headers: { "user-agent": UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    // The body is never read. We are asking whether the page is there, and
    // pulling ~28 full articles to answer that would be rude and slow.
    await res.body?.cancel();
    return {
      id: source.id,
      url: source.url,
      status: res.status,
      movedTo: same(res.url, source.url) ? null : res.url,
      error: null,
      ms: Date.now() - started,
    };
  } catch (err) {
    return {
      id: source.id,
      url: source.url,
      status: 0,
      movedTo: null,
      error: err instanceof Error ? err.message : String(err),
      ms: Date.now() - started,
    };
  }
}

export const isBroken = (r: Result): boolean => r.status < 200 || r.status >= 300;

/** The exit-code decision, separated so it can be asserted without a network. */
export function summarize(results: Result[]): { broken: Result[]; moved: Result[] } {
  return {
    broken: results.filter(isBroken),
    moved: results.filter((r) => !isBroken(r) && r.movedTo !== null),
  };
}

async function main(): Promise<void> {
  console.log(`\nSOURCES — ${SOURCES.length} citations, real requests\n`);

  const results = await Promise.all(SOURCES.map(checkOne));
  const { broken, moved } = summarize(results);

  for (const r of results) {
    const mark = isBroken(r) ? "BROKEN" : r.movedTo ? "moved " : "ok    ";
    console.log(
      `  ${mark} ${String(r.status || "---").padStart(3)}  ${r.id.padEnd(32)} ${
        r.error ?? (r.movedTo ? `-> ${r.movedTo}` : "")
      }`,
    );
  }

  console.log(`\n  ${results.length - broken.length} of ${results.length} resolve`);

  if (moved.length > 0) {
    console.log(
      `\n  ${moved.length} redirect${moved.length === 1 ? "" : "s"}. Not a failure — a browser` +
        ` follows them too — but\n  a permanent move means the table has drifted from where the` +
        ` article lives.\n  Worth updating before it becomes a 404.`,
    );
  }

  if (broken.length > 0) {
    console.log(
      `\n  ${broken.length} citation${broken.length === 1 ? " does" : "s do"} not resolve.` +
        ` Findings citing ${broken.length === 1 ? "it" : "them"} are\n` +
        `  showing a customer a link that 404s, which is worse than citing nothing.\n` +
        `  Fix the URL in src/sources.ts, or drop the row and let those findings\n` +
        `  fall back to source_type: none.\n`,
    );
    process.exitCode = 1;
    return;
  }
  console.log(``);
}

// Only when run as a command. `summarize` and `isBroken` are imported by the
// test file, and importing this module must not fire 28 requests at nngroup.com.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
