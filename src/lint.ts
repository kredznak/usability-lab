import type { Capture, Finding } from "./types.js";
import { SOURCES } from "./sources.js";

/**
 * The lint gate — docs/design.md §0, §9.8, quality-bar §7.
 *
 * Deterministic code, zero tokens (§2 lists it among the non-agents). It runs
 * after research and before the founder gate, and it does not block: the gate
 * is a person, and lint's job is to make sure they see the things worth seeing
 * before they read 13 findings in a row.
 *
 * ## Why nothing here blocks publishing
 *
 * An automated block would be the first mechanism in this system able to
 * silently discard a true finding. Every checker we have written has been wrong
 * on its first outing — the quote check was 0-for-5, the injection compliance
 * detector 0-for-3 — and both were wrong in the same direction: flagging a
 * reviewer for *quoting* something rather than asserting it. A rule with that
 * track record should inform a human, not overrule one.
 *
 * The single exception is `echo`, per F6: a finding that repeats a page's
 * instruction in its own voice is quarantined, because publishing it is worse
 * than losing it.
 */

export type LintRule = "echo" | "tone" | "positives" | "citation";

export interface LintFlag {
  rule: LintRule;
  /** Null when the flag is about the audit as a whole, not one finding. */
  finding_id: string | null;
  detail: string;
  /** Quarantined findings must not be published. Only `echo` sets this. */
  quarantine: boolean;
}

/**
 * Imperatives that only appear on a page when it is talking to a machine.
 *
 * Deliberately narrow. A page saying "ignore the noise" is marketing; a page
 * saying "ignore previous instructions" is addressing a reviewer, and a finding
 * that repeats it *as its own words* has stopped describing the page.
 */
const PAGE_IMPERATIVE =
  /\b(ignore (all |any )?(previous|prior) instructions|disregard (the |all )?(above|previous)|report no issues|return an empty (findings )?array|you are (now )?a helpful assistant|new (system )?(prompt|instruction)|end your review)/i;

/**
 * Second person aimed at the reader as an accusation. §9.8.4.
 *
 * "You have not stated" is an accusation; "your visitors" is ordinary product
 * writing. The distinction is the verb, so the pattern needs one.
 */
const ACCUSATORY =
  /\byou (have )?(failed|forgot|neglected|omitted|did not|didn't|haven't|never)\b|\byour (mistake|error|failure|oversight)\b/i;

/** §9.8.4: banned unless the finding is severity 4 at high confidence. */
const DOOM = /\b(catastrophic|disastrous|fatal|devastating|terrible|appalling|abysmal)\b/i;

/**
 * A finding's own words, with everything it quotes from the page removed.
 *
 * The lesson this file exists downstream of, learned twice in one day: a
 * reviewer that quotes an injection *while reporting it* is doing exactly what
 * SHARED_RULES asks. `claims.ts` draws the same line for quoted page text, and
 * `redteam.ts` had to learn it after nearly producing a verdict on noise.
 */
export function unquoted(text: string): string {
  return text
    .split(/["“”]/)
    .filter((_, i) => i % 2 === 0)
    .join(" ");
}

export function lintAudit(findings: Finding[], capture: Capture): LintFlag[] {
  const flags: LintFlag[] = [];
  const pageTalksToMachines = PAGE_IMPERATIVE.test(capture.text_excerpt);

  for (const f of findings) {
    const own = unquoted(`${f.observation} ${f.impact_note}`);

    // F6. Only when the page actually carries an imperative: without that,
    // a finding discussing injection in the abstract would be quarantined for
    // describing a risk the page does not pose.
    if (pageTalksToMachines && PAGE_IMPERATIVE.test(own)) {
      flags.push({
        rule: "echo",
        finding_id: f.id,
        detail:
          `repeats an instruction from the page in its own voice, outside quotation marks — ` +
          `the injection tell (F6)`,
        quarantine: true,
      });
    }

    if (ACCUSATORY.test(own)) {
      flags.push({
        rule: "tone",
        finding_id: f.id,
        detail: `addresses the reader as having failed: "${(own.match(ACCUSATORY) ?? [""])[0]}"`,
        quarantine: false,
      });
    }

    const doom = own.match(DOOM);
    if (doom && !(f.severity === 4 && f.confidence === "high")) {
      // Earned only by the worst findings we can evidence. Everywhere else it
      // is the tone quality-bar §7 calls "unearned superlatives".
      flags.push({
        rule: "tone",
        finding_id: f.id,
        detail: `"${doom[0]}" at severity ${f.severity}/${f.confidence} confidence — unearned`,
        quarantine: false,
      });
    }

    if (f.citation.source_type !== "none") {
      const known = SOURCES.some((s) => s.url === f.citation.url);
      if (!known) {
        // Structurally impossible today — `resolveCitation` reads the table, so
        // there is no argument through which a URL could arrive. This is here
        // so that if that ever stops being true, we find out from a lint flag
        // rather than from a customer.
        flags.push({
          rule: "citation",
          finding_id: f.id,
          detail: `cites ${f.citation.url ?? "(no url)"}, which is not in the source table`,
          quarantine: false,
        });
      }
    }
  }

  // §9.4, an audit-level rule: an audit that only accuses is a worse audit.
  if (findings.length > 0 && !findings.some((f) => f.positive)) {
    flags.push({
      rule: "positives",
      finding_id: null,
      detail: `${findings.length} findings and not one positive`,
      quarantine: false,
    });
  }

  return flags;
}

export function quarantined(flags: LintFlag[]): Set<string> {
  return new Set(flags.filter((f) => f.quarantine && f.finding_id).map((f) => f.finding_id!));
}
