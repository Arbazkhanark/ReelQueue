import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { PublishQuota } from '@reelqueue/core';
import { PgJobStore, SchedulerStore, type CycleRow } from '../src';
import { freshDatabase, seedTenant, type Seed } from './helpers/fixtures';
import type { PsqlPool } from './helpers/psql-executor';
import type { SqlExecutor } from '../src/sql';

const T0 = new Date('2026-10-14T10:00:00.000Z');
const MIN = 60_000;
const at = (m: number) => new Date(T0.getTime() + m * MIN);
const quota = (used: number, total = 25): PublishQuota => ({ used, total, windowSeconds: 86_400, fetchedAt: T0 });
let pool: PsqlPool | null;
let db: SqlExecutor;
let sched: SchedulerStore;

before(async () => {
  pool = await freshDatabase();
  if (pool) {
    db = pool.executor();
    sched = new SchedulerStore(db);
  }
});
after(() => pool?.close());

async function start(videos: number, over: Partial<{ batchSize: number; loopEnabled: boolean; durationHours: number }> = {}) {
  const seed = await seedTenant(db, videos);
  const r = await sched.createCycle({
    userId: seed.userId, accountId: seed.accountId, provider: 'MOCK', batchSize: over.batchSize ?? 3, intervalMinutes: 20,
    loopEnabled: over.loopEnabled ?? false, durationHours: over.durationHours ?? 24, now: T0,
  });
  assert.ok(r.ok);
  return { seed, cycle: r.cycle as CycleRow };
}
const jobsOf = (cycleId: string) =>
  db.query(`SELECT j.id, j.status, j.sequence_no, j.iteration, v.position FROM publish_jobs j JOIN videos v ON v.id = j.video_id WHERE j.cycle_id = $1 ORDER BY j.sequence_no`, [cycleId]);
const resolveAll = (cycleId: string) => db.exec(`UPDATE publish_jobs SET status = 'SIMULATED' WHERE cycle_id = $1 AND status = 'SCHEDULED'`, [cycleId]);

describe('SchedulerStore (real PostgreSQL)', () => {
  it('createCycle snapshots settings, fixes the window, and allows only one live cycle per account', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { seed, cycle } = await start(2);
    assert.equal(cycle.endsAt.getTime() - cycle.startedAt.getTime(), 24 * 60 * MIN);
    assert.equal(cycle.status, 'ACTIVE');
    const again = await sched.createCycle({ userId: seed.userId, accountId: seed.accountId, provider: 'MOCK', batchSize: 1, intervalMinutes: 20, loopEnabled: false, durationHours: 24, now: T0 });
    assert.deepEqual(again, { ok: false, code: 'CYCLE_ALREADY_ACTIVE' });
  });

  it('tick releases an ordered batch, keeps a fixed cadence, and a duplicate tick creates nothing', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { cycle } = await start(10);
    const r1 = await sched.tick(cycle.id, T0, quota(0));
    assert.equal(r1.decision, 'SCHEDULE_BATCH');
    assert.equal(r1.newJobs.length, 3);
    assert.equal(r1.nextTickAt!.getTime(), at(20).getTime());
    assert.deepEqual((await jobsOf(cycle.id)).map((j) => [Number(j.sequence_no), Number(j.position)]), [[1, 0], [2, 1], [3, 2]]);

    const dup = await sched.tick(cycle.id, at(1), quota(0)); // duplicate/early delivery
    assert.equal(dup.decision, 'NOT_DUE');
    assert.equal(dup.newJobs.length, 0);

    const bp = await sched.tick(cycle.id, at(20), quota(0)); // due, but batch 1 is unresolved
    assert.equal(bp.decision, 'BACKPRESSURE');
    assert.equal(bp.newJobs.length, 0);

    await resolveAll(cycle.id);
    const r2 = await sched.tick(cycle.id, at(21), quota(0)); // 1 min late: fixed-rate keeps the original slot
    assert.equal(r2.decision, 'SCHEDULE_BATCH');
    assert.deepEqual((await jobsOf(cycle.id)).slice(3).map((j) => Number(j.position)), [3, 4, 5]);
    assert.equal(r2.nextTickAt!.getTime(), at(40).getTime()); // prev slot (20) + interval, not now + interval
  });

  it('concurrent ticks serialise: the same batch is never created twice', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { cycle } = await start(10);
    const results = await Promise.all(Array.from({ length: 6 }, () => sched.tick(cycle.id, T0, quota(0))));
    assert.equal(results.filter((r) => r.decision === 'SCHEDULE_BATCH').length, 1);
    assert.equal((await jobsOf(cycle.id)).length, 3);
  });

  it('quota: partial batch is trimmed (rest preserved), exhausted/unknown defer and create no jobs', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const a = await start(10);
    const partial = await sched.tick(a.cycle.id, T0, quota(24, 25));
    assert.equal(partial.newJobs.length, 1);
    assert.equal(partial.quotaLimited, true);
    assert.equal(partial.deferredByQuota, 2);
    const b = await start(10);
    const none = await sched.tick(b.cycle.id, T0, quota(25, 25));
    assert.equal(none.decision, 'QUOTA_DEFER');
    assert.equal(none.reason, 'QUOTA_EXHAUSTED');
    assert.equal((await jobsOf(b.cycle.id)).length, 0);
    const c = await start(10);
    const unknown = await sched.tick(c.cycle.id, T0, null);
    assert.equal(unknown.decision, 'QUOTA_DEFER');
    assert.equal(unknown.reason, 'QUOTA_UNKNOWN');
    assert.equal((await jobsOf(c.cycle.id)).length, 0);
  });

  it('loop OFF drains then COMPLETEs; loop ON wraps to position 0 with a new iteration (distinct idempotency keys)', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const off = await start(2, { batchSize: 2 });
    await sched.tick(off.cycle.id, T0, quota(0));
    await resolveAll(off.cycle.id);
    const done = await sched.tick(off.cycle.id, at(20), quota(0));
    assert.equal(done.decision, 'COMPLETE');
    assert.equal((await sched.getCycle(off.seed.userId, off.cycle.id))!.status, 'COMPLETED');

    const on = await start(2, { batchSize: 2, loopEnabled: true });
    await sched.tick(on.cycle.id, T0, quota(0));
    await resolveAll(on.cycle.id);
    const wrap = await sched.tick(on.cycle.id, at(20), quota(0));
    assert.equal(wrap.decision, 'SCHEDULE_BATCH');
    const jobs = await jobsOf(on.cycle.id);
    assert.deepEqual(jobs.map((j) => [Number(j.iteration), Number(j.position)]), [[1, 0], [1, 1], [2, 0], [2, 1]]);
    assert.equal(new Set((await db.query('SELECT idempotency_key FROM publish_jobs WHERE cycle_id = $1', [on.cycle.id])).map((r) => r.idempotency_key)).size, 4);
  });

  it('loop can be toggled on a live cycle and takes effect on the next tick', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { seed, cycle } = await start(2, { batchSize: 2 });
    await sched.tick(cycle.id, T0, quota(0));
    await resolveAll(cycle.id);
    assert.equal((await sched.setLoop(seed.userId, cycle.id, true))!.loopEnabled, true);
    assert.equal((await sched.tick(cycle.id, at(20), quota(0))).decision, 'SCHEDULE_BATCH');
  });

  it('expiry: late tick expires the cycle, expires unstarted jobs, and leaves a requested publish for reconciliation', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { cycle } = await start(5, { batchSize: 3 });
    await sched.tick(cycle.id, T0, quota(0));
    await db.exec(`UPDATE publish_jobs SET status = 'PUBLISH_REQUESTED', publish_requested_at = $2::timestamptz, container_id = 'c' WHERE cycle_id = $1 AND sequence_no = 1`, [cycle.id, T0]);
    const r = await sched.tick(cycle.id, at(24 * 60 + 5), quota(0));
    assert.equal(r.decision, 'EXPIRE');
    const jobs = await jobsOf(cycle.id);
    assert.deepEqual(jobs.map((j) => j.status), ['PUBLISH_REQUESTED', 'EXPIRED', 'EXPIRED']);
    const row = await db.query('SELECT status, end_reason FROM publishing_cycles WHERE id = $1', [cycle.id]);
    assert.deepEqual([row[0]!.status, row[0]!.end_reason], ['EXPIRED', 'WINDOW_ELAPSED']);
    assert.equal((await sched.tick(cycle.id, at(24 * 60 + 6), quota(0))).decision, 'IDLE');
  });

  it('stop cancels unstarted jobs, spares live-leased and requested/accepted ones, and is not repeatable', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { seed, cycle } = await start(6, { batchSize: 5 });
    await sched.tick(cycle.id, T0, quota(0));
    await db.exec(`UPDATE publish_jobs SET status = 'PUBLISH_REQUESTED', publish_requested_at = $2::timestamptz, container_id = 'c' WHERE cycle_id = $1 AND sequence_no = 1`, [cycle.id, T0]);
    await db.exec(`UPDATE publish_jobs SET lease_owner = 'live', lease_expires_at = $2::timestamptz WHERE cycle_id = $1 AND sequence_no = 2`, [cycle.id, at(5)]);
    const r = await sched.command(seed.userId, cycle.id, 'STOP', at(1));
    assert.ok(r.ok);
    assert.equal(r.cancelledJobs, 3);
    assert.deepEqual((await jobsOf(cycle.id)).map((j) => j.status), ['PUBLISH_REQUESTED', 'SCHEDULED', 'CANCELLED', 'CANCELLED', 'CANCELLED']);
    assert.equal(r.cycle.status, 'STOPPED');
    const again = await sched.command(seed.userId, cycle.id, 'STOP', at(2));
    assert.deepEqual([again.ok, !again.ok && again.code], [false, 'INVALID_TRANSITION']);
    assert.equal((await sched.tick(cycle.id, at(30), quota(0))).decision, 'IDLE');
  });

  it('pause / resume; resume after the window elapsed is refused and the expiry is made durable', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { seed, cycle } = await start(3, { durationHours: 1 });
    const p = await sched.command(seed.userId, cycle.id, 'PAUSE', at(1));
    assert.ok(p.ok && p.cycle.status === 'PAUSED' && p.cycle.pauseReason === 'USER');
    assert.equal((await sched.tick(cycle.id, at(30), quota(0))).decision, 'IDLE');
    const resumed = await sched.command(seed.userId, cycle.id, 'RESUME', at(31));
    assert.ok(resumed.ok && resumed.cycle.status === 'ACTIVE' && resumed.cycle.pauseReason === null);
    await sched.command(seed.userId, cycle.id, 'PAUSE', at(32));
    const late = await sched.command(seed.userId, cycle.id, 'RESUME', at(61));
    assert.deepEqual([late.ok, !late.ok && late.code], [false, 'CYCLE_EXPIRED']);
    assert.equal((await sched.getCycle(seed.userId, cycle.id))!.status, 'EXPIRED');
  });

  it('retryJob: only FAILED+retryable jobs of a live cycle, only for the owner', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { seed, cycle } = await start(3);
    await sched.tick(cycle.id, T0, quota(0));
    const [j1, j2, j3] = (await jobsOf(cycle.id)).map((j) => String(j.id));
    await db.exec(`UPDATE publish_jobs SET status = 'FAILED', retryable = true, failure_reason = 'RETRIES_EXHAUSTED' WHERE id = $1`, [j1]);
    await db.exec(`UPDATE publish_jobs SET status = 'FAILED', retryable = false, failure_reason = 'MEDIA_REJECTED' WHERE id = $1`, [j2]);
    const other = await seedTenant(db, 1);
    assert.deepEqual(await sched.retryJob(other.userId, j1!, at(5)), { ok: false, code: 'NOT_FOUND' }); // tenant isolation
    assert.deepEqual(await sched.retryJob(seed.userId, j2!, at(5)), { ok: false, code: 'JOB_NOT_RETRYABLE' });
    assert.deepEqual(await sched.retryJob(seed.userId, j3!, at(5)), { ok: false, code: 'JOB_NOT_RETRYABLE' });
    assert.deepEqual(await sched.retryJob(seed.userId, j1!, at(5)), { ok: true, jobId: j1 });
    assert.equal((await db.query('SELECT status, retryable FROM publish_jobs WHERE id = $1', [j1]))[0]!.status, 'SCHEDULED');
    await sched.command(seed.userId, cycle.id, 'STOP', at(6));
    await db.exec(`UPDATE publish_jobs SET status = 'FAILED', retryable = true WHERE id = $1`, [j1]);
    assert.deepEqual(await sched.retryJob(seed.userId, j1!, at(7)), { ok: false, code: 'CYCLE_NOT_ACTIVE' });
  });

  it('tenant isolation: another user can neither read nor command a cycle', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { cycle } = await start(2);
    const intruder = await seedTenant(db, 1);
    assert.equal(await sched.getCycle(intruder.userId, cycle.id), null);
    const r = await sched.command(intruder.userId, cycle.id, 'STOP', at(1));
    assert.deepEqual([r.ok, !r.ok && r.code], [false, 'NOT_FOUND']);
    assert.equal(await sched.setLoop(intruder.userId, cycle.id, true), null);
    assert.equal((await sched.getCycle(cycle.userId, cycle.id))!.status, 'ACTIVE');
  });

  it('sweeper: due jobs of active cycles + reconcilable jobs; not leased, not paused, not future', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { seed, cycle } = await start(6, { batchSize: 5 });
    await sched.tick(cycle.id, T0, quota(0));
    const ids = (await jobsOf(cycle.id)).map((j) => String(j.id));
    await db.exec(`UPDATE publish_jobs SET lease_owner = 'w', lease_expires_at = $2::timestamptz WHERE id = $1`, [ids[1], at(5)]);
    await db.exec(`UPDATE publish_jobs SET next_attempt_at = $2::timestamptz WHERE id = $1`, [ids[2], at(10)]);
    const due = (await sched.findDueJobs(at(1), 100)).map((j) => j.id).filter((id) => ids.includes(id));
    assert.deepEqual(due, [ids[0], ids[3], ids[4]]);
    await sched.command(seed.userId, cycle.id, 'PAUSE', at(2));
    assert.deepEqual((await sched.findDueJobs(at(3), 100)).filter((j) => ids.includes(j.id)), []);
    await db.exec(`UPDATE publish_jobs SET status = 'PUBLISH_REQUESTED', publish_requested_at = $2::timestamptz, container_id = 'c' WHERE id = $1`, [ids[0], T0]);
    assert.deepEqual((await sched.findDueJobs(at(3), 100)).map((j) => j.id).filter((id) => ids.includes(id)), [ids[0]]);
    const cycles = await sched.findDueCycles(at(24 * 60 + 1), 100);
    assert.ok(cycles.some((c) => c.id === cycle.id), 'a paused cycle past its window must be picked up for expiry');
  });

  it('a second cycle on the same account restarts numbering at 1; an unresolved publish from the old cycle blocks it', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { seed, cycle } = await start(3, { batchSize: 1 });
    await sched.tick(cycle.id, T0, quota(0));
    const old = String((await jobsOf(cycle.id))[0]!.id);
    await db.exec(`UPDATE publish_jobs SET status = 'PUBLISH_REQUESTED', publish_requested_at = $2::timestamptz, container_id = 'c' WHERE id = $1`, [old, T0]);
    await sched.command(seed.userId, cycle.id, 'STOP', at(1));
    const second = await sched.createCycle({ userId: seed.userId, accountId: seed.accountId, provider: 'MOCK', batchSize: 1, intervalMinutes: 20, loopEnabled: false, durationHours: 24, now: at(2) });
    assert.ok(second.ok);
    const r = await sched.tick(second.cycle.id, at(2), quota(0));
    assert.equal(r.newJobs.length, 1);
    assert.equal(Number((await jobsOf(second.cycle.id))[0]!.sequence_no), 1);
    const store = new PgJobStore(db);
    const blocked = await store.claim(r.newJobs[0]!.id, { workerId: 'w', now: at(3), leaseMs: 5 * MIN });
    assert.equal(!blocked.claimed && blocked.reason, 'OUT_OF_ORDER');
  });
});
