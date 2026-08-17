import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chooseBaseline, summarise } from "./reaudit.js";
import type { AuditRow } from "./db.js";
import type { CaptureDiff } from "./capture-diff.js";

/**
 * Which audit a re-audit measures against, and how the change reads.
 *
 * "What changed since last time" has to mean the last thing the customer saw.
 * If it silently means the last thing we ran, then retiring a bad run — which
 * we did four times this week — rewrites a customer's history.
 */

function row(over: Partial<AuditRow>): AuditRow {
  return {
    audit_id: "a", url: "https://example.com", final_url: "https://example.com/",
    title: "t", status: "PUBLISHED", profile_summary: null, findings_total: 1,
    findings_published: 1, cost_usd: 0, created_at: "2026-08-01", updated_at: "2026-08-01",
    published_at: "2026-08-01", ...over,
  } as AuditRow;
}

describe("the baseline is the last thing the customer saw", () => {
  test("a retired run is never the baseline", () => {
    // FAILED runs are ones we decided not to stand behind. Seven of the
    // fourteen audits in this project's database are retired.
    const rows = [
      row({ audit_id: "new", status: "FAILED", created_at: "2026-08-17" }),
      row({ audit_id: "old", status: "PUBLISHED", created_at: "2026-08-11" }),
    ];
    assert.equal(chooseBaseline(rows, "https://example.com")?.audit_id, "old");
  });

  test("a pending run is never the baseline", () => {
    const rows = [
      row({ audit_id: "pending", status: "REVIEW_PENDING", created_at: "2026-08-17" }),
      row({ audit_id: "live", status: "PUBLISHED", created_at: "2026-08-11" }),
    ];
    assert.equal(chooseBaseline(rows, "https://example.com")?.audit_id, "live");
  });

  test("an auto-published re-audit can be the next baseline", () => {
    const rows = [row({ audit_id: "auto", status: "AUTO_PUBLISHED" })];
    assert.equal(chooseBaseline(rows, "https://example.com")?.audit_id, "auto");
  });

  test("a trailing slash is not a different site", () => {
    const rows = [row({ audit_id: "live", url: "https://example.com/" })];
    assert.equal(chooseBaseline(rows, "https://example.com")?.audit_id, "live");
  });

  test("a different page of the same site is not the baseline", () => {
    // basecamp.com and basecamp.com/pricing are different pages, and diffing
    // one against the other would report the whole site as changed.
    const rows = [row({ audit_id: "home", url: "https://example.com" })];
    assert.equal(chooseBaseline(rows, "https://example.com/pricing"), null);
  });

  test("no published audit means no baseline, not a wrong one", () => {
    assert.equal(chooseBaseline([row({ status: "FAILED" })], "https://example.com"), null);
  });
});

describe("the change reads as what it is", () => {
  const empty: CaptureDiff = {
    title: null, final_url: null,
    interactive: { added: [], removed: [] },
    headings: { added: [], removed: [] },
    fields: { added: [], removed: [] },
    rotated: [], height_px: null, text_chars: null, partial: [],
  };

  test("a removed call to action is named", () => {
    const lines = summarise({
      ...empty,
      interactive: { added: [], removed: [{ tag: "a", label: "try basecamp free" }] },
    });
    assert.deepEqual(lines, ["gone:  <a> try basecamp free"]);
  });

  test("a rotation says it rolled over rather than listing items", () => {
    const lines = summarise({
      ...empty,
      rotated: [{ shape: "<MONTH> # intro", count: 2, added: 2, removed: 4 }],
    });
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /rolled over \(-4\/\+2\)/);
  });

  test("height alone is never a reported change", () => {
    // A page can grow by a pixel for a hundred reasons that mean nothing. It
    // is context on a real change, never a change by itself.
    assert.deepEqual(summarise({ ...empty, height_px: { before: 4604, after: 4502 } }), []);
  });
});
