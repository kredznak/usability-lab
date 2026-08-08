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

const MAX_ELEMENTS = 220;
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
    ({ selector, max, textLimit }) => {
      const out: {
        ref: string;
        tag: string;
        role: string | null;
        text: string;
        bbox: { x: number; y: number; width: number; height: number };
        above_fold: boolean;
      }[] = [];

      const nodes = Array.from(document.querySelectorAll(selector));
      const foldY = window.innerHeight;
      let i = 0;
      let total = 0;

      for (const node of nodes) {
        const el = node as HTMLElement;

        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          continue;
        }

        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;

        // Count every visible candidate, then stop *storing* at the cap, so the
        // caller can see how much was left out instead of guessing.
        total++;
        if (out.length >= max) continue;

        // getBoundingClientRect is viewport-relative; scrollY converts it to
        // full-page document coordinates, which is the space the full-page
        // screenshot is rendered in. Without this, every pin below the fold
        // would be off by the scroll offset.
        const pageY = r.top + window.scrollY;
        const pageX = r.left + window.scrollX;

        out.push({
          ref: `el_${i++}`,
          tag: el.tagName.toLowerCase(),
          role: el.getAttribute("role"),
          text: (el.innerText ?? el.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, textLimit),
          bbox: { x: pageX, y: pageY, width: r.width, height: r.height },
          above_fold: pageY < foldY,
        });
      }
      return { elements: out, total };
    },
    { selector: SELECTOR, max: MAX_ELEMENTS, textLimit: ELEMENT_TEXT_LIMIT },
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
    const textExcerpt = (await page.evaluate(() => document.body.innerText ?? ""))
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, TEXT_EXCERPT_LIMIT);
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
      captured_at: new Date().toISOString(),
    });

    await writeFile(path.join(outDir, "capture.json"), JSON.stringify(result, null, 2));
    return result;
  } finally {
    await browser?.close();
  }
}
