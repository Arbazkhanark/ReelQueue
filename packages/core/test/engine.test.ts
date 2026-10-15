import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_CURSOR,
  planTick,
  type PublishQuota,
  type QueueVideo,
  type TickDecision,
  type TickInput,
} from '../src';

const T = new Date('2026-10-14T10:00:00.000Z');
const H = 3_600_000;
const M = 60_000;

const videos = (n: number): QueueVideo[] => Array.from({ length: n }, (_, i) => ({ id: `v${i}`, position: i }));
const quota = (used: number, total: number): PublishQuota => ({ used, total, windowSeconds: 86_400, fetchedAt: T });

function input(over: Partial<Omit<TickInput, 'cycle'>> & { cycle?: Partial<TickInput['cycle']> } = {}): TickInput {
  const { cycle, ...rest } = over;
  return {
    now: T,
    cycle: {
      status: 'ACTIVE',
      startedAt: T,
      endsAt: new Date(T.getTime() + 24 * H),
      nextBatchAt: T,
      cursor: INITIAL_CURSOR,
      ...cycle,
    },
    settings: { batchSize: 3, intervalMinutes: 20, loopEnabled: false },
    videos: videos(10),
    unresolvedJobs: 0,
    quota: quota(0, 25),
    quotaReserve: 0,
    quotaRecheckMinutes: 15,
    backpressureRecheckSeconds: 60,
    ...rest,
  };
}

function batch(d: TickDecision) {
  assert.equal(d.type, 'SCHEDULE_BATCH', JSON.stringify(d));
  if (d.type !== 'SCHEDULE_BATCH') throw new Error('unreachable');
  return d;
}

describe('planTick', () => {
  it('schedules a full batch and the next batch exactly one interval after this batch start', () => {
    const d = batch(planTick(input()));
    assert.deepEqual(d.items.map((i) => i.videoId), ['v0', 'v1', 'v2']);
    assert.equal(d.nextBatchAt?.toISOString(), '2026-10-14T10:20:00.000Z');
    assert.equal(d.quotaLimited, false);
    assert.deepEqual(d.cursorAfter, { lastPosition: 2, iteration: 1 });
  });

  it('keeps a fixed-rate cadence when the tick runs slightly late', () => {
    const d = batch(planTick(input({ now: new Date(T.getTime() + 7_000) })));
    assert.equal(d.nextBatchAt?.toISOString(), '2026-10-14T10:20:00.000Z');
  });

  it('after downtime releases ONE batch now, not a burst of the missed slots', () => {
    const now = new Date(T.getTime() + 5 * H);
    const d = batch(planTick(input({ now })));
    assert.equal(d.items.length, 3);
    assert.equal(d.nextBatchAt?.toISOString(), now.toISOString());
  });

  it('is not due before nextBatchAt', () => {
    const d = planTick(input({ now: T, cycle: { nextBatchAt: new Date(T.getTime() + 10 * M) } }));
    assert.deepEqual(d, { type: 'NOT_DUE', runAt: new Date(T.getTime() + 10 * M) });
  });

  it('applies backpressure while earlier jobs are unresolved (no overlapping batches)', () => {
    const d = planTick(input({ unresolvedJobs: 2 }));
    assert.equal(d.type, 'BACKPRESSURE');
    if (d.type === 'BACKPRESSURE') assert.equal(d.runAt.getTime(), T.getTime() + 60_000);
  });

  it('trims the batch to the remaining quota and records the deferral', () => {
    const d = batch(planTick(input({ quota: quota(24, 25) })));
    assert.equal(d.items.length, 1);
    assert.equal(d.quotaLimited, true);
    assert.equal(d.deferredByQuota, 2);
    // deferred videos are NOT consumed: cursor only moves past released videos
    assert.deepEqual(d.cursorAfter, { lastPosition: 0, iteration: 1 });
  });

  it('defers entirely when the quota is exhausted, preserving the queue', () => {
    const d = planTick(input({ quota: quota(25, 25) }));
    assert.equal(d.type, 'QUOTA_DEFER');
    if (d.type === 'QUOTA_DEFER') {
      assert.equal(d.reason, 'QUOTA_EXHAUSTED');
      assert.equal(d.runAt.toISOString(), '2026-10-14T10:15:00.000Z');
    }
  });

  it('fails closed when the quota is unknown', () => {
    const d = planTick(input({ quota: null }));
    assert.equal(d.type, 'QUOTA_DEFER');
    if (d.type === 'QUOTA_DEFER') assert.equal(d.reason, 'QUOTA_UNKNOWN');
  });

  it('expires an overdue cycle and stops scheduling at the end instant', () => {
    const endsAt = new Date(T.getTime() + 24 * H);
    assert.deepEqual(planTick(input({ now: endsAt, cycle: { endsAt } })), { type: 'EXPIRE' });
    assert.deepEqual(planTick(input({ now: new Date(endsAt.getTime() + H), cycle: { endsAt } })), { type: 'EXPIRE' });
  });

  it('does nothing for paused, stopped, completed or already expired cycles', () => {
    assert.deepEqual(planTick(input({ cycle: { status: 'PAUSED' } })), { type: 'IDLE', reason: 'PAUSED' });
    for (const status of ['STOPPED', 'COMPLETED', 'EXPIRED'] as const) {
      assert.deepEqual(planTick(input({ cycle: { status } })), { type: 'IDLE', reason: 'ENDED' });
    }
  });

  it('a paused cycle that has passed endsAt is expired, not left paused forever', () => {
    const endsAt = new Date(T.getTime() + 24 * H);
    assert.deepEqual(planTick(input({ now: endsAt, cycle: { status: 'PAUSED', endsAt } })), { type: 'EXPIRE' });
  });

  it('returns null nextBatchAt when the next slot would be at/after the cycle end', () => {
    const endsAt = new Date(T.getTime() + 10 * M);
    const d = batch(planTick(input({ cycle: { endsAt } })));
    assert.equal(d.nextBatchAt, null);
  });

  it('completes when the queue is drained and looping is off', () => {
    const d = planTick(input({ videos: videos(3), cycle: { cursor: { lastPosition: 2, iteration: 1 } } }));
    assert.deepEqual(d, { type: 'COMPLETE', reason: 'QUEUE_DRAINED' });
  });

  it('restarts from the first video when looping is on and the cycle is still active', () => {
    const d = batch(
      planTick(
        input({
          videos: videos(3),
          settings: { batchSize: 2, intervalMinutes: 20, loopEnabled: true },
          cycle: { cursor: { lastPosition: 2, iteration: 1 } },
        }),
      ),
    );
    assert.deepEqual(d.items.map((i) => [i.videoId, i.iteration]), [['v0', 2], ['v1', 2]]);
    assert.deepEqual(d.cursorAfter, { lastPosition: 1, iteration: 2 });
  });

  it('never restarts a looping queue once the cycle has ended', () => {
    const endsAt = new Date(T.getTime() + 24 * H);
    const d = planTick(
      input({
        now: new Date(endsAt.getTime() + M),
        videos: videos(3),
        settings: { batchSize: 2, intervalMinutes: 20, loopEnabled: true },
        cycle: { endsAt, cursor: { lastPosition: 2, iteration: 4 } },
      }),
    );
    assert.equal(d.type, 'EXPIRE');
  });

  it('completes immediately for an empty queue', () => {
    assert.deepEqual(planTick(input({ videos: [] })), { type: 'COMPLETE', reason: 'EMPTY_QUEUE' });
  });

  it('caps the batch at the number of eligible videos', () => {
    const d = batch(planTick(input({ videos: videos(2), settings: { batchSize: 50, intervalMinutes: 20, loopEnabled: false } })));
    assert.equal(d.items.length, 2);
  });
});
