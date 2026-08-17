import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { counted, countingFetch, attemptsHere } from "./http.js";
import { BUDGETS } from "./budgets.js";

/**
 * B14. A synthesizer call ran 1618s and logged one row reading `ok=1`, and the
 * best explanation — two SDK timeouts and a third attempt — stayed a hypothesis
 * through four more slow runs because retries leave no trace. Counting them is
 * what turns the next occurrence into an answer instead of another experiment.
 */
describe("attempts are counted per call, not per process", () => {
  const fake = async () => new Response("{}");

  test("a clean call counts one attempt", async () => {
    const f = countingFetch(fake);
    const { attempts } = await counted(async () => {
      await f("https://example.test");
    });
    assert.equal(attempts, 1);
  });

  test("a retried call counts every attempt", async () => {
    const f = countingFetch(fake);
    const { attempts } = await counted(async () => {
      await f("https://example.test");
      await f("https://example.test");
      await f("https://example.test");
    });
    assert.equal(attempts, 3, "three HTTP attempts is the thing we could not see");
  });

  /**
   * §6 runs two sub-agents concurrently. A module-level counter would credit
   * one call with the other's retries, which is worse than not counting: it
   * would produce a confident wrong number.
   */
  test("two concurrent calls do not see each other's attempts", async () => {
    const f = countingFetch(fake);
    const slow = counted(async () => {
      await f("https://example.test");
      await new Promise((r) => setTimeout(r, 20));
      await f("https://example.test");
    });
    const fast = counted(async () => {
      await f("https://example.test");
    });
    const [a, b] = await Promise.all([slow, fast]);
    assert.equal(a.attempts, 2);
    assert.equal(b.attempts, 1);
  });

  test("the count survives a throw, which is the case worth counting", async () => {
    const f = countingFetch(fake);
    let seen = -1;
    await assert.rejects(
      counted(async () => {
        await f("https://example.test");
        await f("https://example.test");
        seen = attemptsHere();
        throw new Error("boom");
      }),
    );
    assert.equal(seen, 2);
  });

  test("a call outside any scope still works and counts nothing", async () => {
    // The snapshot harness and the tests build clients without a scope. A
    // fetch that threw there would break them for a diagnostic's sake.
    const f = countingFetch(fake);
    await f("https://example.test");
    assert.equal(attemptsHere(), 0);
  });
});

/**
 * The numbers themselves. §6 sets per-step budgets and nothing enforced them,
 * which is how a step ran for 27 minutes inside an audit promised in 8.
 */
describe("every model step is bounded in wall clock", () => {
  test("no step can spend more than four minutes, retries included", () => {
    for (const [name, b] of Object.entries(BUDGETS)) {
      const worst = b.timeout * (b.maxRetries + 1);
      assert.ok(
        worst <= 240_000,
        `${name} can spend ${worst / 1000}s, which does not fit an 8-minute audit`,
      );
    }
  });

  test("retries are bounded, because the timeout alone is not a budget", () => {
    // The SDK default is 600s with two retries: ~1800s before failing, which is
    // what 1618s looked like. A timeout without a retry cap bounds one attempt,
    // not the step.
    for (const [name, b] of Object.entries(BUDGETS)) {
      assert.ok(b.maxRetries <= 1, `${name} allows ${b.maxRetries} retries`);
    }
  });

  test("the budget clears the slowest healthy run we have measured", () => {
    // Synthesis has legitimately taken 43.5s; research 95.1s. A budget under
    // those would turn a working step into a permanent degradation.
    assert.ok(BUDGETS.synthesizer.timeout > 43_500);
    assert.ok(BUDGETS.researcher.timeout > 95_100);
  });
});
