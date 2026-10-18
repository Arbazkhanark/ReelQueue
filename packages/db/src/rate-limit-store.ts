import type { RateLimitStore } from '@reelqueue/core';
import { toDate, toNum, type SqlExecutor } from './sql';

/**
 * Fixed-window counters in PostgreSQL, shared by every API replica. One atomic upsert per hit: the window rolls over
 * inside the same statement, so concurrent replicas cannot lose increments or double-reset a window.
 */
export class PgRateLimitStore implements RateLimitStore {
  constructor(private readonly db: SqlExecutor) {}
  async hit(key: string, windowMs: number, now: Date): Promise<{ count: number; resetAt: Date }> {
    const ends = new Date(now.getTime() + windowMs);
    const r = (await this.db.query(
      `INSERT INTO rate_limits (key, window_ends_at, count) VALUES ($1, $2, 1)
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN rate_limits.window_ends_at <= $3 THEN 1 ELSE rate_limits.count + 1 END,
         window_ends_at = CASE WHEN rate_limits.window_ends_at <= $3 THEN $2 ELSE rate_limits.window_ends_at END
       RETURNING count, window_ends_at`, [key, ends, now]))[0]!;
    return { count: toNum(r.count), resetAt: toDate(r.window_ends_at) };
  }
  /** Housekeeping for a worker timer: rows of finished windows. */
  async purgeExpired(now: Date): Promise<number> {
    return this.db.exec(`DELETE FROM rate_limits WHERE window_ends_at <= $1`, [now]);
  }
}

/**
 * If the shared store is unavailable, keep limiting with a per-replica store instead of failing every request or
 * silently disabling the limits. Degraded mode is reported through `onDegraded` (rate-limited by the caller's logger).
 */
export class FallbackRateLimitStore implements RateLimitStore {
  constructor(private readonly primary: RateLimitStore, private readonly fallback: RateLimitStore, private readonly onDegraded: (err: unknown) => void = () => undefined) {}
  async hit(key: string, windowMs: number, now: Date): Promise<{ count: number; resetAt: Date }> {
    try { return await this.primary.hit(key, windowMs, now); }
    catch (err) { this.onDegraded(err); return this.fallback.hit(key, windowMs, now); }
  }
}
