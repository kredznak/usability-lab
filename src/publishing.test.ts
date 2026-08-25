import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Capture, type CapturedElement, type Finding } from "./types.js";
import { disputedFindings } from "./publishing.js";

/**
 * The rule that decides whether a customer waits for a person.
 *
 * Before 2026-08-24 the answer was always yes. The founder gate cut 10 findings
 * out of 165 and every written reason was a count stated as fact and wrong, so
 * the gate narrowed to the cases the capture can actually settle. What matters
 * in both directions: a finding the capture disproves must hold the audit, and
 * a check that has never earned its precision must not.
 */

function element(over: Partial<CapturedElement> = {}): CapturedElement {
  return {
    ref: "el_1",
    tag: "button",
    role: null,
    text: "Get started",
    bbox: { x: 0, y: 0, width: 120, height: 40 },
    above_fold: true,
    input_type: null,
    accessible_name: null,
    name_source: null,
    font_size: 19,
    ...over,
  };
}

function capture(elements: CapturedElement[], text = "Get started"): Capture {
  return Capture.parse({
    audit_id: "a",
    url: "https://example.com",
    final_url: "https://example.com/",
    title: "Example",
    screenshot_id: "s",
    screenshot_path: "s.png",
    viewport: { width: 1440, height: 900 },
    full_height: 2000,
    elements,
    elements_total: elements.length,
    text_excerpt: text,
    text_total_chars: text.length,
    captured_at: "2026-01-01T00:00:00.000Z",
  });
}

function finding(over: Partial<Finding> = {}): Finding {
  return {
    id: "f1",
    heuristic: "h",
    severity: 2,
    element_ref: "el_1",
    observation: "The button is small.",
    impact_note: "Hard to hit.",
    positive: false,
    agent: "heuristics",
    screen_ref: "s",
    confidence: "high",
    citation: { source_type: "none", url: null },
    evidence: { screenshot_id: "s", bbox: { x: 0, y: 0, width: 1, height: 1 } },
    ...over,
  } as Finding;
}

describe("what still needs a person", () => {
  test("an audit nothing disputes goes out on its own", () => {
    const held = disputedFindings([finding()], capture([element()]));
    assert.equal(held.length, 0);
  });

  test("a finding citing an element that is not there holds the audit", () => {
    // The plainest contradiction there is, and the one `claims.ts` was built
    // for: a confident sentence about something the capture never saw.
    const held = disputedFindings([finding({ element_ref: "el_99" })], capture([element()]));
    assert.equal(held.length, 1);
    assert.equal(held[0]!.id, "f1");
  });

  test("a quote that is not on the page holds the audit", () => {
    const held = disputedFindings(
      [finding({ element_ref: null, observation: 'The hero reads "Buy now while stocks last".' })],
      capture([element()]),
    );
    assert.equal(held.length, 1);
  });

  test("one bad finding holds the whole audit, not just itself", () => {
    // Publishing the good ones and quietly dropping the disputed one would be
    // a decision nobody made. The audit waits; a person decides.
    const held = disputedFindings(
      [finding({ id: "ok" }), finding({ id: "bad", element_ref: "el_99" })],
      capture([element()]),
    );
    assert.equal(held.length, 1);
    assert.equal(held[0]!.id, "bad");
  });

  test("a disputed count does NOT hold the audit", () => {
    /**
     * B32's count check is inconclusive by construction: it has caught two real
     * errors and has no precision record beyond that, and B11 is the precedent
     * for what a confident new check is worth — the quote check shipped with
     * teeth and was wrong all five times it fired.
     *
     * So a count mismatch is shown to a reviewer who is already reading, and is
     * not a reason to make a customer wait.
     */
    const held = disputedFindings(
      [
        finding({
          element_ref: null,
          observation: 'The "Get started" button appears three times on the page.',
        }),
      ],
      capture([element(), element({ ref: "el_2" })]),
    );
    assert.equal(held.length, 0, "inconclusive is not contradicted");
  });

  test("a hypothetical is not a quotation, and does not hold the audit", () => {
    // "no label such as X" names something absent. Reading it as a claim the
    // page says X is the false positive B11 measured five times over.
    const held = disputedFindings(
      [
        finding({
          element_ref: null,
          observation: 'There is no confirmation such as "Your order is on its way".',
        }),
      ],
      capture([element()]),
    );
    assert.equal(held.length, 0);
  });
});

/**
 * A hold has to leave a record, and for its whole life it did not.
 *
 * Measured on 2026-08-25: three audits run to settle §0's demo clause, and the
 * middle one stopped at REVIEW_PENDING. Its entire event trail was
 * `audit.completed` and then nothing — the status changed with no event, which
 * is B27, and which is why 15 rows in the funnel have no recorded cause.
 *
 * The reason itself was worse off than the status. `index.ts` printed which
 * findings the capture disputed to stdout, and `npm run worker` runs detached,
 * so on the deployment this product actually has, that sentence goes to a
 * terminal nobody reads. The single fact needed to act on a held audit lived
 * for the length of a console.log.
 *
 * `index.ts` is the pipeline's entry point and cannot be exercised from a unit
 * test without running an audit, so this reads the source — the same thing
 * `server.test.ts` does to stop the waiting page drifting from the step names.
 */
describe("a held audit says why, somewhere that outlives a terminal", () => {
  test("the branch that holds an audit records an event before it sets the status", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    const at = src.indexOf(`setStatus("REVIEW_PENDING"`);
    assert.notEqual(at, -1, "index.ts no longer holds audits; this test needs rewriting");

    // Look back over the branch, not the whole file — an `events.record` a
    // hundred lines up belongs to something else, and matching it would make
    // this pass for the wrong reason.
    const branch = src.slice(Math.max(0, at - 2000), at);
    assert.match(
      branch,
      /events\.record\(\{[\s\S]*?type:\s*"audit\.held"/,
      "REVIEW_PENDING is set without recording audit.held, so the hold is invisible",
    );
    assert.match(
      branch,
      /disputed\.map\(/,
      "the event must carry which findings were disputed, not just that some were",
    );
  });
});
