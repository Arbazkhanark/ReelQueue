import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  SCHEDULER_LIMITS,
  addMinutes,
  computeCycleWindow,
  computeNextBatchAt,
  planBatchAgainstQuota,
  remainingQuota,
  validateSchedulerSettings,
  type PublishQuota,
} from '../src';

const T = new Date('2026-10-14T10:00:00.000Z');
const quota = (used: number, total: number): PublishQuota => ({
  used,
  total,
  windowSeconds: 86_400,
  fetchedAt: T,
});

describe('scheduler settings validation', () => {
  it('applies documented defaults: 20 minute interval, 24 hour cycle, loop off', () => {
    const r = validateSchedulerSettings({});
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.value.intervalMinutes, 20);
      assert.equal(r.value.cycleDurationHours, 24);
      assert.equal(r.value.batchSize, 1);
      assert.equal(r.value.loopEnabled, false);
    }
  });

  it('accepts boundary values', () => {
    const lo = validateSchedulerSettings({ batchSize: 1, intervalMinutes: SCHEDULER_LIMITS.intervalMinutes.min, cycleDurationHours: 1 });
    const hi = validateSchedulerSettings({
      batchSize: SCHEDULER_LIMITS.batchSize.max,
      intervalMinutes: SCHEDULER_LIMITS.intervalMinutes.max,
      cycleDurationHours: SCHEDULER_LIMITS.cycleDurationHours.max,
    });
    assert.equal(lo.ok, true);
    assert.equal(hi.ok, true);
  });

  it('rejects out-of-range, non-integer and wrongly typed values', () => {
    const cases: [Record<string, unknown>, string, string][] = [
      [{ batchSize: 0 }, 'batchSize', 'OUT_OF_RANGE'],
      [{ batchSize: -3 }, 'batchSize', 'OUT_OF_RANGE'],
      [{ batchSize: SCHEDULER_LIMITS.batchSize.max + 1 }, 'batchSize', 'OUT_OF_RANGE'],
      [{ batchSize: 1.5 }, 'batchSize', 'NOT_INTEGER'],
      [{ batchSize: '5' }, 'batchSize', 'NOT_INTEGER'],
      [{ batchSize: Number.NaN }, 'batchSize', 'NOT_INTEGER'],
      [{ intervalMinutes: SCHEDULER_LIMITS.intervalMinutes.min - 1 }, 'intervalMinutes', 'OUT_OF_RANGE'],
      [{ intervalMinutes: SCHEDULER_LIMITS.intervalMinutes.max + 1 }, 'intervalMinutes', 'OUT_OF_RANGE'],
      [{ cycleDurationHours: 0 }, 'cycleDurationHours', 'OUT_OF_RANGE'],
      [{ loopEnabled: 'yes' }, 'loopEnabled', 'NOT_BOOLEAN'],
    ];
    for (const [input, field, code] of cases) {
      const r = validateSchedulerSettings(input);
      assert.equal(r.ok, false, JSON.stringify(input));
      if (!r.ok) assert.ok(r.errors.some((e) => e.field === field && e.code === code), JSON.stringify(input));
    }
  });

  it('reports every invalid field at once', () => {
    const r = validateSchedulerSettings({ batchSize: 0, intervalMinutes: 1, loopEnabled: 1 });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.errors.length, 3);
  });
});

describe('cycle window and interval semantics', () => {
  it('endsAt = startedAt + duration (fixed wall-clock instant)', () => {
    const w = computeCycleWindow(T, 24);
    assert.equal(w.endsAt.toISOString(), '2026-10-15T10:00:00.000Z');
  });

  it('interval is measured between batch STARTS (fixed-rate, no drift from late execution)', () => {
    const next = computeNextBatchAt({
      previousScheduledFor: T,
      intervalMinutes: 20,
      now: new Date(T.getTime() + 5_000), // ran 5s late
      endsAt: addMinutes(T, 24 * 60),
    });
    assert.equal(next?.toISOString(), '2026-10-14T10:20:00.000Z');
  });

  it('does not burst-replay missed slots after downtime: next batch is released at now', () => {
    const now = new Date('2026-10-14T12:00:00.000Z');
    const next = computeNextBatchAt({
      previousScheduledFor: T,
      intervalMinutes: 20,
      now,
      endsAt: addMinutes(T, 24 * 60),
    });
    assert.equal(next?.toISOString(), now.toISOString());
  });

  it('returns null when the next batch would not start strictly before the cycle end', () => {
    const endsAt = addMinutes(T, 20);
    assert.equal(computeNextBatchAt({ previousScheduledFor: T, intervalMinutes: 20, now: T, endsAt }), null);
    assert.equal(
      computeNextBatchAt({ previousScheduledFor: T, intervalMinutes: 20, now: T, endsAt: addMinutes(T, 21) })?.toISOString(),
      addMinutes(T, 20).toISOString(),
    );
  });
});

describe('quota planning (fail-closed, never hardcoded)', () => {
  const base = { reserve: 0, now: T, recheckMinutes: 15 };

  it('allows the full batch when quota is sufficient', () => {
    const p = planBatchAgainstQuota({ ...base, requested: 5, quota: quota(0, 25) });
    assert.deepEqual([p.allowed, p.deferred, p.reason, p.recheckAt], [5, 0, 'NONE', null]);
  });

  it('trims the batch to the remaining quota and reports the deferral', () => {
    const p = planBatchAgainstQuota({ ...base, requested: 5, quota: quota(23, 25) });
    assert.deepEqual([p.allowed, p.deferred, p.reason, p.remaining], [2, 3, 'QUOTA_PARTIAL', 2]);
  });

  it('allows nothing when exhausted and schedules a recheck', () => {
    const p = planBatchAgainstQuota({ ...base, requested: 5, quota: quota(25, 25) });
    assert.equal(p.allowed, 0);
    assert.equal(p.reason, 'QUOTA_EXHAUSTED');
    assert.equal(p.recheckAt?.toISOString(), '2026-10-14T10:15:00.000Z');
  });

  it('never goes negative when used exceeds total', () => {
    assert.equal(remainingQuota(quota(30, 25)), 0);
  });

  it('honours a safety reserve', () => {
    const p = planBatchAgainstQuota({ ...base, reserve: 2, requested: 5, quota: quota(20, 25) });
    assert.equal(p.allowed, 3);
  });

  it('fails closed on unknown or invalid quota data', () => {
    for (const q of [null, undefined, quota(Number.NaN, 25), quota(0, 0), quota(-1, 25), { ...quota(0, 25), windowSeconds: 0 }]) {
      const p = planBatchAgainstQuota({ ...base, requested: 5, quota: q });
      assert.equal(p.allowed, 0);
      assert.equal(p.reason, 'QUOTA_UNKNOWN');
    }
  });
});
