import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  INITIAL_CURSOR,
  JOB_STATUSES,
  TERMINAL_JOB_STATUSES,
  applyCycleCommand,
  assertTransition,
  blocksLaterJobs,
  canStartNewPublication,
  canTransition,
  effectiveStatus,
  InvalidTransitionError,
  makeIdempotencyKey,
  selectBatch,
  type CycleState,
  type CycleStatus,
  type QueueVideo,
} from '../src';

const vids = (...ids: string[]): QueueVideo[] => ids.map((id, i) => ({ id, position: i }));

describe('video ordering and queue cursor', () => {
  it('releases videos strictly in position order regardless of input order', () => {
    const shuffled: QueueVideo[] = [
      { id: 'c', position: 2 },
      { id: 'a', position: 0 },
      { id: 'b', position: 1 },
    ];
    const s = selectBatch({ videos: shuffled, state: INITIAL_CURSOR, size: 3, loopEnabled: false });
    assert.deepEqual(s.items.map((i) => i.videoId), ['a', 'b', 'c']);
  });

  it('advances the cursor across batches without repeating or skipping', () => {
    const v = vids('a', 'b', 'c', 'd', 'e');
    const s1 = selectBatch({ videos: v, state: INITIAL_CURSOR, size: 2, loopEnabled: false });
    const s2 = selectBatch({ videos: v, state: s1.next, size: 2, loopEnabled: false });
    const s3 = selectBatch({ videos: v, state: s2.next, size: 2, loopEnabled: false });
    assert.deepEqual(s1.items.map((i) => i.videoId), ['a', 'b']);
    assert.deepEqual(s2.items.map((i) => i.videoId), ['c', 'd']);
    assert.deepEqual(s3.items.map((i) => i.videoId), ['e']);
    assert.equal(s3.drainedAfter, true);
    assert.equal(s1.drainedAfter, false);
  });

  it('without loop it stops at the end of the queue', () => {
    const v = vids('a', 'b');
    const s1 = selectBatch({ videos: v, state: INITIAL_CURSOR, size: 5, loopEnabled: false });
    assert.equal(s1.items.length, 2);
    const s2 = selectBatch({ videos: v, state: s1.next, size: 5, loopEnabled: false });
    assert.equal(s2.items.length, 0);
  });

  it('with loop it restarts from position 1 and increments the iteration', () => {
    const v = vids('a', 'b', 'c');
    const s1 = selectBatch({ videos: v, state: INITIAL_CURSOR, size: 3, loopEnabled: true });
    assert.deepEqual(s1.items.map((i) => [i.videoId, i.iteration]), [['a', 1], ['b', 1], ['c', 1]]);
    assert.equal(s1.drainedAfter, false, 'a looping queue never drains');
    const s2 = selectBatch({ videos: v, state: s1.next, size: 2, loopEnabled: true });
    assert.deepEqual(s2.items.map((i) => [i.videoId, i.iteration]), [['a', 2], ['b', 2]]);
    assert.equal(s2.wrapped, true);
  });

  it('a batch wrapping the end continues from the start and never repeats a video', () => {
    const v = vids('a', 'b', 'c');
    const s = selectBatch({ videos: v, state: { lastPosition: 1, iteration: 1 }, size: 3, loopEnabled: true });
    assert.deepEqual(s.items.map((i) => [i.videoId, i.iteration]), [['c', 1], ['a', 2], ['b', 2]]);
    assert.equal(new Set(s.items.map((i) => i.videoId)).size, 3);
  });

  it('caps the batch at the number of eligible videos (no duplicates within a batch)', () => {
    const s = selectBatch({ videos: vids('a', 'b'), state: INITIAL_CURSOR, size: 10, loopEnabled: true });
    assert.deepEqual(s.items.map((i) => i.videoId), ['a', 'b']);
  });

  it('is robust to reordering, insertion and deletion while a cycle runs (cursor is positional)', () => {
    // 'a','b' already released (lastPosition 1). Then: delete 'c', insert 'x' at 1.5, 'y' at 9.
    const after: QueueVideo[] = [
      { id: 'a', position: 0 },
      { id: 'b', position: 1 },
      { id: 'x', position: 1.5 },
      { id: 'd', position: 3 },
      { id: 'y', position: 9 },
    ];
    const s = selectBatch({ videos: after, state: { lastPosition: 1, iteration: 1 }, size: 3, loopEnabled: false });
    assert.deepEqual(s.items.map((i) => i.videoId), ['x', 'd', 'y']);
  });

  it('handles an empty queue', () => {
    const s = selectBatch({ videos: [], state: INITIAL_CURSOR, size: 3, loopEnabled: true });
    assert.equal(s.items.length, 0);
  });
});

const T = new Date('2026-10-14T10:00:00.000Z');
const cycle = (status: CycleStatus): CycleState => ({
  status,
  startedAt: T,
  endsAt: new Date(T.getTime() + 24 * 3_600_000),
});
const inside = new Date(T.getTime() + 3_600_000);
const after = new Date(T.getTime() + 25 * 3_600_000);

describe('cycle state machine', () => {
  it('allows the documented transitions', () => {
    assert.deepEqual(applyCycleCommand(cycle('ACTIVE'), 'PAUSE', inside), { ok: true, status: 'PAUSED' });
    assert.deepEqual(applyCycleCommand(cycle('PAUSED'), 'RESUME', inside), { ok: true, status: 'ACTIVE' });
    assert.deepEqual(applyCycleCommand(cycle('ACTIVE'), 'STOP', inside), { ok: true, status: 'STOPPED' });
    assert.deepEqual(applyCycleCommand(cycle('PAUSED'), 'STOP', inside), { ok: true, status: 'STOPPED' });
    assert.deepEqual(applyCycleCommand(cycle('ACTIVE'), 'COMPLETE', inside), { ok: true, status: 'COMPLETED' });
  });

  it('rejects illegal transitions, including repeating a command', () => {
    const bad: [CycleStatus, Parameters<typeof applyCycleCommand>[1]][] = [
      ['PAUSED', 'PAUSE'],
      ['ACTIVE', 'RESUME'],
      ['STOPPED', 'RESUME'],
      ['STOPPED', 'STOP'],
      ['STOPPED', 'PAUSE'],
      ['COMPLETED', 'RESUME'],
      ['EXPIRED', 'RESUME'],
    ];
    for (const [status, cmd] of bad) {
      const r = applyCycleCommand(cycle(status), cmd, inside);
      assert.equal(r.ok, false, `${status} + ${cmd}`);
    }
  });

  it('treats an ACTIVE/PAUSED cycle past endsAt as EXPIRED even if the expiry job is late', () => {
    assert.equal(effectiveStatus(cycle('ACTIVE'), after), 'EXPIRED');
    assert.equal(effectiveStatus(cycle('PAUSED'), after), 'EXPIRED');
    assert.equal(effectiveStatus(cycle('STOPPED'), after), 'STOPPED');
  });

  it('allows publication strictly before endsAt only, and only while ACTIVE', () => {
    const c = cycle('ACTIVE');
    assert.equal(canStartNewPublication(c, inside), true);
    assert.equal(canStartNewPublication(c, new Date(c.endsAt.getTime() - 1)), true);
    assert.equal(canStartNewPublication(c, c.endsAt), false);
    assert.equal(canStartNewPublication(cycle('PAUSED'), inside), false);
    assert.equal(canStartNewPublication(cycle('STOPPED'), inside), false);
  });

  it('refuses to resume a cycle whose window has elapsed', () => {
    const r = applyCycleCommand(cycle('PAUSED'), 'RESUME', after);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 'CYCLE_EXPIRED');
  });

  it('pausing does not extend the window', () => {
    const c = cycle('PAUSED');
    assert.equal(c.endsAt.getTime() - c.startedAt.getTime(), 24 * 3_600_000);
    assert.equal(canStartNewPublication({ ...c, status: 'ACTIVE' }, after), false);
  });

  it('a late stop on an elapsed cycle is still recorded', () => {
    assert.deepEqual(applyCycleCommand(cycle('ACTIVE'), 'STOP', after), { ok: true, status: 'STOPPED' });
  });
});

describe('job state machine and idempotency', () => {
  it('terminal success states are final', () => {
    for (const s of ['CONFIRMED', 'SIMULATED', 'CANCELLED', 'EXPIRED'] as const) {
      for (const to of JOB_STATUSES) assert.equal(canTransition(s, to), false, `${s}->${to}`);
    }
  });

  it('FAILED can only go back to SCHEDULED (manual retry)', () => {
    const allowed = JOB_STATUSES.filter((to) => canTransition('FAILED', to));
    assert.deepEqual(allowed, ['SCHEDULED']);
  });

  it('cannot cancel or expire once a publish has been requested', () => {
    assert.equal(canTransition('PUBLISH_REQUESTED', 'CANCELLED'), false);
    assert.equal(canTransition('PUBLISH_REQUESTED', 'EXPIRED'), false);
    assert.equal(canTransition('PROCESSING_MEDIA', 'CANCELLED'), true);
  });

  it('API-accepted can only progress to confirmed; it can never be un-published or failed', () => {
    const allowed = JOB_STATUSES.filter((to) => canTransition('ACCEPTED', to));
    assert.deepEqual(allowed.sort(), ['ACCEPTED', 'CONFIRMED']);
  });

  it('assertTransition throws a typed error on illegal moves', () => {
    assert.throws(() => assertTransition('CONFIRMED', 'SCHEDULED'), InvalidTransitionError);
    assert.doesNotThrow(() => assertTransition('SCHEDULED', 'CREATING_CONTAINER'));
  });

  it('only non-terminal, not-yet-published jobs block later jobs of the same account', () => {
    assert.equal(blocksLaterJobs('SCHEDULED'), true);
    assert.equal(blocksLaterJobs('DEFERRED'), true);
    assert.equal(blocksLaterJobs('PUBLISH_REQUESTED'), true);
    assert.equal(blocksLaterJobs('ACCEPTED'), false);
    for (const s of TERMINAL_JOB_STATUSES) assert.equal(blocksLaterJobs(s), false);
  });

  it('idempotency key is deterministic and unique per (cycle, video, iteration)', () => {
    const k = makeIdempotencyKey('c1', 'v1', 1);
    assert.equal(k, makeIdempotencyKey('c1', 'v1', 1));
    assert.notEqual(k, makeIdempotencyKey('c1', 'v1', 2));
    assert.notEqual(k, makeIdempotencyKey('c1', 'v2', 1));
    assert.notEqual(k, makeIdempotencyKey('c2', 'v1', 1));
    assert.match(k, /^[0-9a-f]{64}$/);
  });
});
