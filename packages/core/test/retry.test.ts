import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_BACKOFF,
  ProviderError,
  computeBackoffMs,
  decideOnError,
  seededRng,
  type DecideArgs,
  type ExecutionStep,
  type ProviderErrorKind,
} from '../src';

const args = (kind: ProviderErrorKind, step: ExecutionStep, over: Partial<DecideArgs> = {}, errOpts = {}): DecideArgs => ({
  error: new ProviderError(kind, 'x', errOpts),
  step,
  attemptsSoFar: 0,
  maxAttempts: 5,
  backoff: DEFAULT_BACKOFF,
  rng: seededRng(7),
  quotaRecheckMs: 15 * 60_000,
  settleMs: 60_000,
  ...over,
});

describe('backoff', () => {
  it('stays within [cap/2, cap] and never exceeds maxMs, for many seeds', () => {
    for (let seed = 1; seed <= 200; seed++) {
      const rng = seededRng(seed);
      for (let attempt = 1; attempt <= 12; attempt++) {
        const cap = Math.min(DEFAULT_BACKOFF.maxMs, DEFAULT_BACKOFF.baseMs * 2 ** (attempt - 1));
        const d = computeBackoffMs(attempt, DEFAULT_BACKOFF, rng);
        assert.ok(d >= Math.floor(cap / 2) && d <= cap, `attempt ${attempt} delay ${d} cap ${cap}`);
        assert.ok(d <= DEFAULT_BACKOFF.maxMs);
      }
    }
  });

  it('grows exponentially until the cap', () => {
    const fixed = () => 0; // lower bound of jitter
    const ds = [1, 2, 3, 4, 5, 6, 7, 8].map((a) => computeBackoffMs(a, DEFAULT_BACKOFF, fixed));
    for (let i = 1; i < ds.length; i++) assert.ok(ds[i]! >= ds[i - 1]!);
    assert.equal(computeBackoffMs(20, DEFAULT_BACKOFF, () => 0.999999), DEFAULT_BACKOFF.maxMs);
  });

  it('is deterministic for a given seed', () => {
    assert.equal(computeBackoffMs(3, DEFAULT_BACKOFF, seededRng(5)), computeBackoffMs(3, DEFAULT_BACKOFF, seededRng(5)));
  });
});

describe('retry classification', () => {
  it('retries transient errors with backoff, counting attempts', () => {
    const d = decideOnError(args('TRANSIENT', 'CREATE_CONTAINER'));
    assert.equal(d.action, 'RETRY');
    if (d.action === 'RETRY') assert.ok(d.delayMs > 0 && d.delayMs <= DEFAULT_BACKOFF.maxMs);
  });

  it('honours Retry-After when it exceeds the backoff', () => {
    const d = decideOnError(args('RATE_LIMITED', 'CREATE_CONTAINER', {}, { retryAfterMs: 3_600_000 }));
    assert.equal(d.action, 'RETRY');
    if (d.action === 'RETRY') assert.ok(d.delayMs >= 3_600_000);
  });

  it('defers (never loops on) quota exhaustion', () => {
    const d = decideOnError(args('QUOTA_EXHAUSTED', 'QUOTA_CHECK'));
    assert.equal(d.action, 'DEFER');
    if (d.action === 'DEFER') assert.ok(d.delayMs >= 15 * 60_000);
    // even with attempts already exhausted, quota is a deferral, not a failure
    assert.equal(decideOnError(args('QUOTA_EXHAUSTED', 'CREATE_CONTAINER', { attemptsSoFar: 99 })).action, 'DEFER');
  });

  it('pauses the cycle (no retry) for expired tokens and revoked permissions', () => {
    const a = decideOnError(args('AUTH_EXPIRED', 'CREATE_CONTAINER'));
    const p = decideOnError(args('PERMISSION_REVOKED', 'PUBLISH'));
    assert.deepEqual(a.action === 'PAUSE_CYCLE' && a.reason, 'ACCOUNT_REAUTH_REQUIRED');
    assert.deepEqual(p.action === 'PAUSE_CYCLE' && p.reason, 'PERMISSION_REVOKED');
  });

  it('fails permanently, without retry, on rejected media / validation / restricted account', () => {
    for (const kind of ['MEDIA_REJECTED', 'VALIDATION', 'ACCOUNT_RESTRICTED'] as const) {
      const d = decideOnError(args(kind, 'POLL_STATUS'));
      assert.equal(d.action, 'FAIL');
      if (d.action === 'FAIL') assert.equal(d.retryable, false);
    }
  });

  it('marks retries-exhausted transient failures as manually retryable', () => {
    const d = decideOnError(args('TRANSIENT', 'CREATE_CONTAINER', { attemptsSoFar: 4, maxAttempts: 5 }));
    assert.equal(d.action, 'FAIL');
    if (d.action === 'FAIL') {
      assert.equal(d.retryable, true);
      assert.equal(d.reason, 'RETRIES_EXHAUSTED');
    }
  });

  it('never blind-retries a publish: ambiguous errors at PUBLISH reconcile first', () => {
    for (const kind of ['TIMEOUT', 'TRANSIENT', 'UNKNOWN', 'RATE_LIMITED'] as const) {
      const d = decideOnError(args(kind, 'PUBLISH'));
      assert.equal(d.action, 'RECONCILE', kind);
      if (d.action === 'RECONCILE') {
        assert.ok(d.delayMs >= 60_000, 'waits at least the settle window');
        assert.equal(d.clearPublishRequest, false, 'publish marker must be kept: outcome unknown');
      }
    }
  });

  it('clears the publish marker only for definitive rejections at PUBLISH', () => {
    assert.equal(decideOnError(args('QUOTA_EXHAUSTED', 'PUBLISH')).clearPublishRequest, true);
    assert.equal(decideOnError(args('AUTH_EXPIRED', 'PUBLISH')).clearPublishRequest, true);
    assert.equal(decideOnError(args('MEDIA_REJECTED', 'PUBLISH')).clearPublishRequest, true);
    assert.equal(decideOnError(args('QUOTA_EXHAUSTED', 'CREATE_CONTAINER')).clearPublishRequest, false);
  });

  it('exhausted uncertain publish fails NON-retryable so a manual retry cannot duplicate', () => {
    const d = decideOnError(args('TIMEOUT', 'PUBLISH', { attemptsSoFar: 4, maxAttempts: 5 }));
    assert.equal(d.action, 'FAIL');
    if (d.action === 'FAIL') {
      assert.equal(d.retryable, false);
      assert.equal(d.reason, 'PUBLISH_OUTCOME_UNKNOWN');
      assert.equal(d.clearPublishRequest, false);
    }
  });
});
