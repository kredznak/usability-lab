import { writeFileSync, mkdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { capture } from "./capture.js";

/**
 * Refreshes fixtures/captures/*.json — docs/design.md §10 wants eval fixtures to
 * be "saved captures of real sites (frozen, so evals are hermetic)". Frozen is
 * the point: the trajectory suite must not depend on what stripe.com shipped
 * this morning. This script is the only thing that unfreezes them, and its diff
 * is the record of what changed.
 *
 *   npm run fixtures            # refresh all
 *   npm run fixtures -- hn      # refresh one
 *
 * The set is chosen so every spawn rule has both a firing and a non-firing case:
 * a dense link index with no real form, a long marketing page, a pricing page,
 * a genuine login form, a text-heavy article, and a plain government page.
 */

const SITES: Record<string, string> = {
  govuk: "https://www.gov.uk",
  stripe: "https://stripe.com",
  stripe_pricing: "https://stripe.com/pricing",
  hn: "https://news.ycombinator.com",
  wikipedia: "https://en.wikipedia.org/wiki/List_of_common_misconceptions",
  // Two synthetic pages, served from disk. Real signup and checkout pages sit
  // behind robots.txt disallows (HN's /login is one), and more importantly a
  // fixture we author is the only way to get a clean firing/non-firing pair for
  // the accessibility signal — see the comments in each file.
  signup: pageUrl("signup.html"),
  checkout: pageUrl("checkout.html"),
};

function pageUrl(file: string): string {
  return pathToFileURL(path.resolve("fixtures/pages", file)).href;
}

const OUT = "fixtures/captures";
const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
const wanted = only.length > 0 ? only : Object.keys(SITES);

mkdirSync(OUT, { recursive: true });
let failed = 0;

for (const name of wanted) {
  const url = SITES[name];
  if (!url) {
    console.error(`unknown fixture '${name}'. known: ${Object.keys(SITES).join(", ")}`);
    failed++;
    continue;
  }
  try {
    // A fixed audit_id keeps the fixture diff to real capture changes instead of
    // a fresh UUID on every refresh.
    const result = await capture(url, `fixture-${name}`, path.join("out", `fixture-${name}`));
    // captured_at would churn the diff on every run for no information.
    const frozen = { ...result, captured_at: "frozen" };
    writeFileSync(path.join(OUT, `${name}.json`), JSON.stringify(frozen, null, 2) + "\n");
    console.log(
      `${name.padEnd(15)} ${result.elements.length}/${result.elements_total} elements, ` +
        `${Math.round(result.full_height)}px, ${result.text_total_chars} chars`,
    );
  } catch (err) {
    console.error(`${name.padEnd(15)} FAILED: ${err instanceof Error ? err.message : err}`);
    failed++;
  }
}

if (failed > 0) process.exitCode = 1;
