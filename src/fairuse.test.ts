import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkFairUse, siteOf, SITE_LIMIT, AUDITS_PER_MONTH } from "./fairuse.js";
import type { ReauditRequestRow } from "./db.js";

/**
 * The cap, as arithmetic.
 *
 * §11 claims worst-case subscriber cost is structural because of these two
 * numbers. That claim is a test or it is a sentence, and the interesting cases
 * — the tenth versus the eleventh, the last day of a month versus the first day
 * of the next, the third site versus the fourth — are all boundaries. Every one
 * of them is a `now` passed in rather than a fixture that has to be aged.
 */

let nextId = 0;
function req(url: string, requestedAt: string): ReauditRequestRow {
  return {
    id: ++nextId,
    audit_id: "a",
    email: "reader@example.com",
    url,
    requested_at: requestedAt,
    completed_at: null,
  };
}

/** n requests for one site, all inside the given month. */
function month(n: number, ym: string, url = "https://example.com/"): ReauditRequestRow[] {
  return Array.from({ length: n }, (_, i) =>
    req(url, `${ym}-${String((i % 27) + 1).padStart(2, "0")}T12:00:00.000Z`),
  );
}

describe("which site a URL belongs to", () => {
  test("host, lowercased, without www", () => {
    assert.equal(siteOf("https://WWW.Example.com/pricing?a=1"), "example.com");
    assert.equal(siteOf("https://example.com/"), "example.com");
  });

  test("two pages of one site are one site", () => {
    assert.equal(siteOf("https://basecamp.com/"), siteOf("https://basecamp.com/pricing"));
  });

  test("a subdomain is its own site, because it is its own page to watch", () => {
    assert.notEqual(siteOf("https://app.example.com/"), siteOf("https://example.com/"));
  });

  test("something unparseable does not throw", () => {
    assert.equal(siteOf("not a url"), "not a url");
  });
});

describe("ten re-audits a month", () => {
  const now = new Date("2026-08-18T09:00:00.000Z");

  test(`the ${AUDITS_PER_MONTH}th is allowed`, () => {
    const history = month(AUDITS_PER_MONTH - 1, "2026-08");
    assert.equal(checkFairUse(history, "https://example.com/", now).allowed, true);
  });

  test(`the ${AUDITS_PER_MONTH + 1}th is not`, () => {
    const verdict = checkFairUse(month(AUDITS_PER_MONTH, "2026-08"), "https://example.com/", now);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.limit, "audits");
    assert.match(verdict.reason!, /resets on the 1st/);
  });

  test("last month's requests do not count against this month", () => {
    const history = [...month(AUDITS_PER_MONTH, "2026-07"), ...month(2, "2026-08")];
    assert.equal(checkFairUse(history, "https://example.com/", now).allowed, true);
  });

  test("the boundary is the month, not thirty days", () => {
    // Nine on 31 July and two on 1 August. A rolling thirty-day window would
    // refuse the second August ask; a calendar month is what $29/month means,
    // and it is what the refusal copy promises ("resets on the 1st").
    const history = [
      ...Array.from({ length: 9 }, () => req("https://example.com/", "2026-07-31T23:00:00.000Z")),
      req("https://example.com/", "2026-08-01T00:30:00.000Z"),
    ];
    const firstOfAugust = new Date("2026-08-01T01:00:00.000Z");
    assert.equal(checkFairUse(history, "https://example.com/", firstOfAugust).allowed, true);
  });

  test("a request that was acted on still counts — a failed re-audit is not refunded", () => {
    const history = month(AUDITS_PER_MONTH, "2026-08").map((r) => ({
      ...r,
      completed_at: "2026-08-10T00:00:00.000Z",
    }));
    assert.equal(checkFairUse(history, "https://example.com/", now).allowed, false);
  });
});

describe("three sites", () => {
  const now = new Date("2026-08-18T09:00:00.000Z");
  const three = [
    req("https://one.com/", "2026-08-02T00:00:00.000Z"),
    req("https://two.com/", "2026-08-03T00:00:00.000Z"),
    req("https://three.com/", "2026-08-04T00:00:00.000Z"),
  ];

  test(`a ${SITE_LIMIT + 1}th site is refused`, () => {
    const verdict = checkFairUse(three, "https://four.com/", now);
    assert.equal(verdict.allowed, false);
    assert.equal(verdict.limit, "sites");
    // The refusal names them, because "you have too many sites" is unactionable
    // and "you are already watching one.com, two.com, three.com" is not.
    assert.match(verdict.reason!, /one\.com/);
  });

  test("a site already being watched is always allowed back", () => {
    assert.equal(checkFairUse(three, "https://www.two.com/pricing", now).allowed, true);
  });

  test("sites do not reset with the month — the limit is what the plan is", () => {
    const lastYear = three.map((r) => ({ ...r, requested_at: "2025-01-05T00:00:00.000Z" }));
    assert.equal(checkFairUse(lastYear, "https://four.com/", now).allowed, false);
  });

  test("the monthly count is checked first, so the reason is the one that bites hardest", () => {
    // Eleven asks across three sites, now asking for a fourth: both limits
    // refuse. The customer is told about the one that resets, because that is
    // the one they can wait out.
    const history = [...three, ...month(AUDITS_PER_MONTH, "2026-08")];
    assert.equal(checkFairUse(history, "https://four.com/", now).limit, "audits");
  });
});

describe("an empty history", () => {
  test("the first ask is allowed", () => {
    assert.equal(checkFairUse([], "https://example.com/").allowed, true);
  });
});
