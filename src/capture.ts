import { chromium, type Browser, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { Capture, type CapturedElement } from "./types.js";

/**
 * page-inspector — docs/design.md §5. Deterministic code, zero tokens.
 *
 * Contract for slice 1: one URL in, one Capture out, with element boxes measured
 * against the full-page screenshot's coordinate space so annotation pins land
 * on the right pixels without any scale-factor math downstream.
 */

const VIEWPORT = { width: 1440, height: 900 };

/** §6 concurrency: capture is rate-limited to 1 req/sec/domain. */
const lastHitByDomain = new Map<string, number>();

/** Elements worth extracting. Interactive + structural — the things findings are about. */
const SELECTOR = [
  "a[href]", "button", "input", "select", "textarea", "form", "label",
  "h1", "h2", "h3", "nav", "header", "footer", "[role=button]", "[role=link]",
].join(",");

/**
 * Extraction budget handed to a sub-agent. At ~20 tokens per rendered element
 * line this is roughly 8K input tokens — cheap against Sonnet 5's window, and
 * measured runs came in at 5–9K total input at the old budget of 220.
 */
const MAX_ELEMENTS = 400;

/** Hard ceiling on in-page collection, so a pathological DOM cannot exhaust memory. */
const COLLECT_CEILING = 5000;

/**
 * When over budget we sample across this many horizontal bands of the page.
 * Straight first-N truncation is ordered by the DOM, which on a long page means
 * the entire lower half is invisible to the reviewer — it would report "no
 * footer contact details" on a page whose footer we simply never sent.
 */
const SAMPLE_BANDS = 12;

const TEXT_EXCERPT_LIMIT = 4000;
/** §8 redaction: raw page text is kept to 200-char excerpts. */
const ELEMENT_TEXT_LIMIT = 200;

export class CaptureFailed extends Error {
  constructor(
    message: string,
    readonly detail: string,
  ) {
    super(message);
    this.name = "CaptureFailed";
  }
}

async function respectRateLimit(url: string): Promise<void> {
  const domain = new URL(url).hostname;
  const last = lastHitByDomain.get(domain);
  if (last !== undefined) {
    const wait = 1000 - (Date.now() - last);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  lastHitByDomain.set(domain, Date.now());
}

/**
 * §5: respects robots.txt. Conservative and deliberately simple — we only honour
 * `Disallow` under a wildcard or our own agent, and we fail *open* on a fetch
 * error (a missing robots.txt means no restrictions, per the standard).
 */
export async function robotsAllows(url: string): Promise<boolean> {
  const target = new URL(url);
  let body: string;
  try {
    const res = await fetch(new URL("/robots.txt", target).href, {
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return true;
    body = await res.text();
  } catch {
    return true;
  }

  let applies = false;
  const disallowed: string[] = [];
  for (const rawLine of body.split("\n")) {
    const line = rawLine.split("#")[0]?.trim() ?? "";
    const [rawKey, ...rest] = line.split(":");
    if (!rawKey || rest.length === 0) continue;
    const key = rawKey.trim().toLowerCase();
    const value = rest.join(":").trim();

    if (key === "user-agent") {
      applies = value === "*" || value.toLowerCase() === "usabilitylab";
    } else if (key === "disallow" && applies && value !== "") {
      disallowed.push(value);
    }
  }
  return !disallowed.some((rule) => target.pathname.startsWith(rule));
}

async function extractElements(
  page: Page,
): Promise<{ elements: CapturedElement[]; total: number }> {
  return page.evaluate(
    ({ selector, max, ceiling, bands, textLimit }) => {
      interface Candidate {
        tag: string;
        role: string | null;
        text: string;
        bbox: { x: number; y: number; width: number; height: number };
        above_fold: boolean;
        input_type: string | null;
        accessible_name: string | null;
        name_source: "aria-label" | "aria-labelledby" | "label" | "title" | "alt" | "placeholder" | null;
        font_size: number;
        priority: number;
        order: number;
      }


      // Interactive elements are what findings are usually about, so they win a
      // contested slot over a structural wrapper in the same band.
      const INTERACTIVE = ["a", "button", "input", "select", "textarea", "label", "form"];
      const HEADING = ["h1", "h2", "h3"];

      const candidates: Candidate[] = [];
      const foldY = window.innerHeight;
      let total = 0;
      let order = 0;

      for (const node of Array.from(document.querySelectorAll(selector))) {
        if (total >= ceiling) break;
        const el = node as HTMLElement;

        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          continue;
        }

        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;

        total++;

        // getBoundingClientRect is viewport-relative; scrollY converts it to
        // full-page document coordinates, which is the space the full-page
        // screenshot is rendered in. Without this, every pin below the fold
        // would be off by the scroll offset.
        const pageY = r.top + window.scrollY;
        const pageX = r.left + window.scrollX;
        const tag = el.tagName.toLowerCase();
        const text = (el.innerText ?? el.textContent ?? "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, textLimit);

        // Accessible name, roughly in the order the accname spec resolves it.
        // Deliberately partial — the common cases, not a spec implementation.
        // Returning null when we genuinely cannot find a name is the useful
        // answer; guessing one would hide the very signal R3 reads.
        //
        // Written inline rather than as a helper on purpose: tsx compiles named
        // functions with an esbuild `__name(...)` wrapper, and that identifier
        // does not exist inside page.evaluate's browser context. A named helper
        // here throws "__name is not defined" at runtime while typechecking
        // perfectly.
        let accessibleName: string | null = null;
        let nameSource: "aria-label" | "aria-labelledby" | "label" | "title" | "alt" | "placeholder" | null = null;

        const ariaLabel = el.getAttribute("aria-label")?.trim();
        if (ariaLabel) {
          accessibleName = ariaLabel.slice(0, textLimit);
          nameSource = "aria-label";
        }
        if (accessibleName === null) {
          const labelledBy = el.getAttribute("aria-labelledby");
          if (labelledBy) {
            const named = labelledBy
              .split(/\s+/)
              .map((id) => document.getElementById(id)?.innerText?.trim() ?? "")
              .filter(Boolean)
              .join(" ");
            if (named) {
              accessibleName = named.slice(0, textLimit);
              nameSource = "aria-labelledby";
            }
          }
        }
        if (accessibleName === null) {
          const labels = (el as HTMLInputElement).labels;
          if (labels && labels.length > 0) {
            const named = Array.from(labels)
              .map((l) => l.innerText?.trim() ?? "")
              .filter(Boolean)
              .join(" ");
            if (named) {
              accessibleName = named.slice(0, textLimit);
              nameSource = "label";
            }
          }
        }
        if (accessibleName === null) {
          for (const attr of ["title", "alt", "placeholder"] as const) {
            const v = el.getAttribute(attr)?.trim();
            if (v) {
              accessibleName = v.slice(0, textLimit);
              nameSource = attr;
              break;
            }
          }
        }

        let priority = 0;
        if (INTERACTIVE.includes(tag) || el.getAttribute("role")) priority += 4;
        if (HEADING.includes(tag)) priority += 3;
        if (text.length > 0) priority += 1;
        if (pageY < foldY) priority += 1;

        candidates.push({
          tag,
          role: el.getAttribute("role"),
          text,
          bbox: { x: pageX, y: pageY, width: r.width, height: r.height },
          above_fold: pageY < foldY,
          input_type: tag === "input" ? ((el as HTMLInputElement).type || "text") : null,
          accessible_name: accessibleName,
          name_source: nameSource,
          font_size: Math.round(parseFloat(style.fontSize) || 0),
          priority,
          order: order++,
        });
      }

      let selected: Candidate[];

      if (candidates.length <= max) {
        selected = candidates;
      } else {
        // Band the page vertically and give each band a share of the budget, so
        // coverage spans the whole page instead of stopping partway down.
        const pageHeight = Math.max(1, document.body.scrollHeight);
        const buckets: Candidate[][] = Array.from({ length: bands }, () => []);
        for (const c of candidates) {
          // Clamped at both ends. A sticky or transformed element can sit at a
          // negative document y, which floors to a negative band index and
          // silently indexes past the start of the array — buckets[-1] is
          // undefined, and the push throws. Only reachable on pages above the
          // element cap, which is why it survived three sites undetected.
          const raw = Math.floor((c.bbox.y / pageHeight) * bands);
          const idx = Math.min(bands - 1, Math.max(0, raw));
          buckets[idx]!.push(c);
        }

        // Proportional share, but every non-empty band is guaranteed at least a
        // few slots so a sparse footer still gets represented.
        const nonEmpty = buckets.filter((b) => b.length > 0).length;
        const floorPerBand = Math.max(1, Math.floor(max / (nonEmpty * 3)));

        selected = [];
        const leftovers: Candidate[] = [];
        for (const bucket of buckets) {
          if (bucket.length === 0) continue;
          const share = Math.max(
            floorPerBand,
            Math.round((bucket.length / candidates.length) * max),
          );
          const ranked = bucket
            .slice()
            .sort((a, b) => b.priority - a.priority || a.order - b.order);
          selected.push(...ranked.slice(0, share));
          leftovers.push(...ranked.slice(share));
        }

        // Rounding can leave the budget under- or over-subscribed; settle up
        // globally by priority so the budget is spent exactly.
        if (selected.length > max) {
          selected.sort((a, b) => b.priority - a.priority || a.order - b.order);
          selected = selected.slice(0, max);
        } else if (selected.length < max && leftovers.length > 0) {
          leftovers.sort((a, b) => b.priority - a.priority || a.order - b.order);
          selected.push(...leftovers.slice(0, max - selected.length));
        }
      }

      // Refs are assigned last, in document order, so they read top-to-bottom
      // and stay contiguous regardless of how selection happened.
      selected.sort((a, b) => a.order - b.order);

      return {
        elements: selected.map((c, i) => ({
          ref: `el_${i}`,
          tag: c.tag,
          role: c.role,
          text: c.text,
          bbox: c.bbox,
          above_fold: c.above_fold,
          input_type: c.input_type,
          accessible_name: c.accessible_name,
          name_source: c.name_source,
          font_size: c.font_size,
        })),
        total,
      };
    },
    {
      selector: SELECTOR,
      max: MAX_ELEMENTS,
      ceiling: COLLECT_CEILING,
      bands: SAMPLE_BANDS,
      textLimit: ELEMENT_TEXT_LIMIT,
    },
  );
}

export async function capture(url: string, auditId: string, outDir: string): Promise<Capture> {
  if (!(await robotsAllows(url))) {
    throw new CaptureFailed("robots.txt disallows this path", url);
  }
  await respectRateLimit(url);
  await mkdir(outDir, { recursive: true });

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch();
    const context = await browser.newContext({
      viewport: VIEWPORT,
      deviceScaleFactor: 1,
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/124.0 Safari/537.36 UsabilityLab/0.1",
    });
    const page = await context.newPage();

    const response = await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 });
    if (!response) throw new CaptureFailed("no response from page", url);
    if (response.status() >= 400) {
      // F1: 404/blocked is a named failure, never an audit-from-imagination.
      throw new CaptureFailed(`HTTP ${response.status()}`, response.url());
    }

    // Let late layout and lazy content settle, but never block the whole
    // capture on a page that keeps a socket open (analytics, chat widgets).
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});

    // Scroll the full height once so lazy-loaded images and IntersectionObserver
    // content render before we measure boxes, then return to the top.
    await page.evaluate(async () => {
      const step = window.innerHeight;
      for (let y = 0; y < document.body.scrollHeight; y += step) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 120));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(400);

    const { elements, total: elementsTotal } = await extractElements(page);
    if (elements.length === 0) {
      // F2: rendered, but nothing on it. A parked domain or a JS wall.
      throw new CaptureFailed("page rendered no visible elements", url);
    }

    const screenshotId = `${auditId}-page`;
    const screenshotPath = path.join(outDir, `${screenshotId}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const fullHeight = await page.evaluate(() => document.body.scrollHeight);
    const fullText = (await page.evaluate(() => document.body.innerText ?? ""))
      .replace(/\s+/g, " ")
      .trim();
    const textExcerpt = fullText.slice(0, TEXT_EXCERPT_LIMIT);
    const title = await page.title();
    const finalUrl = page.url();

    const result = Capture.parse({
      audit_id: auditId,
      url,
      final_url: finalUrl,
      title,
      screenshot_id: screenshotId,
      screenshot_path: screenshotPath,
      viewport: VIEWPORT,
      full_height: fullHeight,
      elements,
      elements_total: elementsTotal,
      text_excerpt: textExcerpt,
      text_total_chars: fullText.length,
      captured_at: new Date().toISOString(),
    });

    await writeFile(path.join(outDir, "capture.json"), JSON.stringify(result, null, 2));
    return result;
  } finally {
    await browser?.close();
  }
}
