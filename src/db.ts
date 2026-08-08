import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

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

export class CallLog {
  private db: Database.Database;

  constructor(dbPath = "out/usability-lab.db") {
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
        created_at        TEXT    NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_model_calls_audit ON model_calls(audit_id);
    `);
  }

  record(row: ModelCallRow): void {
    this.db
      .prepare(
        `INSERT INTO model_calls
           (audit_id, agent, model, prompt_version, input_tokens, output_tokens,
            cache_read_tokens, cache_write_tokens, latency_ms, cost_usd, ok, error, created_at)
         VALUES (@audit_id, @agent, @model, @prompt_version, @input_tokens, @output_tokens,
            @cache_read_tokens, @cache_write_tokens, @latency_ms, @cost_usd, @ok, @error, @created_at)`,
      )
      .run({ ...row, ok: row.ok ? 1 : 0, created_at: new Date().toISOString() });
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
