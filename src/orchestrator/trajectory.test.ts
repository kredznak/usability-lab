import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { Capture } from "../types.js";
import { deriveSignals } from "../signals.js";
import { decideSpawnSet, SPAWN_CAP } from "./rules.js";
import { orchestrate } from "./index.js";
import { ContextProfile, type Concern, type Goal, type SiteKind } from "../profile.js";

/**
 * Trajectory suite — docs/design.md §10.
 *
 * "(profile, captured-site fixture) → expected spawn set, expected rule firings."
 * Hermetic: frozen captures, pure rules, no model call, no network. This is the
 * suite §10 says must be 100% green on every PR, so it runs in milliseconds and
 * asserts spawn sets *exactly* — a suite that only checked "roughly the right
 * agents" would pass through the displacement bugs it exists to catch.
 */

const FIXTURES = "fixtures/captures";

function load(name: string): Capture {
  return Capture.parse(JSON.parse(readFileSync(path.join(FIXTURES, `${name}.json`), "utf8")));
}

function profile(p: {
  site_kind: SiteKind;
  concerns: Concern[];
  goal: Goal;
  drop_point?: "landing" | "mid_funnel" | "final_step" | "unknown";
}): ContextProfile {
  return ContextProfile.parse({
    site_kind: p.site_kind,
    concerns: p.concerns,
    goal: p.goal,
    drop_point: p.drop_point ?? "unknown",
    summary: "test profile",
  });
}

interface Case {
  name: string;
  fixture: string;
  profile: ContextProfile;
  spawn: string[];
  dropped: string[];
  /** What this case exists to prove. Failure messages quote it. */
  proves: string;
}

const CASES: Case[] = [
  {
    name: "UC-1 conversion leak on a plain landing page",
    fixture: "govuk",
    profile: profile({ site_kind: "marketing", concerns: ["conversion"], goal: "signup" }),
    spawn: ["heuristics", "forms", "conversion-cta"],
    dropped: [],
    proves: "UC-1's documented spawn set, with no page signal firing a fourth agent",
  },
  {
    name: "UC-4 checkout abandonment",
    fixture: "checkout",
    profile: profile({
      site_kind: "ecommerce",
      concerns: ["abandonment"],
      goal: "purchase",
      drop_point: "final_step",
    }),
    spawn: ["heuristics", "forms", "conversion-cta"],
    dropped: [],
    proves: "UC-4's set: forms leads, conversion-CTA supports, Copy correctly skipped",
  },
  {
    name: "UC-5 signup friction",
    fixture: "signup",
    profile: profile({ site_kind: "saas", concerns: ["conversion"], goal: "signup" }),
    spawn: ["heuristics", "forms", "conversion-cta", "a11y"],
    dropped: [],
    proves: "a page signal (placeholder-only labels) earns the fourth slot on its own",
  },
  {
    name: "UC-5 with a compliance mention displaces Copy",
    fixture: "signup",
    profile: profile({
      site_kind: "saas",
      concerns: ["conversion", "compliance", "messaging"],
      goal: "signup",
    }),
    spawn: ["heuristics", "forms", "conversion-cta", "a11y"],
    dropped: ["copy"],
    proves: "the cap-displacement case named in design.md §10, with the drop logged",
  },
  {
    name: "reordering the same concerns displaces A11y instead",
    fixture: "signup",
    profile: profile({
      site_kind: "saas",
      concerns: ["conversion", "messaging", "compliance"],
      goal: "signup",
    }),
    spawn: ["heuristics", "forms", "conversion-cta", "copy"],
    dropped: ["a11y"],
    proves: "displacement follows the visitor's stated emphasis, not a hardcoded lane table",
  },
  {
    name: "UC-2 pre-launch, no stated concern, signal-rich page",
    fixture: "hn",
    profile: profile({ site_kind: "other", concerns: [], goal: "learn" }),
    spawn: ["heuristics", "a11y", "copy", "visual-hierarchy"],
    dropped: [],
    proves: "with nothing stated, page signals alone fill the cap in a deterministic order",
  },
  {
    // Moved off `stripe` 2026-08-16. It relied on stripe carrying a bare a11y
    // page signal — which it did only because 21 of its 28 unnamed interactive
    // elements were in an off-canvas nav a visitor never sees. Once the capture
    // stopped collecting those, stripe fell to 8 unnamed of 168 (4.8%, under the
    // 10% threshold) and the case had no bare signal left to outrank.
    //
    // `hn` proves the same ordering and one thing more: a fourth rule is dropped
    // here, so the case now covers displacement as well as precedence.
    name: "UC-3 post-redesign, first impressions",
    fixture: "hn",
    profile: profile({ site_kind: "saas", concerns: ["first_impressions"], goal: "signup" }),
    spawn: ["heuristics", "visual-hierarchy", "conversion-cta", "a11y"],
    dropped: ["copy"],
    proves: "a stated concern outranks the goal, which outranks a bare page signal",
  },
  {
    name: "UC-6 pricing page confusion",
    fixture: "stripe_pricing",
    profile: profile({
      site_kind: "saas",
      concerns: ["comprehension"],
      goal: "purchase",
      drop_point: "mid_funnel",
    }),
    spawn: ["heuristics", "copy", "conversion-cta", "visual-hierarchy"],
    dropped: [],
    proves: "R4 fires on a pricing page, and 76 h1 elements earn Visual Hierarchy a slot",
  },
  {
    name: "content site with a comprehension concern spawns two",
    fixture: "wikipedia",
    profile: profile({ site_kind: "content", concerns: ["comprehension"], goal: "learn" }),
    spawn: ["heuristics", "copy"],
    dropped: [],
    proves: "the rules spawn narrowly when little fires — not every audit costs four agents",
  },
  {
    name: "quiet page, no concerns, no goal",
    fixture: "govuk",
    profile: profile({ site_kind: "content", concerns: [], goal: "learn" }),
    spawn: ["heuristics"],
    dropped: [],
    proves: "R0 is the floor: the system can decline to spawn anyone else",
  },
  {
    name: "R4 needs a goal AND a page to act on",
    fixture: "wikipedia",
    profile: profile({ site_kind: "ecommerce", concerns: [], goal: "purchase" }),
    spawn: ["heuristics", "copy"],
    dropped: [],
    proves: "a purchase goal on an article page does not spawn Conversion-CTA",
  },
  {
    name: "R4 fires on a landing page even without a checkout",
    fixture: "govuk",
    profile: profile({ site_kind: "ecommerce", concerns: [], goal: "purchase" }),
    spawn: ["heuristics", "conversion-cta"],
    dropped: [],
    proves: "the landing branch of R4, which is where most first audits land",
  },
  {
    name: "six rules fire, two are dropped",
    fixture: "hn",
    profile: profile({
      site_kind: "ecommerce",
      concerns: ["conversion", "messaging", "compliance", "first_impressions"],
      goal: "purchase",
    }),
    spawn: ["heuristics", "forms", "conversion-cta", "copy"],
    dropped: ["a11y", "visual-hierarchy"],
    proves: "the cap is a hard ceiling and both drops are logged, not silently discarded",
  },
  {
    name: "an unmentioned 9-field form loses its slot to stated concerns",
    fixture: "checkout",
    profile: profile({
      site_kind: "ecommerce",
      concerns: ["messaging", "compliance", "first_impressions"],
      goal: "purchase",
    }),
    spawn: ["heuristics", "copy", "conversion-cta", "a11y"],
    dropped: ["visual-hierarchy", "forms"],
    proves:
      "§3's rule is 'most relevant to the stated concern' — a strong page signal " +
      "genuinely loses to what the visitor asked about, and the drop is visible",
  },
  {
    // Was "signal-only firings tie-break deterministically" on this fixture,
    // which worked only while stripe carried a phantom a11y signal from its
    // off-canvas nav. Lane-order tie-breaking is still proven, by "UC-2
    // pre-launch" — three signal-only rules competing for two slots on `hn`.
    //
    // Repointed at what stripe is now good for, which is the regression this
    // whole episode is about: one weak signal spawns two agents and stops. The
    // cap is a ceiling, not a quota, and the old behaviour spent a scarce slot
    // on an accessibility review the page did not warrant.
    name: "a page with one weak signal does not pad the spawn set to the cap",
    fixture: "stripe",
    profile: profile({ site_kind: "other", concerns: [], goal: "unknown" }),
    spawn: ["heuristics", "visual-hierarchy"],
    dropped: [],
    proves: "the spawn cap is a ceiling, not a quota — a quiet page gets a small team",
  },
];

describe("trajectory: spawn set is exactly as specified", () => {
  for (const c of CASES) {
    test(c.name, () => {
      const capture = load(c.fixture);
      const decision = decideSpawnSet(c.profile, deriveSignals(capture));

      assert.deepEqual(
        decision.spawn,
        c.spawn,
        `${c.name}\n  proves: ${c.proves}\n  fired: ${decision.fired
          .map((f) => `${f.rule}:${f.agent}(${f.relevance}) ${f.because}`)
          .join(" | ")}`,
      );
      assert.deepEqual(
        decision.dropped.map((d) => d.agent),
        c.dropped,
        `${c.name}: wrong agents dropped`,
      );

      // §3: "logs the drop". A drop with no rationale is a silent truncation.
      for (const d of decision.dropped) {
        assert.ok(d.reason.length > 0, `drop of ${d.agent} carries no reason`);
        assert.ok(d.because.length > 0, `drop of ${d.agent} does not say why it fired`);
      }
    });
  }
});

describe("trajectory: invariants hold for every fixture and profile", () => {
  const fixtures = readdirSync(FIXTURES)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.replace(/\.json$/, ""));

  const ALL_CONCERNS: Concern[] = [
    "conversion",
    "abandonment",
    "messaging",
    "comprehension",
    "compliance",
    "first_impressions",
    "bounce",
  ];
  const GOALS: Goal[] = ["signup", "purchase", "book", "contact", "learn", "unknown"];

  test("no combination can breach the cap, drop Heuristics, or duplicate an agent", () => {
    let combos = 0;
    for (const name of fixtures) {
      const signals = deriveSignals(load(name));
      // Every prefix of the concern list, against every goal: enough coverage to
      // hit all firing counts and every displacement order that matters.
      for (let n = 0; n <= ALL_CONCERNS.length; n++) {
        for (const goal of GOALS) {
          const p = profile({
            site_kind: "other",
            concerns: ALL_CONCERNS.slice(0, n),
            goal,
          });
          const d = decideSpawnSet(p, signals);
          combos++;

          assert.ok(d.spawn.length <= SPAWN_CAP, `${name}: spawned ${d.spawn.length}`);
          assert.ok(d.spawn.includes("heuristics"), `${name}: R0 was displaced`);
          assert.equal(new Set(d.spawn).size, d.spawn.length, `${name}: duplicate agent`);
          assert.equal(
            d.spawn.length + d.dropped.length,
            d.fired.length,
            `${name}: a fired rule was neither spawned nor logged as dropped`,
          );
          for (const agent of d.spawn) {
            assert.ok(
              d.fired.some((f) => f.agent === agent),
              `${name}: spawned ${agent} with no rule firing`,
            );
          }
        }
      }
    }
    assert.ok(combos >= 300, `only ${combos} combinations exercised`);
  });

  test("the decision is a pure function of its inputs", () => {
    for (const name of fixtures) {
      const signals = deriveSignals(load(name));
      const p = profile({
        site_kind: "saas",
        concerns: ["conversion", "compliance", "messaging"],
        goal: "signup",
      });
      assert.deepEqual(decideSpawnSet(p, signals), decideSpawnSet(p, signals), name);
    }
  });
});

/**
 * Pinning — the prerequisite for a finding diff.
 *
 * Measured 2026-08-17: duolingo audited twice, two hours apart, on identical
 * prompt versions. The first run drew heuristics + visual-hierarchy; the second
 * drew those plus copy. Ten of the second run's twelve findings came from the
 * lane that had not run before, so a diff would have called every one of them
 * new. Matching findings cannot recover a reviewer that was never sent.
 */
describe("a re-audit reuses the baseline's reviewers", () => {
  const signals = deriveSignals(load("checkout"));
  const p = profile({ site_kind: "ecommerce", concerns: ["conversion"], goal: "purchase" });
  const client = null as unknown as Parameters<typeof orchestrate>[0];
  const log = { record: () => {} } as unknown as Parameters<typeof orchestrate>[4];

  test("the pinned lanes are what gets spawned, whatever the rules say", async () => {
    const pinned = ["heuristics", "copy"];
    const plan = await orchestrate(client, p, signals, "audit-1", log, {
      auditId: "baseline-0",
      lanes: pinned,
    });
    assert.deepEqual(plan.spawn, pinned);
  });

  test("no model is called, so a pin cannot be overridden or cost anything", async () => {
    // `client` is null: any attempt to reach the API throws rather than
    // silently succeeding against a mock that agrees with us.
    const plan = await orchestrate(client, p, signals, "audit-1", log, {
      auditId: "baseline-0",
      lanes: ["heuristics"],
    });
    assert.equal(plan.costUsd, 0);
  });

  test("drift from the rules is recorded, not hidden", async () => {
    const rules = decideSpawnSet(p, signals);
    const plan = await orchestrate(client, p, signals, "audit-1", log, {
      auditId: "baseline-0",
      lanes: ["heuristics"],
    });
    for (const dropped of rules.spawn.filter((a) => a !== "heuristics")) {
      assert.match(
        plan.rationale,
        new RegExp(`\\+${dropped}`),
        `the rules would now send ${dropped}; the rationale must say so`,
      );
    }
  });

  test("an empty pin falls through to the rules, never to no reviewers", async () => {
    // A baseline whose lanes we failed to resolve must not silently audit a
    // page with nobody looking at it. The model call fails here (null client)
    // and `orchestrate` degrades to the rule-derived set, which is the
    // pre-existing contract — so the empty pin lands on the safe path.
    const plan = await orchestrate(client, p, signals, "audit-1", log, {
      auditId: "baseline-0",
      lanes: [],
    });
    assert.deepEqual(plan.spawn, decideSpawnSet(p, signals).spawn);
    assert.ok(plan.spawn.length > 0);
    assert.ok(plan.spawn.includes("heuristics"), "heuristics is the baseline review on every audit");
  });
});
