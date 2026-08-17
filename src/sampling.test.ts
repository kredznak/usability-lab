import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sampledForReview, SAMPLE_RATE } from "./sampling.js";

/**
 * §6's 1-in-5 sampled review of re-audits.
 *
 * The failure worth testing for is not "the rate is slightly off" — it is
 * 0-in-5, which looks exactly like working software until you notice nobody
 * has read anything for a month. A random draw could not be tested for that
 * at all.
 */
describe("sampled review", () => {
  test("the same audit always gets the same answer", () => {
    // Otherwise re-running a re-audit is a way to shop for the outcome where
    // nobody has to read the findings.
    const id = randomUUID();
    const first = sampledForReview(id);
    for (let i = 0; i < 50; i++) assert.equal(sampledForReview(id), first);
  });

  test("about a fifth of real audit ids are sampled", () => {
    const ids = Array.from({ length: 4000 }, () => randomUUID());
    const sampled = ids.filter((id) => sampledForReview(id)).length;
    const share = sampled / ids.length;
    assert.ok(
      share > 0.17 && share < 0.23,
      `${(share * 100).toFixed(1)}% sampled, expected about ${100 / SAMPLE_RATE}%`,
    );
  });

  test("it is never nobody", () => {
    // The whole point. A rate that silently became zero is the one failure
    // that cannot be noticed by looking at the output.
    const ids = Array.from({ length: 200 }, () => randomUUID());
    assert.ok(ids.some((id) => sampledForReview(id)), "no audit in 200 was sampled");
  });

  test("it is never everybody either", () => {
    const ids = Array.from({ length: 200 }, () => randomUUID());
    assert.ok(ids.some((id) => !sampledForReview(id)));
  });

  test("UUID structure does not bunch the results", () => {
    // UUIDv4 fixes the version and variant nibbles, so ids are far from
    // uniform strings. Cheap arithmetic over their characters skews in ways
    // that are hard to see; this pins that the hash does not.
    const ids = Array.from({ length: 2000 }, () => randomUUID());
    const buckets = [0, 0, 0, 0, 0];
    for (const id of ids) {
      for (let r = 0; r < 5; r++) if (sampledForReview(`${id}-${r}`)) buckets[r]! += 1;
    }
    for (const b of buckets) assert.ok(b > 250 && b < 550, `bucket landed at ${b} of 2000`);
  });
});
