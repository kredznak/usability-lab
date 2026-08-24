import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { planReconciliation, applyReconciliation } from "./reconcile.js";
import { SubscriptionStore, type SubscriptionRow } from "./db.js";
import type { StripeSubscription } from "./stripe.js";

/**
 * F21's repair, as arithmetic.
 *
 * §12 promises "daily reconciliation vs. Stripe; reconciliation grants access;
 * one customer, ≤24h", and that promise is the only reason `db.ts` can afford to
 * make access **expire** rather than persist. If this job is wrong, a period end
 * that stops moving forward locks a paying customer out and nothing unlocks
 * them.
 *
 * None of the states below are ones a real Stripe account would produce on
 * request, which is why `planReconciliation` takes two lists and returns a plan
 * instead of talking to anything.
 */

const FUTURE = "2026-12-01T00:00:00.000Z";
const LATER = "2027-01-01T00:00:00.000Z";

function ours(over: Partial<SubscriptionRow> = {}): SubscriptionRow {
  return {
    email: "kelly@example.com",
    status: "active",
    stripe_customer_id: "cus_1",
    stripe_subscription_id: "sub_1",
    current_period_end: FUTURE,
    created_at: "2026-08-01T00:00:00.000Z",
    updated_at: "2026-08-01T00:00:00.000Z",
    // B22. Null is what reconciliation sees on a row it wrote itself, and the
    // only value that matters here: this file never orders anything.
    last_event_at: null,
    ...over,
  };
}

function theirs(over: Partial<StripeSubscription> = {}): StripeSubscription {
  return {
    id: "sub_1",
    customerId: "cus_1",
    status: "active",
    currentPeriodEnd: FUTURE,
    email: "kelly@example.com",
    ...over,
  };
}

describe("what reconciliation decides", () => {
  test("agreement is not drift", () => {
    const plan = planReconciliation([ours()], [theirs()]);
    assert.deepEqual(plan.drift, []);
    assert.equal(plan.checked, 1);
  });

  test("a customer Stripe says is paying and we say is not — F21, the named failure", () => {
    // The missed webhook. This is the whole reason the job exists.
    const plan = planReconciliation(
      [ours({ status: "canceled", current_period_end: null })],
      [theirs()],
    );
    assert.equal(plan.drift.length, 1);
    assert.equal(plan.drift[0]!.kind, "granted");
    assert.equal(plan.drift[0]!.after.status, "active");
    assert.equal(plan.drift[0]!.after.periodEnd, FUTURE);
  });

  test("a cancellation we missed is revoked, which F21 does not name but the same query answers", () => {
    const plan = planReconciliation([ours()], [theirs({ status: "canceled", currentPeriodEnd: null })]);
    assert.equal(plan.drift[0]!.kind, "revoked");
    assert.equal(plan.drift[0]!.after.status, "canceled");
  });

  test("a renewal moves the date without changing the status", () => {
    const plan = planReconciliation([ours()], [theirs({ currentPeriodEnd: LATER })]);
    assert.equal(plan.drift[0]!.kind, "renewed");
    assert.equal(plan.drift[0]!.after.periodEnd, LATER);
  });

  test("someone Stripe knows and we have never heard of is created", () => {
    const plan = planReconciliation([], [theirs({ email: "new@example.com" })]);
    assert.equal(plan.drift[0]!.kind, "created");
    assert.equal(plan.drift[0]!.before, null);
    assert.equal(plan.drift[0]!.email, "new@example.com");
  });

  test("a row Stripe has never heard of is reported and left alone", () => {
    /**
     * Hand-granted subscriptions have no Stripe ids and will never appear in
     * Stripe's list. Revoking them for being absent would delete the only kind
     * of subscription this product currently has — see `npm run subscribe`.
     */
    const plan = planReconciliation([ours({ email: "granted@example.com" })], []);
    assert.deepEqual(plan.drift, []);
    assert.deepEqual(plan.unknownToStripe, ["granted@example.com"]);
  });

  test("a Stripe subscription with no ul_email is skipped, not guessed at", () => {
    // Not created by this system, or its metadata was stripped. Attributing it
    // would mean granting access to an address inferred from a billing record.
    const plan = planReconciliation([], [theirs({ email: null })]);
    assert.deepEqual(plan.drift, []);
    assert.equal(plan.checked, 1);
  });

  test("addresses match however Stripe spells them", () => {
    const plan = planReconciliation([ours()], [theirs({ email: " Kelly@Example.COM " })]);
    assert.deepEqual(plan.drift, [], "one customer, not two");
  });

  test("Stripe's own vocabulary is narrowed on the way in", () => {
    // `trialing` is access; `unpaid` is not. Neither word appears in our column.
    assert.equal(planReconciliation([ours({ status: "canceled" })], [theirs({ status: "trialing" })]).drift[0]!.after.status, "active");
    assert.equal(planReconciliation([ours()], [theirs({ status: "unpaid" })]).drift[0]!.after.status, "past_due");
  });
});

describe("what reconciliation writes", () => {
  function withStore(fn: (s: SubscriptionStore) => void): void {
    const dir = mkdtempSync(path.join(tmpdir(), "ulab-rec-"));
    const store = new SubscriptionStore(path.join(dir, "t.db"));
    try {
      fn(store);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  test("a granted customer can use the product afterwards", () => {
    // The assertion that matters is `isActive`, not the row: F21's repair is
    // access, and access is a question only `isActive` answers.
    withStore((store) => {
      store.upsert("kelly@example.com", { status: "canceled", currentPeriodEnd: null });
      assert.equal(store.isActive("kelly@example.com"), false);

      const future = new Date(Date.now() + 86_400_000).toISOString();
      applyReconciliation(
        planReconciliation(store.all(), [theirs({ currentPeriodEnd: future })]),
        store,
      );
      assert.equal(store.isActive("kelly@example.com"), true);
    });
  });

  test("a revoked customer cannot", () => {
    withStore((store) => {
      const future = new Date(Date.now() + 86_400_000).toISOString();
      store.upsert("kelly@example.com", { status: "active", currentPeriodEnd: future });
      assert.equal(store.isActive("kelly@example.com"), true);

      applyReconciliation(
        planReconciliation(store.all(), [theirs({ status: "canceled", currentPeriodEnd: null })]),
        store,
      );
      assert.equal(store.isActive("kelly@example.com"), false);
    });
  });

  test("running it twice writes nothing the second time", () => {
    // A daily job that reports drift every day is a job nobody reads.
    withStore((store) => {
      applyReconciliation(planReconciliation(store.all(), [theirs()]), store);
      const second = planReconciliation(store.all(), [theirs()]);
      assert.deepEqual(second.drift, []);
    });
  });

  test("it never invents a Stripe id it was not given", () => {
    withStore((store) => {
      applyReconciliation(planReconciliation([], [theirs()]), store);
      const row = store.get("kelly@example.com")!;
      // The reconciler writes status and period only — the ids come from the
      // webhook, and a row that claims ids it was never told is a row that
      // lies to the next reader.
      assert.equal(row.stripe_customer_id, null);
      assert.equal(row.status, "active");
    });
  });
});
