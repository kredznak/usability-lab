import { chromium, type Browser, type Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import path from "node:path";
import { Capture, type CapturedElement } from "./types.js";
import { resolveGuarded } from "./urlcheck.js";
import { startGuardProxy } from "./guardproxy.js";

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

/**
 * How much page text a reviewer is shown.
 *
 * Was 4000, chosen in Slice 1 and never revisited. **5 of the 11 distinct pages
 * we have ever captured exceed it**, and the cost of that is not a slightly
 * thinner brief — it is false findings. basecamp's page text is 6753 chars, the
 * reviewer saw 59% of it, and reported that six tool tiles "carry no visible
 * text on the page". The labels are rendered as headings above every tile. That
 * finding was rank 1, high confidence, mechanically verified, and wrong.
 *
 * 16000 covers 9 of those 11. At roughly 4 chars per token that is ~4K tokens
 * per reviewer against a 16K output budget, or about $0.04 on a $0.54 audit —
 * cheap next to a whole class of absence claims we cannot otherwise trust.
 * Anything still truncated now says so, which is the part that actually matters.
 */
const TEXT_EXCERPT_LIMIT = 16_000;
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
 * A GET that connects to an address we already validated — B19.
 *
 * `robots.txt` is the **first** request this system makes to a host somebody
 * else chose, and it went out through a bare `fetch`, which resolves the name
 * itself. So the host could answer publicly for `checkUrl` and privately here,
 * before the browser and its proxy were ever involved.
 *
 * Node's `lookup` option is the pin: the socket is told the answer instead of
 * asking for one. The `Host` header still carries the site's name, so virtual
 * hosting and TLS certificates behave exactly as they would without this.
 */
async function fetchPinned(url: URL, pinnedAddress?: string): Promise<string> {
  const address =
    pinnedAddress ??
    (await (async () => {
      const verdict = await resolveGuarded(url.hostname);
      if (!verdict.ok) throw new Error(`refused: ${verdict.reason}`);
      return verdict.address;
    })());

  return new Promise<string>((resolve, reject) => {
    const send = url.protocol === "https:" ? httpsRequest : httpRequest;
    const req = send(
      url,
      {
        timeout: 5000,
        lookup: (_hostname, opts, cb) => {
          // Signature varies with `opts.all`; both shapes are answered with the
          // one address we are willing to talk to.
          const family = address.includes(":") ? 6 : 4;
          if (opts && (opts as { all?: boolean }).all) {
            (cb as unknown as (e: null, a: { address: string; family: number }[]) => void)(null, [
              { address, family },
            ]);
          } else {
            (cb as unknown as (e: null, a: string, f: number) => void)(null, address, family);
          }
        },
      },
      (res) => {
        if ((res.statusCode ?? 500) >= 400) {
          res.resume();
          reject(new Error(`HTTP ${res.statusCode}`));
          return;
        }
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (c: string) => {
          // A robots.txt is a few kilobytes. Anything claiming to be more is
          // not something to hold in memory on a stranger's say-so.
          if (body.length < 512 * 1024) body += c;
        });
        res.on("end", () => resolve(body));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end();
  });
}

/**
 * §5: respects robots.txt. Conservative and deliberately simple — we only honour
 * `Disallow` under a wildcard or our own agent, and we fail *open* on a fetch
 * error (a missing robots.txt means no restrictions, per the standard).
 */
export async function robotsAllows(url: string, pinnedAddress?: string): Promise<boolean> {
  const target = new URL(url);
  // No robots.txt over `file://`, and nothing to ask. Fails open, as it does
  // for any unreachable robots.txt.
  if (target.protocol !== "http:" && target.protocol !== "https:") return true;
  let body: string;
  try {
    body = await fetchPinned(new URL("/robots.txt", target), pinnedAddress);
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

/** Upper bound on the page text we assemble. Well past any real page; a guard, not a budget. */
const FULL_TEXT_CEILING = 500_000;

async function extractElements(
  page: Page,
): Promise<{ elements: CapturedElement[]; total: number; fullText: string }> {
  return page.evaluate(
    ({ selector, max, ceiling, bands, textLimit, fullTextLimit }) => {
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
        position: "fixed" | "sticky" | null;
        priority: number;
        order: number;
      }


      /**
       * The text a person actually sees, which is not what `innerText` returns.
       *
       * `innerText` is layout-aware — it already skips display:none and
       * visibility:hidden — but it happily includes screen-reader-only text:
       * the `position:absolute; width:1px; height:1px; overflow:hidden` pattern
       * is *rendered*, just clipped to nothing. On linear.app that made the h1
       * read as "The product development system for teams and agents The
       * product development system for teams and agents", and a reviewer duly
       * reported the headline as duplicated. It is not; it wraps onto two
       * lines. The claim was false, it cited a real element, and so it passed
       * the confidence gate at *high* — a confident, checkable, wrong statement
       * on a customer's results page.
       *
       * So we assemble text ourselves and skip any descendant clipped to
       * nothing.
       *
       * The IIFE wrapper is load-bearing. tsx compiles a *named* function with
       * an esbuild `__name(...)` wrapper, and that identifier does not exist
       * inside page.evaluate's browser context; naming comes from the binding,
       * so returning the arrow from an IIFE leaves it anonymous. Assign this
       * arrow directly to a const and every capture throws "__name is not
       * defined" — loudly, at least, and the smoke test runs capture.
       */
      const visibleText = ((): ((root: Element, limit: number) => string) =>
        (root, limit) => {
        const parts: string[] = [];
        const stack: Node[] = [root];
        while (stack.length > 0) {
          const node = stack.pop()!;
          if (node.nodeType === Node.TEXT_NODE) {
            parts.push(node.nodeValue ?? "");
            continue;
          }
          if (node.nodeType !== Node.ELEMENT_NODE) continue;

          if (node !== root) {
            const el = node as HTMLElement;

            // Elements whose *contents are not content*, skipped by tag.
            //
            // `<noscript>` is the one that bit us. With scripting enabled its
            // children are never parsed — the whole thing is a single text node
            // holding literal markup — and Chromium computes it as
            // `display: inline`, `visibility: visible`, `opacity: 1` with a 0x0
            // rect, so every style check we had waved it through. 47% of
            // asana's "visible page text" was
            // `<iframe src="//b.yjtag.jp/iframe?c=..." width="1" ...>`.
            //
            // script and style usually are display:none and usually get caught.
            // Usually is not a contract. A tag check is a fact; a style check
            // turned out to be a request.
            const tag = el.tagName.toLowerCase();
            if (tag === "script" || tag === "style" || tag === "noscript" || tag === "template") {
              continue;
            }

            const cs = window.getComputedStyle(el);
            if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0") {
              continue;
            }
            // Clipped to nothing: a box this small cannot show text, and the
            // clipping is what makes it invisible rather than merely tiny.
            const r = el.getBoundingClientRect();
            if (
              (r.width <= 1 || r.height <= 1) &&
              (cs.overflow === "hidden" ||
                cs.clipPath !== "none" ||
                cs.getPropertyValue("clip") !== "auto")
            ) {
              continue;
            }

            // Off-canvas, the same rule the element list applies below.
            //
            // Filtering only the element list was a half-fix: Cotopaxi's second
            // run still produced a finding about "Check Out" appearing near the
            // subtotal, because the drawer's text was in text_excerpt even
            // though its elements were gone. Reviewers read that text.
            //
            // Guarded on a real width so a zero-width inline wrapper at x=0 is
            // not read as "left of the viewport" and does not take its whole
            // subtree with it.
            const textX = r.left + window.scrollX;
            if (r.width > 0 && (textX >= window.innerWidth || textX + r.width <= 0)) {
              continue;
            }
          }

          // Pushed in reverse so the stack pops them in document order.
          const kids = node.childNodes;
          for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
        }
        return parts.join(" ").replace(/\s+/g, " ").trim().slice(0, limit);
      })();

      /**
       * Is this element hidden by something above it in the tree?
       *
       * `visibleText` walks down from the body, so it prunes a hidden subtree
       * for free. The element list uses querySelectorAll and inspects each
       * element on its own, which is not the same question — and the gap is not
       * theoretical. Cotopaxi's region dropdown holds `<a>Australia</a>` with
       * computed opacity 1, visibility visible, and a real 151x19 box, inside a
       * `<ul>` with `opacity: 0` and a 1px-tall `overflow: hidden` wrapper.
       * `opacity` does not inherit as a computed value, so asking the link
       * about itself says "visible" and means nothing.
       *
       * The two paths disagreeing is how it surfaced: the audit produced a
       * finding about country links that were nowhere in text_excerpt, because
       * the text walk had correctly dropped them. The stricter of the two
       * answers was the right one.
       *
       * Memoized per ancestor. Without it this is getComputedStyle on every
       * ancestor of every one of up to 5000 candidates.
       */
      const ancestorHidden = ((): ((el: HTMLElement) => boolean) => {
        const cache = new Map<Element, boolean>();
        return (start) => {
          const chain: Element[] = [];
          let node: HTMLElement | null = start.parentElement;
          let hidden = false;
          while (node) {
            const cached = cache.get(node);
            if (cached !== undefined) {
              hidden = cached;
              break;
            }
            const cs = window.getComputedStyle(node);
            const r = node.getBoundingClientRect();
            const collapsed = (r.width <= 1 || r.height <= 1) && cs.overflow === "hidden";
            if (cs.display === "none" || cs.visibility === "hidden" || cs.opacity === "0" || collapsed) {
              hidden = true;
              cache.set(node, true);
              break;
            }
            chain.push(node);
            node = node.parentElement;
          }
          for (const c of chain) cache.set(c, hidden);
          return hidden;
        };
      })();

      /**
       * Does this element stay put while the page scrolls — B13, second attempt.
       *
       * The first attempt read `style.position` off the element itself and
       * recorded nothing at all on the page it was written for. duolingo's
       * header is a `position: static` <nav> inside a `position: fixed` <div>,
       * and the <div> is not in our selector, so asking each element about
       * itself answered "static" about something that never moves. That is the
       * same mistake as the opacity bug — asking an element about its own style
       * instead of asking what the visitor sees — and the fixture page hid it,
       * because the fixture put `fixed` directly on the <header>.
       *
       * A fixed ancestor pins everything inside it, so the whole chain is the
       * answer. Memoized like `ancestorHidden`, and for the same reason.
       */
      const pinnedBy = ((): ((el: HTMLElement) => "fixed" | "sticky" | null) => {
        const cache = new Map<Element, "fixed" | "sticky" | null>();
        return (start) => {
          const chain: Element[] = [];
          let node: HTMLElement | null = start;
          let found: "fixed" | "sticky" | null = null;
          while (node) {
            const cached = cache.get(node);
            if (cached !== undefined) {
              found = cached;
              break;
            }
            const p = window.getComputedStyle(node).position;
            if (p === "fixed" || p === "sticky") {
              found = p;
              cache.set(node, p);
              break;
            }
            chain.push(node);
            node = node.parentElement;
          }
          for (const c of chain) cache.set(c, found);
          return found;
        };
      })();

      // Interactive elements are what findings are usually about, so they win a
      // contested slot over a structural wrapper in the same band.
      const INTERACTIVE = ["a", "button", "input", "select", "textarea", "label", "form"];
      const HEADING = ["h1", "h2", "h3"];

      const candidates: Candidate[] = [];
      const foldY = window.innerHeight;
      const viewportW = window.innerWidth;
      let total = 0;
      let order = 0;

      for (const node of Array.from(document.querySelectorAll(selector))) {
        if (total >= ceiling) break;
        const el = node as HTMLElement;

        const style = window.getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") {
          continue;
        }
        // Asking the element about itself is not the same as asking whether it
        // is visible. A collapsed dropdown's links answer "visible" truthfully
        // and are still invisible, because the wrapper above them is not.
        if (ancestorHidden(el)) continue;

        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) continue;

        total++;

        // getBoundingClientRect is viewport-relative; scrollY converts it to
        // full-page document coordinates, which is the space the full-page
        // screenshot is rendered in. Without this, every pin below the fold
        // would be off by the scroll offset.
        const pageY = r.top + window.scrollY;
        const pageX = r.left + window.scrollX;

        // Off-canvas: rendered, but outside the strip the screenshot covers.
        //
        // A slide-out cart or nav drawer is parked past the edge with
        // `transform: translateX(100%)`, which defeats every skip above it —
        // it is not display:none, not visibility:hidden, not opacity:0, and it
        // has a real bounding box. Cotopaxi's mini-cart sat at x=1455-1778 on a
        // 1440px viewport and produced four findings about controls no visitor
        // could see, all at high confidence: "the same donation toggle appears
        // twice" is true of the document and false of the page.
        //
        // Nothing downstream can catch that. claims.ts confirms the element
        // exists and the quoted text is present; deriveConfidence confirms the
        // element is real. Both pass, because both are asking about the DOM.
        // Visibility is a fact only the capture holds, so it is settled here.
        //
        // Straddling the edge is kept on purpose — partly visible is visible,
        // and dropping those would hide genuine overflow bugs. Counted in
        // `total` before the skip, so a page whose content is all in a drawer
        // reads as a page we mostly excluded, not a page with nothing on it.
        if (pageX >= viewportW || pageX + r.width <= 0) continue;
        const tag = el.tagName.toLowerCase();
        const text = visibleText(el, textLimit);

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
          // B13. Only the two values that mean "this stays put while the page
          // scrolls" — the rest is noise the reviewer cannot use. A full-page
          // screenshot paints a fixed element once, at the top, so the picture
          // says the opposite of the truth here and nothing else carried it.
          position: pinnedBy(el),
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
        // Assembled with the same visibility rules as the element text. The
        // confidence gate checks quoted text against this, so if the two
        // disagreed a reviewer could quote text no visitor can see and have it
        // verified as evidence.
        fullText: visibleText(document.body, fullTextLimit),
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
          position: c.position,
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
      fullTextLimit: FULL_TEXT_CEILING,
    },
  );
}

export async function capture(url: string, auditId: string, outDir: string): Promise<Capture> {
  /**
   * Resolve once, up front, and refuse before anything is fetched — B19.
   *
   * The address is then used for every request this function makes: pinned
   * directly for `robots.txt`, and re-derived per host by the guard proxy for
   * everything the browser does. `checkUrl` at the front door decides whether a
   * URL may be *queued*; this is what decides whether it may be *reached*, and
   * the two are minutes or hours apart.
   */
  const target = new URL(url);
  /**
   * `file://` has no host and no network, so there is nothing to pin and
   * nothing to rebind — the fixtures under `fixtures/pages/` load this way. The
   * proxy is still started, because a local page can still reference `http://`
   * sub-resources and those are somebody's network.
   */
  const networked = target.protocol === "http:" || target.protocol === "https:";
  let pinned: string | undefined;
  if (networked) {
    const guarded = await resolveGuarded(target.hostname);
    if (!guarded.ok) {
      throw new CaptureFailed(
        guarded.reason === "private-host"
          ? "that address points at a private network"
          : "that host does not resolve",
        url,
      );
    }
    pinned = guarded.address;
  }

  if (!(await robotsAllows(url, pinned))) {
    throw new CaptureFailed("robots.txt disallows this path", url);
  }
  await respectRateLimit(url);
  await mkdir(outDir, { recursive: true });

  /**
   * Every request the page makes goes through this, including the ones we never
   * named: redirects, images, iframes, XHR. See guardproxy.ts.
   */
  const proxy = await startGuardProxy();

  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({
      /**
       * `bypass: "<-loopback>"` asks Chromium to **drop** its documented
       * exemption for `localhost`, `127.0.0.1` and `[::1]`.
       *
       * **It is belt, and I could not make the braces fail.** The fixture in
       * `capture.test.ts` requests a loopback sub-resource specifically to catch
       * this, and that request reaches the guard on this Chromium *with or
       * without* the option — so on this version the exemption is not being
       * applied to a proxy set this way. Kept anyway: the exemption is real and
       * documented, it is version-dependent, and a Playwright or Chromium
       * upgrade that restores it would otherwise reopen the hole in silence.
       *
       * What is *not* claimed: that a test covers this line. It does not, and
       * the note in the test says so.
       *
       * It has to go here rather than in `args` regardless — Playwright builds
       * `--proxy-bypass-list` from this option, and its version wins.
       */
      proxy: { server: proxy.url, bypass: "<-loopback>" },
    });
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

    const { elements, total: elementsTotal, fullText } = await extractElements(page);
    if (elements.length === 0) {
      // F2: rendered, but nothing on it. A parked domain or a JS wall.
      throw new CaptureFailed("page rendered no visible elements", url);
    }

    const screenshotId = `${auditId}-page`;
    const screenshotPath = path.join(outDir, `${screenshotId}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: true });

    const fullHeight = await page.evaluate(() => document.body.scrollHeight);
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
    await proxy.close();
    /**
     * A refused sub-resource changes what the page looked like, so it is said
     * out loud rather than swallowed. A capture missing its stylesheet produces
     * findings about a layout that never existed — and the reviewers cannot
     * tell the difference, which is precisely the failure mode this project
     * keeps rediscovering.
     */
    if (proxy.refusals.length > 0) {
      const hosts = [...new Set(proxy.refusals.map((r) => `${r.host} (${r.reason})`))];
      console.error(
        `  capture guard refused ${proxy.refusals.length} request(s) to ${hosts.length} host(s):\n` +
          hosts.map((h) => `    ${h}`).join("\n"),
      );
    }
  }
}
