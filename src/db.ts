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
  | "DECLINED"
  | "FAILED";

/**
 * Whether an audit's findings ever had a chance at a citation.
 *
 * Not a status — an audit is `PUBLISHED` either way. This is the axis the
 * uncited metric has to be read along, because `none` means three different
 * things and only one of them is about the corpus. See `researchOutcome`.
 */
export type ResearchOutcome = "ok" | "failed" | "never";

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
  // DECLINED is the founder saying no, and it is the only other way out. Before
  // it existed the gate could publish or leave an audit pending forever, so a
  // deliberate refusal — 2ae5a280, a public school enrolment service we do not
  // want to critique under our name — was indistinguishable from a queue nobody
  // had got to. FAILED was the only terminal state available and it would have
  // been a lie: the audit worked.
  REVIEW_PENDING: ["PUBLISHED", "DECLINED"],
  // Terminal. A published audit that turns out to be wrong gets a correction
  // path, not a status rewind — quality-bar.md still has that UNRESOLVED.
  PUBLISHED: [],
  AUTO_PUBLISHED: ["REVIEW_PENDING"],
  CAPTURE_FAILED: ["CAPTURING", "PARKED"],
  PARKED: ["CAPTURING"],
  // Terminal, and deliberately not a detour. An audit that could be declined
  // and then published would make the record a suggestion, not a decision.
  DECLINED: [],
  FAILED: [],
};

/** Live states can always fail; §6's "any step → FAILED". */
const TERMINAL: AuditStatus[] = ["PUBLISHED", "DECLINED", "FAILED"];

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

  /**
   * Did the research step run on this audit, and did it survive?
   *
   * Read from `model_calls` for the same reason `lanesOf` is, plus one specific
   * to this step: **a finding cannot answer the question.** Every finding
   * carries `citation.source_type`, and it reads `none` in three unrelated
   * situations — Research looked and honestly declined, Research never ran
   * because the audit predates it, or Research ran and crashed. Only the first
   * says anything about the corpus, and pooling all three is how the uncited
   * rate came to read 85% when the number that means something is 61.6%.
   *
   * `failed` is its own answer rather than folded into `never`, because it is
   * the one that should never happen. On 2026-08-19 the duolingo audit's
   * researcher died on `Unterminated string in JSON` and published eight
   * silently uncited findings — see backlog B23.
   */
  researchOutcome(auditId: string): ResearchOutcome {
    const rows = this.db
      .prepare(`SELECT ok FROM model_calls WHERE audit_id = ? AND agent = 'researcher'`)
      .all(auditId) as { ok: number }[];
    if (rows.length === 0) return "never";
    // Any successful attempt counts: the runner retries, and a retry that
    // succeeded is a research step that ran.
    return rows.some((r) => r.ok === 1) ? "ok" : "failed";
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

  /**
   * What a single UTC day cost — F11's counter.
   *
   * `day` is a `YYYY-MM-DD` prefix of `created_at`, which is an ISO-8601 UTC
   * string on every row, so a prefix match is a day match. Failed calls are
   * included on purpose: a call that timed out after generating tokens is still
   * billed, and a ceiling that only counted successes would be blindest exactly
   * when spend was running away.
   */
  spentOn(day: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total FROM model_calls WHERE created_at LIKE ? || '%'`,
      )
      .get(day) as { total: number };
    return row.total;
  }

  /** Everything this project has ever spent, and how many calls it took. */
  lifetime(): { usd: number; calls: number } {
    const row = this.db
      .prepare(`SELECT COALESCE(SUM(cost_usd), 0) AS usd, COUNT(*) AS calls FROM model_calls`)
      .get() as { usd: number; calls: number };
    return row;
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

export interface EmailCaptureRow {
  audit_id: string;
  email: string;
  captured_at: string;
  /** Set when a magic link for this pair is first opened. Null until then. */
  verified_at: string | null;
}

/**
 * Who asked to see the rest of an audit — §6's email gate.
 *
 * ## Why this is a table and not an audit status
 *
 * §6 draws the state machine as `PUBLISHED → (EMAIL_CAPTURED) → (SUBSCRIBED)`,
 * and this store is a deliberate departure from that line, approved 2026-08-18.
 * Three reasons, in order of how much they cost to ignore:
 *
 * 1. **An email capture is a fact about a visitor, not about an audit.** Two
 *    people can open the same link; the audit has not changed state twice.
 *    Statuses that mean "somebody did something" cannot answer "who".
 * 2. **`PUBLISHED` is terminal by an explicit decision** — see LEGAL above. A
 *    published audit that turns out to be wrong gets a correction, not a status
 *    rewind, and `correct.ts` refuses to touch anything that is not PUBLISHED.
 *    Moving an audit to EMAIL_CAPTURED would silently disable corrections on
 *    every audit anyone had actually read.
 * 3. **The funnel reads events, not statuses.** The two stages this unlocks
 *    were always going to be counted from `email.captured` and `full.viewed`.
 *
 * ## What is stored, and what is not
 *
 * The address and two timestamps. No IP, no user agent, no page content. §8's
 * deletion clause is by `audit_id`, which is why that column is here and is the
 * only link to anything else — deleting a customer stays one join away.
 */
export class EmailCaptureStore {
  private db: Database.Database;

  constructor(dbPath = DB_PATH) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS email_captures (
        audit_id    TEXT NOT NULL,
        email       TEXT NOT NULL,
        captured_at TEXT NOT NULL,
        verified_at TEXT,
        PRIMARY KEY (audit_id, email)
      );
      CREATE INDEX IF NOT EXISTS idx_captures_audit ON email_captures(audit_id);
    `);
  }

  /**
   * Idempotent on (audit, email): asking twice re-issues a link rather than
   * erroring or duplicating. A visitor who loses the first mail is not doing
   * anything wrong, and `captured_at` keeps the *first* ask so the funnel's
   * preview→email timing stays honest.
   */
  capture(auditId: string, email: string): void {
    this.db
      .prepare(
        `INSERT INTO email_captures (audit_id, email, captured_at)
         VALUES (?, ?, ?)
         ON CONFLICT(audit_id, email) DO NOTHING`,
      )
      .run(auditId, email.trim().toLowerCase(), new Date().toISOString());
  }

  /** First open wins; later opens leave the timestamp alone. */
  markVerified(auditId: string, email: string): void {
    this.db
      .prepare(
        `UPDATE email_captures SET verified_at = ?
         WHERE audit_id = ? AND email = ? AND verified_at IS NULL`,
      )
      .run(new Date().toISOString(), auditId, email.trim().toLowerCase());
  }

  get(auditId: string, email: string): EmailCaptureRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM email_captures WHERE audit_id = ? AND email = ?`)
        .get(auditId, email.trim().toLowerCase()) as EmailCaptureRow | undefined) ?? null
    );
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Stripe's word for it, narrowed to the three that change what we do.
 *
 * Stripe emits more (`incomplete`, `trialing`, `unpaid`, `paused`). They map
 * onto these three at the boundary rather than here, because a column that can
 * hold every string Stripe has ever invented is a column nothing can reason
 * about — and `isActive` would then be a growing list of things that are not
 * quite active.
 */
export type SubscriptionStatus = "active" | "past_due" | "canceled";

export interface SubscriptionRow {
  email: string;
  status: SubscriptionStatus;
  /** Null until Stripe exists. Both ids are Stripe's, and neither is a secret. */
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  /** ISO. What access actually hangs on — see `isActive`. */
  current_period_end: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * §7's `subscriptions` table — who is paying, and until when.
 *
 * ## Keyed on email, not on audit
 *
 * §1 sells a subscription as monitoring for up to three sites, so it cannot
 * belong to one audit. The address is the only identity this system has: it is
 * what the gate captures, what the magic link signs, and what Stripe will send
 * back on a Checkout session. There is no `customers` table because there is
 * nothing else to put in one.
 *
 * ## Access expires; it does not persist
 *
 * `isActive` requires a `current_period_end` in the future. A row that says
 * `active` with no end date grants nothing. That is the harsher of the two
 * available defaults, and it is chosen to match F21: the named failure is
 * "customer paid, still locked out", the named repair is daily reconciliation
 * against Stripe, and the named blast radius is **one customer, ≤24h**. Trusting
 * the status forever would trade that for the opposite failure — a cancelled
 * customer keeping access until someone notices — which nothing in the doc
 * repairs and no number bounds.
 *
 * No grace period, deliberately. A grace window would quietly turn F21's ≤24h
 * into 24h-plus-whatever, and the number in the failure catalogue is the one
 * this has to honour.
 */
export class SubscriptionStore {
  private db: Database.Database;

  constructor(dbPath = DB_PATH) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS subscriptions (
        email                  TEXT PRIMARY KEY,
        status                 TEXT NOT NULL,
        stripe_customer_id     TEXT,
        stripe_subscription_id TEXT,
        current_period_end     TEXT,
        created_at             TEXT NOT NULL,
        updated_at             TEXT NOT NULL
      );
    `);
  }

  get(email: string): SubscriptionRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM subscriptions WHERE email = ?`)
        .get(email.trim().toLowerCase()) as SubscriptionRow | undefined) ?? null
    );
  }

  /**
   * Last writer wins, on purpose.
   *
   * Stripe webhooks arrive out of order and get retried; the reconciliation job
   * re-states the same facts daily. All three of those are writes that must be
   * safe to repeat, so this is an upsert with no version check. When ordering
   * starts to matter — it will, the first time a cancel lands before the renewal
   * it followed — the fix is Stripe's own event timestamp, not a lock.
   */
  upsert(
    email: string,
    fields: {
      status: SubscriptionStatus;
      stripeCustomerId?: string | null;
      stripeSubscriptionId?: string | null;
      currentPeriodEnd?: string | null;
    },
  ): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO subscriptions
           (email, status, stripe_customer_id, stripe_subscription_id,
            current_period_end, created_at, updated_at)
         VALUES (@email, @status, @customer, @subscription, @period_end, @now, @now)
         ON CONFLICT(email) DO UPDATE SET
           status                 = @status,
           stripe_customer_id     = COALESCE(@customer, stripe_customer_id),
           stripe_subscription_id = COALESCE(@subscription, stripe_subscription_id),
           current_period_end     = @period_end,
           updated_at             = @now`,
      )
      .run({
        email: email.trim().toLowerCase(),
        status: fields.status,
        customer: fields.stripeCustomerId ?? null,
        subscription: fields.stripeSubscriptionId ?? null,
        period_end: fields.currentPeriodEnd ?? null,
        now,
      });
  }

  /**
   * Every row. Added for `npm run reconcile`, which has to diff the whole table
   * against Stripe — there is no "which ones changed" question to ask a billing
   * system we are not already in sync with.
   */
  all(): SubscriptionRow[] {
    return this.db.prepare(`SELECT * FROM subscriptions ORDER BY email`).all() as SubscriptionRow[];
  }

  /** Paying, and paid up to a date that has not passed. See the class note. */
  isActive(email: string, now = Date.now()): boolean {
    const row = this.get(email);
    if (!row || row.status !== "active" || !row.current_period_end) return false;
    const end = Date.parse(row.current_period_end);
    return Number.isFinite(end) && end > now;
  }

  close(): void {
    this.db.close();
  }
}

export interface AuditRequestRow {
  request_id: string;
  url: string;
  /** The five answers, as submitted. JSON, because `Answers` is a free-text map. */
  answers: string;
  /** Null until the queue runner picks this up and mints an audit for it. */
  audit_id: string | null;
  requested_at: string;
  started_at: string | null;
}

/**
 * What a stranger asked us to look at — §0's question flow, queued.
 *
 * ## Why a request is not an audit
 *
 * **No HTTP request may spend money.** An audit costs ~$0.65 and ninety seconds
 * of a real browser; a form anyone on the internet can submit must not be able
 * to start one. So the form writes a row here and stops, and
 * `npm run audit -- --queue` is the thing that decides to spend. A stranger can
 * fill our queue; they cannot fill our bill.
 *
 * It is also the only honest way to answer §6's "your team is assembling". An
 * audit that has not started has no `audits` row to have a status, and inventing
 * one — REQUESTED, say — would put a state in the pipeline's own table that the
 * pipeline never created.
 *
 * ## The request id is the visitor's credential
 *
 * There is no login before the email gate (§1: anonymous through preview), so
 * `request_id` is what a visitor holds to come back to. A v4 UUID is 122 random
 * bits, which is the same reasoning that let audit ids be their own URLs — and
 * the same reason the status route must look up by whole id and never by prefix.
 *
 * ## What is not stored
 *
 * No IP, no user agent. The rate limiter keys on the connecting address in
 * memory and forgets it when the process restarts; writing it down here would
 * make it permanent, and §8's retention argument applies to a visitor's address
 * as much as to a customer's.
 */
export class AuditRequestStore {
  private db: Database.Database;

  constructor(dbPath = DB_PATH) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_requests (
        request_id   TEXT PRIMARY KEY,
        url          TEXT NOT NULL,
        answers      TEXT NOT NULL,
        audit_id     TEXT,
        requested_at TEXT NOT NULL,
        started_at   TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_requests_pending ON audit_requests(audit_id);
    `);
  }

  create(requestId: string, url: string, answers: Record<string, string>, now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO audit_requests (request_id, url, answers, requested_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(requestId, url, JSON.stringify(answers), now.toISOString());
  }

  get(requestId: string): AuditRequestRow | null {
    return (
      (this.db
        .prepare(`SELECT * FROM audit_requests WHERE request_id = ?`)
        .get(requestId) as AuditRequestRow | undefined) ?? null
    );
  }

  /** Oldest first, and only what nobody has started. */
  queue(): AuditRequestRow[] {
    return this.db
      .prepare(`SELECT * FROM audit_requests WHERE audit_id IS NULL ORDER BY requested_at`)
      .all() as AuditRequestRow[];
  }

  /**
   * Claim a request for an audit id, **before** the audit runs.
   *
   * Stamped first so the status page can answer "where is it" while the audit is
   * still in flight, and so a runner that dies mid-capture leaves a row pointing
   * at the wreckage rather than a row that looks untouched and gets picked up
   * again. `audit_id IS NULL` in the WHERE clause makes claiming it twice a
   * no-op rather than a race.
   */
  start(requestId: string, auditId: string, now = new Date()): boolean {
    const result = this.db
      .prepare(
        `UPDATE audit_requests SET audit_id = ?, started_at = ?
         WHERE request_id = ? AND audit_id IS NULL`,
      )
      .run(auditId, now.toISOString(), requestId);
    return result.changes === 1;
  }

  close(): void {
    this.db.close();
  }
}

export interface ReauditRequestRow {
  id: number;
  audit_id: string;
  email: string;
  url: string;
  requested_at: string;
  completed_at: string | null;
}

/**
 * The queue between the results page and `npm run reaudit`.
 *
 * ## Why a request and not a run
 *
 * **No HTTP request may spend money.** A button that started an audit inline
 * would put a ~$0.65 model spend and a 90-second Playwright capture behind a
 * click that anyone holding a session cookie can repeat, on a server with one
 * process. This records the ask; `npm run reaudit -- --queue` decides when to
 * spend, and the fair-use cap decides whether to at all.
 *
 * ## What the columns are for
 *
 * `url` is denormalised off the audit because that is what a re-audit takes as
 * its argument, and because the audit's `url` may change meaning if a row is
 * ever corrected — the request should record what was asked for at the time.
 * `email` is here rather than in an event because §8 makes events permanent and
 * an address must not outlive the 90-day capture policy; `audit_id` keeps
 * deleting a customer one join away, exactly as `email_captures` does.
 *
 * A request is `completed_at` when something acted on it, whether that action
 * found a change, found none, or failed. Leaving failures pending would make a
 * URL that cannot be captured retry on every queue run forever.
 */
export class ReauditRequestStore {
  private db: Database.Database;

  constructor(dbPath = DB_PATH) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reaudit_requests (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        audit_id     TEXT NOT NULL,
        email        TEXT NOT NULL,
        url          TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        completed_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_reaudit_pending ON reaudit_requests(completed_at);
      CREATE INDEX IF NOT EXISTS idx_reaudit_email ON reaudit_requests(email);
    `);
  }

  request(auditId: string, email: string, url: string, now = new Date()): void {
    this.db
      .prepare(
        `INSERT INTO reaudit_requests (audit_id, email, url, requested_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(auditId, email.trim().toLowerCase(), url, now.toISOString());
  }

  /**
   * Whether this reader already has an unacted-on request for this audit.
   *
   * The second click is the common case — nothing visible happens for hours —
   * and queueing two audits for it would spend twice for one decision.
   */
  pending(auditId: string, email: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 FROM reaudit_requests
         WHERE audit_id = ? AND email = ? AND completed_at IS NULL LIMIT 1`,
      )
      .get(auditId, email.trim().toLowerCase());
    return !!row;
  }

  /** Oldest first: a queue, not a stack. */
  queue(): ReauditRequestRow[] {
    return this.db
      .prepare(`SELECT * FROM reaudit_requests WHERE completed_at IS NULL ORDER BY id`)
      .all() as ReauditRequestRow[];
  }

  /** Everything this address has ever asked for — what the fair-use cap counts. */
  forEmail(email: string): ReauditRequestRow[] {
    return this.db
      .prepare(`SELECT * FROM reaudit_requests WHERE email = ? ORDER BY id`)
      .all(email.trim().toLowerCase()) as ReauditRequestRow[];
  }

  complete(id: number, now = new Date()): void {
    this.db
      .prepare(`UPDATE reaudit_requests SET completed_at = ? WHERE id = ? AND completed_at IS NULL`)
      .run(now.toISOString(), id);
  }

  close(): void {
    this.db.close();
  }
}
