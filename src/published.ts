/**
 * Rebuild what a visitor was shown, from what is on disk.
 *
 * ## Why this is its own module
 *
 * `correct.ts` already did this, and `server.ts` needed the same thirty lines:
 * read `findings.json` and `capture.json`, then rebuild the kept set from
 * `review.json`'s recorded decisions rather than from the findings file.
 *
 * A third copy was the obvious move and it is the wrong one. On 2026-08-17 the
 * same misunderstanding shipped in three separately-written checkers on one
 * day, because each was written from scratch rather than from the one before —
 * see the quotation lesson. This is that shape exactly: identical logic, three
 * files, no shared definition. So it gets a definition.
 *
 * ## The rule this encodes
 *
 * **The kept set comes from `review.json`, never from `findings.json`.** A
 * finding the founder cut must not reappear because it is still in the findings
 * file, and a severity they adjusted at the gate must not revert. Anything that
 * re-renders a published page has to obey that, and now it does so by
 * construction.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { Capture, Finding } from "./types.js";
import { OUT_ROOT } from "./paths.js";
import type { AuditRow } from "./db.js";

interface ReviewDecision {
  finding_id: string;
  keep: boolean;
  severity_after: number;
}

interface ReviewRecord {
  decisions: ReviewDecision[];
}

export interface PublishedAudit {
  dir: string;
  capture: Capture;
  /** Every finding the audit produced, in the order `annotate` drew them. */
  allFindings: Finding[];
  /** What the founder kept, with any severity they adjusted at the gate. */
  kept: Finding[];
  annotatedImage: string;
  summary: string;
}

export type LoadFailure = "no-review" | "no-findings" | "no-capture";

export class NotPublishable extends Error {
  constructor(
    readonly auditId: string,
    readonly reason: LoadFailure,
  ) {
    super(`audit ${auditId}: ${reason}`);
    this.name = "NotPublishable";
  }
}

/**
 * Throws rather than returning a partial page.
 *
 * Every caller here renders something a customer reads. A missing `review.json`
 * means we do not know what was kept, and the only safe rendering of "we do not
 * know what was kept" is no page at all — silently falling back to every
 * finding would publish the ones a person chose to withhold.
 */
export function loadPublished(audit: AuditRow, outRoot = OUT_ROOT): PublishedAudit {
  const dir = path.join(outRoot, audit.audit_id);
  const file = (name: string) => path.join(dir, name);

  if (!existsSync(file("findings.json"))) throw new NotPublishable(audit.audit_id, "no-findings");
  if (!existsSync(file("capture.json"))) throw new NotPublishable(audit.audit_id, "no-capture");
  if (!existsSync(file("review.json"))) throw new NotPublishable(audit.audit_id, "no-review");

  const allFindings = (JSON.parse(readFileSync(file("findings.json"), "utf8")) as unknown[]).map((f) =>
    Finding.parse(f),
  );
  const capture = Capture.parse(JSON.parse(readFileSync(file("capture.json"), "utf8")));
  const review = JSON.parse(readFileSync(file("review.json"), "utf8")) as ReviewRecord;

  const decided = new Map(review.decisions.map((d) => [d.finding_id, d]));
  const kept = allFindings
    .filter((f) => decided.get(f.id)?.keep)
    .map((f) => {
      const d = decided.get(f.id)!;
      return d.severity_after === f.severity ? f : Finding.parse({ ...f, severity: d.severity_after });
    });

  return {
    dir,
    capture,
    allFindings,
    kept,
    annotatedImage: file(`${audit.audit_id}-annotated.png`),
    summary: audit.profile_summary ?? "A review of this page.",
  };
}
