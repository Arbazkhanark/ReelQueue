export interface RateLimitDecision { allowed: boolean; remaining: number; resetAt: Date; retryAfterSeconds: number }
/** Fixed-window counter store. In production a Redis-backed implementation (INCR + PEXPIRE) shares counts across API instances. */
export interface RateLimitStore { hit(key: string, windowMs: number, now: Date): Promise<{ count: number; resetAt: Date }> }

export class MemoryRateLimitStore implements RateLimitStore {
  private readonly m = new Map<string, { count: number; resetAt: number }>();
  constructor(private readonly maxKeys = 50_000) {}
  async hit(key: string, windowMs: number, now: Date) {
    const t = now.getTime();
    let e = this.m.get(key);
    if (!e || e.resetAt <= t) {
      if (this.m.size >= this.maxKeys) for (const [k, v] of this.m) if (v.resetAt <= t) this.m.delete(k);
      if (this.m.size >= this.maxKeys) this.m.clear(); // bounded memory beats unbounded growth under a key-flood
      e = { count: 0, resetAt: t + windowMs };
      this.m.set(key, e);
    }
    e.count += 1;
    return { count: e.count, resetAt: new Date(e.resetAt) };
  }
}

export class RateLimiter {
  constructor(private readonly store: RateLimitStore, private readonly now: () => Date) {}
  async check(key: string, limit: number, windowMs: number): Promise<RateLimitDecision> {
    const now = this.now();
    const { count, resetAt } = await this.store.hit(key, windowMs, now);
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt, retryAfterSeconds: Math.max(1, Math.ceil((resetAt.getTime() - now.getTime()) / 1000)) };
  }
}
