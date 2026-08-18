/**
 * A sliding-window counter — B16.
 *
 * ## What it is actually defending
 *
 * Not the audit. `POST /a/:id/email` will, once a mail sender exists, send
 * "here are your audit results" to whatever address is typed into it. Unlimited,
 * that makes us a relay: anyone holding one published results URL can mail an
 * arbitrary stranger as fast as a loop runs, from our domain, about a site they
 * have never visited. The limit that matters is therefore keyed on the
 * **recipient**, and the one keyed on the audit is what stops ten thousand
 * different recipients through a single URL.
 *
 * ## Why `now` is a parameter
 *
 * So the tests are arithmetic rather than sleeping. A rate-limit test that
 * waits for real time is slow when it passes and flaky when it fails, and the
 * failure mode — "the window boundary is off by one" — is exactly what a sleep
 * hides.
 *
 * ## Why it is in memory, and what that costs
 *
 * One process, one SQLite file. A restart forgets every window, so a determined
 * attacker gets a fresh allowance by waiting for a deploy. That is an honest
 * trade at this size and the wrong one behind a load balancer, where two
 * processes would each enforce the limit separately and the real limit would
 * quietly be double what is written here. **Both are reasons this must be
 * revisited before there is more than one process** — noted in B16.
 */

export interface Verdict {
  allowed: boolean;
  /** Milliseconds until the oldest hit in the window falls out. 0 when allowed. */
  retryAfterMs: number;
}

export class SlidingWindow {
  private hits = new Map<string, number[]>();

  /**
   * @param limit  how many hits are allowed inside the window
   * @param windowMs  the window, in milliseconds
   * @param maxKeys  the point at which idle keys are swept — see `sweep`
   */
  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 10_000,
  ) {}

  /**
   * Record an attempt and say whether it is allowed.
   *
   * A refused attempt is **not** recorded. Recording it would make a client that
   * keeps retrying extend its own ban indefinitely, which reads as a lockout —
   * and a lockout an attacker can trigger on a customer's behalf is the failure
   * this whole entry withdrew a feature over.
   */
  hit(key: string, now: number): Verdict {
    const window = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);

    if (window.length >= this.limit) {
      this.hits.set(key, window);
      return { allowed: false, retryAfterMs: this.windowMs - (now - window[0]!) };
    }

    window.push(now);
    this.hits.set(key, window);
    if (this.hits.size > this.maxKeys) this.sweep(now);
    return { allowed: true, retryAfterMs: 0 };
  }

  /** Whether a key is at its limit, without recording an attempt. */
  peek(key: string, now: number): Verdict {
    const window = (this.hits.get(key) ?? []).filter((t) => now - t < this.windowMs);
    return window.length >= this.limit
      ? { allowed: false, retryAfterMs: this.windowMs - (now - window[0]!) }
      : { allowed: true, retryAfterMs: 0 };
  }

  /**
   * Drop keys whose windows have emptied.
   *
   * **This is not a cap, and it is worth being exact about that.** It removes
   * keys that have *expired*; a flood of unique keys arriving inside one window
   * has expired nothing, so the map grows past `maxKeys` regardless. Writing
   * this as "bounded to maxKeys" would be a comment that a test then gets
   * written to agree with — the first version of the sweep test did exactly
   * that, spacing its hits 1ms apart inside a 1000ms window and asserting a
   * shrink that could not happen.
   *
   * What actually bounds the maps is the caller: `server.ts` checks the
   * per-audit allowance *before* touching any other key, so no map can gain a
   * key until an audit has spent twenty requests in an hour. The sweep is what
   * returns the memory afterwards, not what limits it.
   *
   * Swept on write rather than on a timer, so nothing keeps the process alive
   * that would not otherwise be awake.
   */
  private sweep(now: number): void {
    for (const [key, window] of this.hits) {
      if (window.every((t) => now - t >= this.windowMs)) this.hits.delete(key);
    }
  }

  /** Keys currently held. For tests and for the sweep's own assertions. */
  get size(): number {
    return this.hits.size;
  }
}

/** Whole minutes, rounded up, for a message a person reads. */
export function inMinutes(ms: number): string {
  const minutes = Math.ceil(ms / 60_000);
  return minutes === 1 ? "a minute" : `${minutes} minutes`;
}
