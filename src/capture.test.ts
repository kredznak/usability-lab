import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { capture, robotsAllows } from "./capture.js";
import { createServer, type Server } from "node:http";
import type { Capture } from "./types.js";

/**
 * Capture's visibility contract, tested against a real browser.
 *
 * ## Why this file exists
 *
 * Cotopaxi's cart audit (2026-08-16) produced four findings about a slide-out
 * mini-cart positioned at x=1455–1778 — past the right edge of a 1440px
 * viewport, and so absent from the screenshot every finding is pinned onto.
 * Fifteen of ninety-seven elements were off-canvas, and all fifteen were
 * reported `above_fold: true`, because visibility was computed as
 * `pageY < foldY` — the y-axis alone.
 *
 * The findings that came out of it were the dangerous kind: every one stated a
 * true fact about the DOM and drew a false conclusion about a visitor. "The
 * same donation toggle appears twice" is exactly right about the document and
 * exactly wrong about the page. `claims.ts` confirms the element exists and the
 * quoted text is present; `deriveConfidence` confirms the element is real. Both
 * pass. Nothing downstream can catch it, which is why it has to be caught here.
 *
 * ## Why a browser and not a unit test
 *
 * The check lives inside `page.evaluate`, where an imported helper cannot be
 * called — tsx compiles named functions with an esbuild `__name(...)` wrapper
 * that does not exist in the browser context (see the comment in capture.ts).
 * So the predicate cannot be extracted and unit-tested without duplicating it,
 * and a duplicated rule is what produced the pin-numbering bug in Slice 4. One
 * real browser against one real page is the honest version.
 */

const FIXTURE = pathToFileURL(path.resolve("fixtures/pages/offcanvas.html")).href;
const VIEWPORT_WIDTH = 1440;

let cap: Capture;
let dir: string;

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "ulab-capture-"));
  cap = await capture(FIXTURE, "test-offcanvas", dir);
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

const byText = (needle: string) =>
  cap.elements.filter((e) =>
    `${e.text ?? ""} ${e.accessible_name ?? ""}`.toLowerCase().includes(needle.toLowerCase()),
  );

describe("elements outside the viewport are not page elements", () => {
  test("nothing is captured entirely past the right edge", () => {
    const past = cap.elements.filter((e) => e.bbox.x >= VIEWPORT_WIDTH);
    assert.deepEqual(
      past.map((e) => `${e.ref} ${e.tag} "${e.text ?? e.accessible_name ?? ""}" at x=${e.bbox.x}`),
      [],
      "a right-hand drawer is off-canvas; a visitor cannot see it and the screenshot does not contain it",
    );
  });

  test("nothing is captured entirely past the left edge", () => {
    // The mirror case. A right-only check passes Cotopaxi and still misses
    // RTL layouts and left-hand nav drawers.
    const past = cap.elements.filter((e) => e.bbox.x + e.bbox.width <= 0);
    assert.deepEqual(past.map((e) => e.ref), []);
  });

  test("the right-hand cart drawer's contents are all gone", () => {
    assert.equal(byText("Check Out").length, 0, "drawer checkout button");
    assert.equal(byText("Donate today").length, 0, "drawer donate button");
    assert.equal(byText("Cart drawer heading").length, 0, "drawer heading");
  });

  test("the left-hand nav drawer's contents are gone too", () => {
    assert.equal(byText("Shop all").length, 0);
  });
});

describe("what must still be captured", () => {
  test("on-screen content survives — this is a skip, not a purge", () => {
    assert.equal(byText("Continue to Checkout").length, 1);
    assert.equal(byText("Your cart is empty").length, 1);
  });

  test("an element straddling the edge is kept", () => {
    // Partly visible is visible. Dropping these would hide real overflow
    // problems, which are worth finding rather than filtering away.
    const peeking = byText("Partly on screen");
    assert.equal(peeking.length, 1, "a button half past the edge is still something a visitor sees");
    assert.ok(peeking[0]!.bbox.x < VIEWPORT_WIDTH);
    assert.ok(peeking[0]!.bbox.x + peeking[0]!.bbox.width > VIEWPORT_WIDTH);
  });

  test("above_fold stays a claim about the fold, not about everything", () => {
    // Guards the lazy fix: forcing off-canvas elements to above_fold=false
    // instead of dropping them would make them read as "further down the
    // page", which is a different wrong answer.
    const main = byText("Continue to Checkout")[0]!;
    assert.equal(main.above_fold, true);
  });
});

describe("drawer text stays out of the page text too", () => {
  /**
   * Filtering the element list alone was a half-fix. Cotopaxi's second run
   * still produced "the visible page text includes a Check Out label near the
   * item/subtotal line" — the drawer's elements were gone, its words were not,
   * and a reviewer read them out of text_excerpt. Reviewers are given that
   * string wholesale, so it is as much a visibility surface as the bboxes.
   */
  test("text_excerpt does not carry the right-hand drawer's words", () => {
    assert.ok(
      !cap.text_excerpt.includes("Cart drawer heading"),
      `drawer text leaked into text_excerpt: ${cap.text_excerpt}`,
    );
    assert.ok(!cap.text_excerpt.includes("Check Out"), "drawer's checkout label leaked");
  });

  test("text_excerpt does not carry the left-hand drawer's words either", () => {
    assert.ok(!cap.text_excerpt.includes("Shop all"));
  });

  test("on-screen words are still there — this is a filter, not a purge", () => {
    assert.ok(cap.text_excerpt.includes("Your cart is empty"));
    assert.ok(cap.text_excerpt.includes("Continue to Checkout"));
    assert.ok(cap.text_excerpt.includes("Partly on screen"), "straddling text is visible text");
  });
});

describe("hidden by an ancestor is hidden", () => {
  /**
   * Cotopaxi's region dropdown: `<a>Australia</a>` computing opacity 1,
   * visibility visible, and a real 151x19 box, inside a wrapper with
   * `opacity: 0` and 1px of overflow-hidden height. `opacity` does not inherit
   * as a computed value, so the link's own style says "visible" and means
   * nothing. The audit duly reported that the country list fails to mark the
   * active region — about a menu nobody had opened.
   */
  test("a closed dropdown's links are not captured", () => {
    assert.equal(byText("Australia").length, 0, "closed dropdown link was captured");
    assert.equal(byText("Canada").length, 0);
  });

  test("and its words are not in the page text", () => {
    assert.ok(!cap.text_excerpt.includes("Australia"));
  });

  test("the element list and the page text agree about what is visible", () => {
    // The invariant behind all of this. The text walk prunes from the top and
    // was always the stricter of the two; the element list inspecting each
    // node alone is what let three separate findings through. Any element
    // carrying text the page text does not have means they have diverged
    // again.
    for (const e of cap.elements) {
      const own = (e.text ?? "").trim();
      if (own.length < 8) continue;
      assert.ok(
        cap.text_excerpt.includes(own),
        `${e.ref} <${e.tag}> carries "${own}", which is not in the visible page text`,
      );
    }
  });
});

describe("markup is not page text", () => {
  /**
   * B9. 47% of asana's "visible page text" was `<iframe src="//b.yjtag.jp/...">`
   * — tracking markup inside `<noscript>`, which with scripting enabled is a
   * single unparsed text node, and which Chromium computes as display:inline,
   * opacity 1, 0x0. Every style check we had waved it through. Reviewers are
   * asked to reason about the words a visitor reads; half of asana's were this.
   */
  test("noscript contents never reach the page text", () => {
    assert.ok(!cap.text_excerpt.includes("<iframe"), `raw markup in page text: ${cap.text_excerpt}`);
    assert.ok(!cap.text_excerpt.includes("GTM-TRACKME"));
  });

  test("script and template contents do not either", () => {
    // These are usually display:none and usually caught. Usually is not a
    // contract, which is why the skip is by tag.
    assert.ok(!cap.text_excerpt.includes("scriptTextIsNotPageText"));
    assert.ok(!cap.text_excerpt.includes("templateTextIsNotPageText"));
  });

  test("the words a visitor actually reads are untouched", () => {
    assert.ok(cap.text_excerpt.includes("Your cart is empty"));
    assert.ok(cap.text_excerpt.includes("Continue to Checkout"));
  });
});

describe("the exclusion is data, not silence", () => {
  test("elements_total counts what the page had, so the drop is visible", () => {
    // If total silently equalled the kept count, a page whose entire content
    // sat in a drawer would look like a page with nothing on it.
    assert.ok(
      cap.elements_total > cap.elements.length,
      `expected more elements on the page (${cap.elements_total}) than captured (${cap.elements.length})`,
    );
  });
});

/**
 * B13. A fixed header paints once, at the top, in a full-page screenshot.
 *
 * duolingo's header is `position: fixed`, 1440x72 at top:0, and a reviewer
 * looking at the eight slices reported "no fixed or sticky version of it
 * reappears" — severity 2, high confidence, and false. The screenshot cannot
 * carry this fact and the element list was not carrying it either, so there was
 * nothing on the reviewer's side of the wall to be right with.
 */
describe("elements that stay put while the page scrolls say so", () => {
  let sticky: Capture;
  let stickyDir: string;

  before(async () => {
    stickyDir = mkdtempSync(path.join(tmpdir(), "ulab-sticky-"));
    sticky = await capture(
      pathToFileURL(path.resolve("fixtures/pages/sticky.html")).href,
      "test-sticky",
      stickyDir,
    );
  });

  after(() => {
    rmSync(stickyDir, { recursive: true, force: true });
  });

  const find = (needle: string) =>
    sticky.elements.find((e) => (e.text ?? "").includes(needle));

  /**
   * The case the first fix missed entirely.
   *
   * "Home" is an <a> inside a <nav> that computes `position: static`; the thing
   * that is fixed is a <div> our selector never captures. Reading
   * `style.position` off the element answers "static" about something that
   * never moves, and on the live page it recorded position on zero elements.
   * A fixed ancestor pins everything inside it.
   */
  test("a link pinned by a fixed ancestor is recorded as fixed", () => {
    assert.equal(find("Home")?.position, "fixed");
  });

  test("a sticky sub-nav is recorded as sticky", () => {
    assert.equal(find("Section one")?.position, "sticky");
  });

  test("the header itself is captured, not only its link", () => {
    // The <nav> and <header> wrappers are in the selector; they must carry the
    // same answer as the things inside them, since they are pinned by the same
    // ancestor.
    const nav = sticky.elements.find((e) => e.tag === "nav");
    assert.equal(nav?.position, "fixed", "the nav is static but sits inside a fixed div");
  });

  test("an ordinary element claims nothing", () => {
    // Null, not "static". The renderer says nothing when this is null, and a
    // capture taken before 2026-08-17 has null everywhere — so null has to
    // mean "unknown", never "definitely not sticky".
    assert.equal(find("Announcement")?.position ?? null, null);
    assert.equal(find("A link near the bottom")?.position ?? null, null);
  });
});

/**
 * B19 — the guard proxy, end to end through a real browser.
 *
 * The unit tests in `guardproxy.test.ts` prove the proxy refuses what it should.
 * This proves the browser is actually *using* it, which is a different claim and
 * the one that would silently stop being true — a wrong launch flag, a Chromium
 * default, a `finally` that closes the proxy too early, and every request goes
 * direct again while every test stays green.
 */
describe("the capture guard, with a browser attached", () => {
  const SSRF = pathToFileURL(path.resolve("fixtures/pages/ssrf-subresource.html")).href;

  test("a URL pointing inward is refused before a browser is launched", async () => {
    const out = mkdtempSync(path.join(tmpdir(), "ulab-ssrf-"));
    try {
      await assert.rejects(
        () => capture("http://169.254.169.254/latest/meta-data/", "ssrf-direct", out),
        /private network/,
      );
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  test("a page's inward-pointing sub-resources are refused, and said out loud", async () => {
    /**
     * The case that decided against `--host-resolver-rules`. The document here
     * is a harmless local file; its iframe and image point at cloud metadata and
     * the LAN. Pinning only the submitted URL would let both through, and an
     * iframe renders into the screenshot we publish.
     *
     * The refusals are read off stderr because that is where a person would see
     * them — a capture missing half its assets has to announce itself, or the
     * reviewers describe a layout that never existed.
     */
    const out = mkdtempSync(path.join(tmpdir(), "ulab-ssrf-"));
    const said: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void said.push(args.map(String).join(" "));
    try {
      const result = await capture(SSRF, "ssrf-subresource", out);
      // The page itself still captures — this is a guard, not a purge.
      assert.ok(result.elements.length > 0, "the harmless part of the page survives");
      assert.match(result.text_excerpt, /ordinary looking page/);
    } finally {
      console.error = realError;
      rmSync(out, { recursive: true, force: true });
    }

    const spoken = said.join("\n");
    assert.match(spoken, /capture guard refused/);
    assert.match(spoken, /169\.254\.169\.254 \(private-host\)/);
    assert.match(spoken, /10\.0\.0\.1 \(private-host\)/);
    /**
     * Loopback gets its own assertion because Chromium documents an exemption
     * for it — and this is where that exemption would show up if it applied.
     *
     * **It does not, on this Chromium.** Removing `bypass: "<-loopback>"` from
     * the launch options leaves this passing, which was checked by removing it.
     * So read this line as "loopback reaches the guard", not as "the bypass
     * option works" — the option is kept as insurance against a version that
     * restores the exemption, and `capture.ts` says so where it is set.
     */
    assert.match(spoken, /127\.0\.0\.1 \(private-host\)/);
  });
});


/**
 * `robots.txt` is the first request this system makes to a host somebody else
 * chose — before the browser, and therefore before the guard proxy exists.
 *
 * It used to go out through a bare `fetch`, which resolves the name itself. So
 * the host could answer publicly for `checkUrl` and privately here, and nothing
 * in the browser-side work would have touched it.
 */
describe("robots.txt connects to the address we validated", () => {
  let origin: Server;
  let port: number;

  before(async () => {
    origin = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("User-agent: *\nDisallow: /\n");
    });
    await new Promise<void>((r) => origin.listen(0, "127.0.0.1", r));
    port = (origin.address() as { port: number }).port;
  });

  after(() => origin.close());

  test("a pinned address is where it actually connects", async () => {
    /**
     * `nowhere.test` does not resolve. The only way this reaches a server that
     * answers "Disallow: /" is by dialling the address it was handed instead of
     * the name — which is the whole property.
     */
    const allowed = await robotsAllows(`http://nowhere.test:${port}/page`, "127.0.0.1");
    assert.equal(allowed, false, "it read the robots.txt at the pinned address");
  });

  test("without the pin it resolves the name, fails, and fails open", async () => {
    // The contrast that makes the test above mean something: same URL, no pin,
    // and it cannot get there at all. Failing open is the existing robots
    // behaviour for an unreachable file, not a new decision.
    const allowed = await robotsAllows(`http://nowhere.test:${port}/page`);
    assert.equal(allowed, true);
  });
});

/**
 * B30. Text the rendering carries and the DOM does not.
 *
 * `2928c314` finding 13 quoted basecamp's live visitor counter. Verified against
 * `capture.json` the claim was unsupported — the sentence was there, the number
 * was not — and at the gate it was one keystroke from being cut as false. It was
 * true: the digits live in a closed shadow root, so they reach the screenshot and
 * assistive technology while `textContent`, `innerText` and `shadowRoot` all
 * report nothing.
 *
 * The probe that produced this fix also refuted the entry's own hypothesis. B30
 * blamed a `visibleText` skip rule; instrumenting every rule against the live
 * page showed **none of them fire**. There was never anything to skip.
 */
describe("text the browser renders and the DOM cannot carry", () => {
  let shadow: Capture;
  let shadowDir: string;

  before(async () => {
    shadowDir = mkdtempSync(path.join(tmpdir(), "ulab-shadow-"));
    shadow = await capture(
      pathToFileURL(path.resolve("fixtures/pages/shadow-counter.html")).href,
      "test-shadow",
      shadowDir,
    );
  });

  after(() => {
    rmSync(shadowDir, { recursive: true, force: true });
  });

  const byText = (needle: string) =>
    shadow.elements.find((e) => (e.text ?? "").includes(needle));

  test("the capture still cannot see the number, which is the premise", () => {
    // If this ever starts failing, the DOM has become readable and the rest of
    // this suite is testing a problem that no longer exists.
    const counter = byText("people are working right now");
    assert.ok(counter, "the counter link should be captured");
    assert.ok(
      !/\d/.test(counter.text),
      `text should carry no digits, got ${JSON.stringify(counter.text)}`,
    );
  });

  test("the rendered name carries the digits the text does not", () => {
    const counter = byText("people are working right now");
    assert.ok(
      counter?.rendered_name?.includes("112,942"),
      `expected the rendered name to hold the figure, got ${JSON.stringify(
        counter?.rendered_name,
      )}`,
    );
  });

  test("an element whose name merely restates its text records nothing", () => {
    // Otherwise every row on the page grows a duplicate string, and a capture
    // doubles in size to say what it already said.
    assert.equal(byText("See pricing")?.rendered_name ?? null, null);
  });

  test("a name we already captured as accessible_name is not repeated", () => {
    const closer = shadow.elements.find((e) => e.accessible_name === "Close the dialog");
    assert.ok(closer, "the aria-labelled button should be captured");
    assert.equal(closer.rendered_name ?? null, null);
  });

  /**
   * The rule's own bug, pinned. Caught on the live page, not in review: an
   * `aria-hidden` date chip is text we capture and the accessible name leaves
   * out, so the rendered name is *shorter* than `text`. The first version
   * subtracted the long text from the short name, matched nothing, kept the
   * whole thing as residue, and reported a revelation where there was none.
   */
  test("a rendered name contained in the visible text adds nothing", () => {
    const event = byText("Intro to the product");
    assert.ok(event, "the aria-hidden-chip link should be captured");
    assert.ok(
      event.text.includes("Aug 26"),
      "the chip should be in the visible text, or this tests nothing",
    );
    assert.equal(event.rendered_name ?? null, null);
  });

  test("the stamps used to map elements are gone from the page", () => {
    // `data-ul-ref` is written onto live nodes so the accessibility pass can
    // find its way back. It is removed before the screenshot; if that ever
    // stops happening, we are photographing our own instrumentation.
    for (const el of shadow.elements) {
      assert.ok(
        !JSON.stringify(el).includes("data-ul-ref"),
        `${el.ref} still carries the capture stamp`,
      );
    }
  });
});
