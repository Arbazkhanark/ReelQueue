import type { Rng } from './clock';
import type { ProviderError, ProviderErrorKind } from './errors';

export type ExecutionStep =
  | 'QUOTA_CHECK'
  | 'CREATE_CONTAINER'
  | 'POLL_STATUS'
  | 'PUBLISH'
  | 'RECONCILE'
  | 'CONFIRM';

export interface BackoffConfig {
  baseMs: number;
  factor: number;
  maxMs: number;
}

export const DEFAULT_BACKOFF: BackoffConfig = {
  baseMs: 15_000,
  factor: 2,
  maxMs: 15 * 60_000,
};

/**
 * Bounded exponential backoff with "equal jitter":
 *   cap   = min(maxMs, baseMs * factor^(attempt-1))
 *   delay = cap/2 + rng() * cap/2
 * so the delay is always within [cap/2, cap] and never exceeds maxMs.
 * `attempt` is 1-based (the attempt that just failed).
 */
export function computeBackoffMs(attempt: number, cfg: BackoffConfig, rng: Rng): number {
  const n = Math.max(1, Math.floor(attempt));
  const cap = Math.min(cfg.maxMs, cfg.baseMs * Math.pow(cfg.factor, n - 1));
  return Math.round(cap / 2 + rng() * (cap / 2));
}

/** Kinds for which a rejected `publish` call definitively did NOT publish. */
const DEFINITIVE_REJECTIONS: ReadonlySet<ProviderErrorKind> = new Set([
  'QUOTA_EXHAUSTED',
  'AUTH_EXPIRED',
  'PERMISSION_REVOKED',
  'MEDIA_REJECTED',
  'ACCOUNT_RESTRICTED',
  'VALIDATION',
]);

export type PauseReason = 'ACCOUNT_REAUTH_REQUIRED' | 'PERMISSION_REVOKED';

export type ErrorDecision = (
  | { action: 'RETRY'; delayMs: number }
  | { action: 'RECONCILE'; delayMs: number }
  | { action: 'DEFER'; delayMs: number; reason: string }
  | { action: 'PAUSE_CYCLE'; reason: PauseReason }
  | { action: 'FAIL'; retryable: boolean; reason: string }
) & {
  /**
   * True when, at the PUBLISH step, the error proves the publish did not happen,
   * so the persisted "publish requested" marker may be cleared safely.
   */
  clearPublishRequest: boolean;
};

export interface DecideArgs {
  error: ProviderError;
  step: ExecutionStep;
  /** Failed attempts recorded BEFORE this one. */
  attemptsSoFar: number;
  maxAttempts: number;
  backoff: BackoffConfig;
  rng: Rng;
  quotaRecheckMs: number;
  /** Delay before re-checking an uncertain publish (provider settle window). */
  settleMs: number;
}

/**
 * Central retry policy.
 *
 *  - Quota errors are never retried in a loop: the job is DEFERRED to the next
 *    quota recheck (not counted as a failed attempt).
 *  - Auth/permission errors pause the cycle (user must reconnect); no retry.
 *  - Media/validation/restriction errors are permanent; no retry.
 *  - Transient and rate-limit errors retry with bounded backoff + jitter and
 *    honour the provider's Retry-After; attempts are bounded.
 *  - At the PUBLISH step any ambiguous failure (timeout, unknown, transient)
 *    means the post MAY exist, so we RECONCILE before ever publishing again.
 */
export function decideOnError(args: DecideArgs): ErrorDecision {
  const { error, step } = args;
  const attemptNumber = args.attemptsSoFar + 1;
  const exhausted = attemptNumber >= args.maxAttempts;
  const atPublish = step === 'PUBLISH';
  const definitiveAtPublish = atPublish && DEFINITIVE_REJECTIONS.has(error.kind);
  const backoff = computeBackoffMs(attemptNumber, args.backoff, args.rng);
  const retryAfter = error.retryAfterMs ?? 0;

  switch (error.kind) {
    case 'QUOTA_EXHAUSTED':
      return {
        action: 'DEFER',
        delayMs: Math.max(args.quotaRecheckMs, retryAfter),
        reason: 'QUOTA_EXHAUSTED',
        clearPublishRequest: definitiveAtPublish,
      };

    case 'AUTH_EXPIRED':
      return { action: 'PAUSE_CYCLE', reason: 'ACCOUNT_REAUTH_REQUIRED', clearPublishRequest: definitiveAtPublish };

    case 'PERMISSION_REVOKED':
      return { action: 'PAUSE_CYCLE', reason: 'PERMISSION_REVOKED', clearPublishRequest: definitiveAtPublish };

    case 'MEDIA_REJECTED':
    case 'VALIDATION':
    case 'ACCOUNT_RESTRICTED':
      return {
        action: 'FAIL',
        retryable: false,
        reason: error.kind,
        clearPublishRequest: definitiveAtPublish,
      };

    case 'RATE_LIMITED':
    case 'TRANSIENT':
    case 'TIMEOUT':
    case 'UNKNOWN': {
      if (atPublish || step === 'RECONCILE') {
        // Outcome uncertain: never blind-retry a publish.
        if (exhausted) {
          return {
            action: 'FAIL',
            retryable: false, // manual retry could duplicate; user must verify first
            reason: 'PUBLISH_OUTCOME_UNKNOWN',
            clearPublishRequest: false,
          };
        }
        return {
          action: 'RECONCILE',
          delayMs: Math.max(args.settleMs, retryAfter, atPublish ? 0 : backoff),
          clearPublishRequest: false,
        };
      }
      if (exhausted) {
        return { action: 'FAIL', retryable: true, reason: 'RETRIES_EXHAUSTED', clearPublishRequest: false };
      }
      return {
        action: 'RETRY',
        delayMs: Math.max(backoff, retryAfter),
        clearPublishRequest: false,
      };
    }
  }
}
