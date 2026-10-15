/**
 * Publishing quota as reported by the provider for ONE account.
 * Values come from the API (e.g. Instagram's content_publishing_limit endpoint)
 * and are never hardcoded. Meta's own documentation is inconsistent about the
 * per-24h total, which is exactly why this is read at runtime.
 */
export interface PublishQuota {
  used: number;
  total: number;
  windowSeconds: number;
  fetchedAt: Date;
}

export type QuotaLimitReason = 'NONE' | 'QUOTA_PARTIAL' | 'QUOTA_EXHAUSTED' | 'QUOTA_UNKNOWN';

export interface QuotaPlan {
  /** How many publications may start now. */
  allowed: number;
  /** How many of the requested publications must wait. */
  deferred: number;
  reason: QuotaLimitReason;
  remaining: number | null;
  /** When to look at the quota again (only set when nothing is allowed). */
  recheckAt: Date | null;
}

export function isValidQuota(q: PublishQuota | null | undefined): q is PublishQuota {
  return (
    !!q &&
    Number.isFinite(q.used) &&
    Number.isFinite(q.total) &&
    Number.isFinite(q.windowSeconds) &&
    q.used >= 0 &&
    q.total > 0 &&
    q.windowSeconds > 0
  );
}

/** Remaining capacity after subtracting a safety reserve. Never negative. */
export function remainingQuota(q: PublishQuota, reserve = 0): number {
  return Math.max(0, Math.floor(q.total - q.used - reserve));
}

/**
 * Fail-closed quota planning: if the quota is unknown or invalid we publish
 * nothing and re-check later, rather than guessing.
 */
export function planBatchAgainstQuota(args: {
  requested: number;
  quota: PublishQuota | null | undefined;
  reserve: number;
  now: Date;
  recheckMinutes: number;
}): QuotaPlan {
  const recheckAt = new Date(args.now.getTime() + args.recheckMinutes * 60_000);

  if (!isValidQuota(args.quota)) {
    return {
      allowed: 0,
      deferred: args.requested,
      reason: 'QUOTA_UNKNOWN',
      remaining: null,
      recheckAt,
    };
  }

  const remaining = remainingQuota(args.quota, args.reserve);
  const allowed = Math.min(args.requested, remaining);

  if (allowed === 0) {
    return {
      allowed: 0,
      deferred: args.requested,
      reason: 'QUOTA_EXHAUSTED',
      remaining,
      recheckAt,
    };
  }

  return {
    allowed,
    deferred: args.requested - allowed,
    reason: allowed < args.requested ? 'QUOTA_PARTIAL' : 'NONE',
    remaining,
    recheckAt: null,
  };
}
