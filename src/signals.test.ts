import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Capture } from "./types.js";
import { deriveSignals, classifyPage } from "./signals.js";

/**
 * Signal thresholds — the "page data" half of the spawn rules (design.md §3).
 *
 * These are the numbers that decide which specialists a customer's audit pays
 * for, and they were set by measuring the frozen fixtures rather than by taste.
 * That measurement is only trustworthy while every threshold still has fixtures
 * on BOTH sides of it: a signal that fires on everything routes nothing, and
 * one that fires on nothing is a lane we never send.
 *
 * So each test below names the fixtures that must be on each side. If a
 * threshold moves, or a fixture is refreshed and drifts across a line, the test
 * says which one and in which direction — rather than the trajectory suite
 * failing somewhere downstream with no explanation.
 */

const DIR = "fixtures/captures";

function load(name: string): Capture {
  return Capture.parse(JSON.parse(readFileSync(path.join(DIR, `${name}.json`), "utf8")));
}

const signals = Object.fromEntries(
  readdirSync(DIR)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const name = f.replace(/\.json$/, "");
      return [name, deriveSignals(load(name))];
    }),
);

/** Asserts a boolean signal fires on exactly the named fixtures and no others. */
function firesOn(signal: string, expected: string[]): void {
  const actual = Object.entries(signals)
    .filter(([, s]) => (s as unknown as Record<string, unknown>)[signal] === true)
    .map(([name]) => name)
    .sort();
  assert.deepEqual(
    actual,
    [...expected].sort(),
    `${signal} fires on [${actual.join(", ")}] but should fire on [${expected.join(", ")}]`,
  );
}

describe("signals: each threshold keeps fixtures on both sides", () => {
  test("has_substantive_form separates a real form from a search box", () => {
    // hn has a single search field and must NOT count as a form; if it does,
    // R1 fires on every site on the web.
    firesOn("has_substantive_form", ["checkout", "signup"]);
    assert.equal(signals.hn!.form_fields, 1, "hn's lone search field");
    assert.equal(signals.checkout!.form_fields, 9);
  });

  test("a11y_signal grades unnamed elements on proportion, not count", () => {
    firesOn("a11y_signal", ["hn", "signup", "stripe"]);
    // stripe_pricing has unnamed interactives too, but as a trivial share of a
    // very large page — the case that motivated the proportional threshold.
    assert.ok(
      signals.stripe_pricing!.unnamed_interactive_share < 0.1,
      "stripe_pricing must stay below the share threshold",
    );
    assert.ok(signals.stripe!.unnamed_interactive_share >= 0.1);
  });

  test("a field named only by its placeholder is enough on its own", () => {
    assert.equal(signals.signup!.unnamed_interactives, 0, "signup has no unnamed controls");
    assert.ok(signals.signup!.unlabelled_fields > 0);
    assert.equal(signals.signup!.a11y_signal, true, "placeholder-only labels must still fire R3");
    // checkout is the same page shape done correctly, and is the control.
    assert.equal(signals.checkout!.unlabelled_fields, 0);
    assert.equal(signals.checkout!.a11y_signal, false);
  });

  test("copy_dense separates text-heavy pages from marketing pages", () => {
    firesOn("copy_dense", ["hn", "wikipedia"]);
    // The nearest fixture on each side of 1500 chars/screen.
    assert.ok(signals.wikipedia!.copy_density > 1500);
    assert.ok(signals.stripe_pricing!.copy_density < 1500);
  });

  test("hierarchy_signal fires on a flat type scale or a broken h1", () => {
    firesOn("hierarchy_signal", ["hn", "stripe", "stripe_pricing"]);
    assert.equal(signals.hn!.h1_count, 0, "hn has no h1 at all");
    assert.equal(signals.stripe!.h1_count, 2, "two h1s is not a hierarchy");
    assert.ok(signals.stripe_pricing!.h1_count > 1);
    // govuk is the control: exactly one h1 and a clear type scale.
    assert.equal(signals.govuk!.h1_count, 1);
    assert.ok(signals.govuk!.competing_emphases <= 3);
  });
});

describe("signals: page classification", () => {
  test("every page kind the rules read is represented by a fixture", () => {
    const kinds = new Set(Object.values(signals).map((s) => s.page_kind));
    for (const kind of ["checkout", "pricing", "signup", "landing", "content"]) {
      assert.ok(kinds.has(kind as never), `no fixture classifies as '${kind}'`);
    }
  });

  test("is_goal_page is exactly the pages with a goal action", () => {
    firesOn("is_goal_page", ["checkout", "signup", "stripe_pricing"]);
  });

  test("a site root is a landing page, and an unrecognised path is content", () => {
    const base = load("govuk");
    assert.equal(classifyPage({ ...base, final_url: "https://x.com/", title: "X" }), "landing");
    assert.equal(classifyPage({ ...base, final_url: "https://x.com", title: "X" }), "landing");
    assert.equal(
      classifyPage({ ...base, final_url: "https://x.com/blog/hello", title: "Hello" }),
      "content",
    );
  });

  test("classification falls back rather than throwing on a malformed URL", () => {
    // A wrong guess sends a generalist; a throw loses the audit.
    const base = load("govuk");
    assert.doesNotThrow(() =>
      classifyPage({ ...base, final_url: "not a url at all", title: "" }),
    );
  });
});

describe("signals: derivation is total and pure", () => {
  test("an empty capture produces signals rather than NaN or a throw", () => {
    const empty = Capture.parse({
      ...load("govuk"),
      elements: [],
      elements_total: 0,
      text_excerpt: "",
      text_total_chars: 0,
      full_height: 0,
    });
    const s = deriveSignals(empty);
    assert.equal(s.unnamed_interactive_share, 0, "0/0 must not be NaN");
    assert.equal(Number.isFinite(s.copy_density), true, "division by zero height");
    assert.equal(s.a11y_signal, false);
    assert.equal(s.hierarchy_signal, true, "zero h1 elements is still a broken hierarchy");
  });

  test("the same capture always derives the same signals", () => {
    for (const name of Object.keys(signals)) {
      const c = load(name);
      assert.deepEqual(deriveSignals(c), deriveSignals(c), name);
    }
  });
});
