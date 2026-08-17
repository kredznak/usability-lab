import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import { DB_PATH } from "./paths.js";

/**
 * model_calls — docs/design.md §4, §8. "Log every model call to model_calls from
 * run 1" (CLAUDE.md). This table IS the cost dashboard's source, so it is written
 * on every call including failures, not just successes.
 *
 * SQLite for slice 1; the schema is the one we intend to keep in Postgres, so
 * moving it later is a dialect change rather than a redesign.
 */

export interface ModelCallRow {
  audit_id: string;
  agent: string;
  model: string;
  prompt_version: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  latency_ms: number;
  cost_usd: number;
  ok: boolean;
  error: string | null;
  /**
   * HTTP attempts this call took — B14. 1 is clean; more means the SDK retried
   * and the token columns beside this describe only the attempt that returned.
   * Null on a call made outside a `counted()` scope, which is honest: unknown,
   * not one.
   */
  attempts?: number | null;
}

/**
 * USD per million tokens. Verified against docs.claude.com pricing as cached by
 * the claude-api skill (2026-06-24) — docs/design.md §11 used placeholders that
 * were ~3x high on the frontier tier.
 *
 * Sonnet 5 carries introductory pricing ($2/$10) through 2026-08-31, after which
 * it reverts to $3/$15. We deliberately bill at the STANDARD rate so the cost
 * model doesn't quietly regress when the intro window closes.
 */
const RATES: Record<string, { input: number; output: number }> = {
  "claude-opus-5": { input: 5.0, output: 25.0 },
  "claude-sonnet-5": { input: 3.0, output: 15.0 },
  "claude-haiku-4-5": { input: 1.0, output: 5.0 },
};

/** Cache reads bill at ~0.1x input; 5-minute cache writes at ~1.25x input. */
const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_WRITE_MULTIPLIER = 1.25;

export function estimateCost(
  model: string,
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_read_tokens?: number;
    cache_write_tokens?: number;
  },
): number {
  const rate = RATES[model];
  if (!rate) return 0;
  const perToken = (usd: number) => usd / 1_000_000;
  return (
    usage.input_tokens * perToken(rate.input) +
    usage.output_tokens * perToken(rate.output) +
    (usage.cache_read_tokens ?? 0) * perToken(rate.input) * CACHE_READ_MULTIPLIER +
    (usage.cache_write_tokens ?? 0) * perToken(rate.input) * CACHE_WRITE_MULTIPLIER
  );
}

/**
 * §6's audit state machine. States are rows in `audits.status`.
 *
 * §6 also lists EMAIL_CAPTURED and SUBSCRIBED after PUBLISHED. Neither is here:
 * the email gate is not built, and a state nothing can reach is a state nobody
 * maintains. They go in with the thing that writes them.
 *
 * RESEARCHING is listed but skippable — Research is not built either, so
 * AUDITING leads to ASSEMBLING directly. It stays in the map because the step
 * is coming and the edge is already specified.
 */
export type AuditStatus =
  | "REQUESTED"
  | "CAPTURING"
  | "AUDITING"
  | "RESEARCHING"
  | "ASSEMBLING"
  | "REVIEW_PENDING"
  | "PUBLISHED"
  | "AUTO_PUBLISHED"
  | "CAPTURE_FAILED"
  | "PARKED"
  | "FAILED";

/**
 * Every legal edge, and nothing else. §6: "transitions only via Inngest steps —
 * no agent writes status." There is no Inngest in v0, so this map plus
 * `AuditStore.transition` is what enforces it.
 *
 * FAILED is reachable from any live state ("any step → FAILED") and is applied
 * in `transition` rather than duplicated into all nine rows.
 */
const LEGAL: Record<AuditStatus, AuditStatus[]> = {
  REQUESTED: ["CAPTURING"],
  CAPTURING: ["AUDITING", "CAPTURE_FAILED"],
  AUDITING: ["RESEARCHING", "ASSEMBLING"],
  RESEARCHING: ["ASSEMBLING"],
  ASSEMBLING: ["REVIEW_PENDING", "AUTO_PUBLISHED"],
  REVIEW_PENDING: ["PUBLISHED"],
  // Terminal. A published audit that turns out to be wrong gets a correction
  // path, not a status rewind — quality-bar.md still has that UNRESOLVED.
  PUBLISHED: [],
  AUTO_PUBLISHED: ["REVIEW_PENDING"],
  CAPTURE_FAILED: ["CAPTURING", "PARKED"],
  PARKED: ["CAPTURING"],
  FAILED: [],
};

/** Live states can always fail; §6's "any step → FAILED". */
const TERMINAL: AuditStatus[] = ["PUBLISHED", "FAILED"];

export class IllegalTransition extends Error {
  constructor(
    readonly auditId: string,
    readonly from: AuditStatus,
    readonly to: AuditStatus,
  ) {
    super(`audit ${auditId}: ${from} -> ${to} is not a legal transition`);
    this.name = "IllegalTransition";
  }
}

export interface AuditRow {
  audit_id: string;
  url: string;
  final_url: string | null;
  title: string | null;
  status: AuditStatus;
  profile_summary: string | null;
  findings_total: number;
  findings_published: number;
  cost_usd: number;
  created_at: string;
  updated_at: string;
  published_at: string | null;
  /**
   * The audit this one was compared against, when a re-audit produced it.
   *
   * Null for a first audit. Set explicitly by `npm run reaudit` rather than
   * inferred from `--pin-to`: pinning the reviewer lanes and being a re-audit
   * are two different facts that happen to travel together, and conflating
   * them means a manually pinned experiment would silently be excluded from
   * the eval set.
   *
   * The corpus needs this because there was previously nothing anywhere that
   * distinguished a re-audit from a first audit — `reaudit.checked` is logged
   * against the *baseline*, so the new audit carried no link back.
   */
  baseline_audit_id: string | null;
}

/**
 * §4's `audits` store: audit_id, url, profile, status, timestamps.
 *
 * Separate connection to the same file as CallLog. SQLite in WAL mode handles
 * concurrent readers and a single writer, and keeping the two apart means the
 * review tool can open the audits table without dragging in the cost log.
 */
export class AuditStore {
  private db: Database.Database;

  constructor(dbPath = DB_PATH) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audits (
        audit_id           TEXT PRIMARY KEY,
        url                TEXT NOT NULL,
        final_url          TEXT,
        title              TEXT,
        status             TEXT NOT NULL,
        profile_summary    TEXT,
        baseline_audit_id  TEXT,
        findings_total     INTEGER NOT NULL DEFAULT 0,
        findings_published INTEGER NOT NULL DEFAULT 0,
        cost_usd           REAL    NOT NULL DEFAULT 0,
        created_at         TEXT NOT NULL,
        updated_at         TEXT NOT NULL,
        published_at       TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_audits_status ON audits(status);
    `);

    // Same reason as model_calls.attempts: CREATE TABLE IF NOT EXISTS does
    // nothing to a table that already exists, and this database holds every
    // audit the project has produced. Existing rows get NULL, which is correct
    // — they were all first audits, and the one re-audit among them is
    // backfilled by hand in the commit that adds this.
    const columns = this.db.prepare(`PRAGMA table_info(audits)`).all() as { name: string }[];
    if (!columns.some((c) => c.name === "baseline_audit_id")) {
      this.db.exec(`ALTER TABLE audits ADD COLUMN baseline_audit_id TEXT`);
    }
  }

  /** Opens an audit at REQUESTED — the only state that may be created. */
  create(auditId: string, url: string, baselineAuditId: string | null = null): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO audits (audit_id, url, status, baseline_audit_id, created_at, updated_at)
         VALUES (?, ?, 'REQUESTED', ?, ?, ?)`,
      )
      .run(auditId, url, baselineAuditId, now, now);
  }

  get(auditId: string): AuditRow | null {
    return (this.db.prepare(`SELECT * FROM audits WHERE audit_id = ?`).get(auditId) as
      | AuditRow
      | undefined) ?? null;
  }

  /** Prefix match, so the CLI can take the first 8 characters of a UUID. */
  find(prefix: string): AuditRow[] {
    return this.db
      .prepare(`SELECT * FROM audits WHERE audit_id LIKE ? ORDER BY created_at DESC`)
      .all(`${prefix}%`) as AuditRow[];
  }

  /**
   * Which reviewer lanes actually ran on an audit.
   *
   * Read from `model_calls` rather than from the findings, because a lane that
   * ran and found nothing is still a lane that ran — and a re-audit pinned to
   * the findings would quietly stop sending it. `agent` also carries merged
   * lane names like `copy+heuristics` on findings; the call log does not.
   */
  lanesOf(auditId: string, known: readonly string[]): string[] {
    const rows = this.db
      .prepare(`SELECT DISTINCT agent FROM model_calls WHERE audit_id = ? AND ok = 1`)
      .all(auditId) as { agent: string }[];
    return rows.map((r) => r.agent).filter((a) => known.includes(a));
  }

  list(status?: AuditStatus): AuditRow[] {
    return (
      status
        ? this.db.prepare(`SELECT * FROM audits WHERE status = ? ORDER BY created_at DESC`).all(status)
        : this.db.prepare(`SELECT * FROM audits ORDER BY created_at DESC`).all()
    ) as AuditRow[];
  }

  /**
   * The only way status changes. Throws on an illegal edge rather than
   * recording it — a status that lies is worse than a crash, because every
   * later decision reads it as fact.
   */
  transition(auditId: string, to: AuditStatus, fields: Partial<AuditRow> = {}): void {
    const row = this.get(auditId);
    if (!row) throw new Error(`audit ${auditId} does not exist`);

    const legal =
      LEGAL[row.status].includes(to) || (to === "FAILED" && !TERMINAL.includes(row.status));
    if (!legal) throw new IllegalTransition(auditId, row.status, to);

    const now = new Date().toISOString();
    const sets: string[] = ["status = @status", "updated_at = @updated_at"];
    const params: Record<string, unknown> = { audit_id: auditId, status: to, updated_at: now };

    for (const key of [
      "final_url",
      "title",
      "profile_summary",
      "findings_total",
      "findings_published",
      "cost_usd",
    ] as const) {
      if (fields[key] !== undefined) {
        sets.push(`${key} = @${key}`);
        params[key] = fields[key];
      }
    }
    if (to === "PUBLISHED" || to === "AUTO_PUBLISHED") {
      sets.push("published_at = @published_at");
      params.published_at = now;
    }

    this.db.prepare(`UPDATE audits SET ${sets.join(", ")} WHERE audit_id = @audit_id`).run(params);
  }

  close(): void {
    this.db.close();
  }
}

export class CallLog {
  private db: Database.Database;

  constructor(dbPath = DB_PATH) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS model_calls (
        id                INTEGER PRIMARY KEY AUTOINCREMENT,
        audit_id          TEXT    NOT NULL,
        agent             TEXT    NOT NULL,
        model             TEXT    NOT NULL,
        prompt_version    TEXT    NOT NULL,
        input_tokens      INTEGER NOT NULL,
        output_tokens     INTEGER NOT NULL,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        latency_ms        INTEGER NOT NULL,
        cost_usd          REAL    NOT NULL,
        ok                INTEGER NOT NULL,
        error             TEXT,
        attempts          INTEGER,
        created_at        TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_calls_audit ON model_calls(audit_id);
    `);

    // `CREATE TABLE IF NOT EXISTS` does nothing to a table that already exists,
    // so a database written before B14 keeps its old shape and every insert
    // fails on the unknown column. Existing rows get NULL, which is the correct
    // answer for calls made before anything counted.
    const columns = this.db.prepare(`PRAGMA table_info(model_calls)`).all() as { name: string }[];
    if (!columns.some((c) => c.name === "attempts")) {
      this.db.exec(`ALTER TABLE model_calls ADD COLUMN attempts INTEGER`);
    }
  }

  record(row: ModelCallRow): void {
    this.db
      .prepare(
        `INSERT INTO model_calls
           (audit_id, agent, model, prompt_version, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, latency_ms, cost_usd, ok, error, attempts, created_at)
         VALUES (@audit_id, @agent, @model, @prompt_version, @input_tokens, @output_tokens,
            @cache_read_tokens, @cache_write_tokens, @latency_ms, @cost_usd, @ok, @error, @attempts, @created_at)`,
      )
      .run({
        ...row,
        ok: row.ok ? 1 : 0,
        attempts: row.attempts ?? null,
        created_at: new Date().toISOString(),
      });
  }

  totalCost(auditId: string): number {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS total FROM model_calls WHERE audit_id = ?`)
      .get(auditId) as { total: number };
    return row.total;
  }

  close(): void {
    this.db.close();
  }
}

/**
 * The event log — docs/design.md §8, and the clause of §0's definition of done
 * that has never been built: "every step's events visible in the funnel
 * dashboard".
 *
 * ## Why this exists beyond the spec line
 *
 * Every expensive thing found on 2026-08-17 was found by reading something by
 * hand. B14 — a synthesizer step that ran 27 minutes and reported success —
 * was noticed because a step timing scrolled past in a terminal. Timings were
 * being printed and thrown away; `model_calls` records per-call cost but not
 * the shape of a run, and nothing at all recorded what a person did at the
 * gate.
 *
 * ## What goes in it, and what deliberately does not
 *
 * Step names, durations, outcomes, counts. **Not page content.** §8 makes
 * events permanent while captures expire at 90 days, so anything written here
 * outlives the deletion policy that covers the page it came from. Storing
 * scraped text here would quietly turn a 90-day promise into a permanent one.
 */
export interface EventRow {
  audit_id: string | null;
  type: string;
  data: Record<string, unknown>;
}

export class EventLog {
  private db: Database.Database;

  constructor(dbPath = DB_PATH) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        audit_id TEXT,
        type     TEXT NOT NULL,
        data     TEXT NOT NULL,
        at       TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_events_audit ON events(audit_id);
      CREATE INDEX IF NOT EXISTS idx_events_type ON events(type);
    `);
  }

  /**
   * Append-only, and it swallows its own failures.
   *
   * §8 calls this append-only; there is no update or delete here to make that
   * true by construction rather than by intention. And an audit must never die
   * because its telemetry did — a $0.65 run lost to a logging bug would be the
   * worst possible trade.
   */
  record(row: EventRow): void {
    try {
      this.db
        .prepare(`INSERT INTO events (audit_id, type, data, at) VALUES (?, ?, ?, ?)`)
        .run(row.audit_id, row.type, JSON.stringify(row.data), new Date().toISOString());
    } catch {
      // Deliberately silent: see above.
    }
  }

  all(auditId?: string): (EventRow & { at: string; id: number })[] {
    const rows = (
      auditId
        ? this.db.prepare(`SELECT * FROM events WHERE audit_id = ? ORDER BY id`).all(auditId)
        : this.db.prepare(`SELECT * FROM events ORDER BY id`).all()
    ) as { id: number; audit_id: string | null; type: string; data: string; at: string }[];
    return rows.map((r) => ({ ...r, data: JSON.parse(r.data) as Record<string, unknown> }));
  }

  close(): void {
    this.db.close();
  }
}
