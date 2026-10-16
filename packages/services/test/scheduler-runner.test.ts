import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '@reelqueue/core';
import { freshDatabase, seedTenant } from '../../db/test/helpers/fixtures';
import type { PsqlPool } from '../../db/test/helpers/psql-executor';
import type { SqlExecutor } from '../../db/src/sql';
import { makeSim, MIN, T0 } from './helpers/sim';

let pool: PsqlPool | null;
let db: SqlExecutor;
before(async () => {
  pool = await freshDatabase();
  if (pool) db = pool.executor();
});
after(() => pool?.close());

async function scenario(videos: number, opts: { batchSize?: number; intervalMinutes?: number; loopEnabled?: boolean; durationHours?: number } = {}) {
  const sim = makeSim(db);
  const seed = await seedTenant(db, videos);
  const created = await sim.store.createCycle({
    userId: seed.userId, accountId: seed.accountId, provider: 'MOCK', batchSize: opts.batchSize ?? 2,
    intervalMinutes: opts.intervalMinutes ?? 20, loopEnabled: opts.loopEnabled ?? false, durationHours: opts.durationHours ?? 24, now: T0,
  });
  assert.ok(created.ok);
  await sim.queue.wakeCycle(created.cycle.id, T0);
  const statuses = async () => (await db.query('SELECT status, count(*)::int AS n FROM publish_jobs WHERE cycle_id = $1 GROUP BY status', [created.cycle.id])).reduce<Record<string, number>>((a, r) => ({ ...a, [String(r.status)]: Number(r.n) }), {});
  const cycleStatus = async () => String((await db.query('SELECT status FROM publishing_cycles WHERE id = $1', [created.cycle.id]))[0]!.status);
  return { sim, seed, cycle: created.cycle, statuses, cycleStatus };
}
const minutesSinceStart = (d: Date) => (d.getTime() - T0.getTime()) / MIN;

describe('SchedulerRunner end-to-end (real PostgreSQL, mock provider, virtual time)', () => {
  it('publishes 5 videos in order at a 20-minute cadence (batch 2) and completes; mock results are SIMULATED', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { sim, cycle, statuses, cycleStatus } = await scenario(5);
    await sim.advance(120);
    assert.deepEqual(await statuses(), { SIMULATED: 5 });
    assert.equal(await cycleStatus(), 'COMPLETED');
    assert.equal(sim.provider.publications.length, 5);
    assert.deepEqual(sim.publishedAt.map(minutesSinceStart), [0, 0, 20, 20, 40]);
    const order = await db.query(`SELECT v.position FROM publish_jobs j JOIN videos v ON v.id = j.video_id WHERE j.cycle_id = $1 ORDER BY j.sequence_no`, [cycle.id]);
    assert.deepEqual(order.map((r) => Number(r.position)), [0, 1, 2, 3, 4]);
    assert.deepEqual(sim.errors, []);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM publish_jobs WHERE cycle_id = $1 AND status IN ('ACCEPTED','CONFIRMED')`, [cycle.id]))[0]!.n, 0);
  });

  it('loop ON keeps cycling through the queue until the 24h window ends, then expires', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { sim, cycleStatus } = await scenario(3, { batchSize: 3, loopEnabled: true, durationHours: 1 });
    await sim.advance(90);
    assert.equal(sim.provider.publications.length, 9); // passes at t=0, 20, 40; next slot (60) is at the window end
    assert.equal(await cycleStatus(), 'EXPIRED');
  });

  it('window expiry stops new publications; unstarted work is EXPIRED, never published later', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { sim, statuses, cycleStatus } = await scenario(10, { batchSize: 1, durationHours: 1 });
    await sim.advance(180, { sweepEveryMs: 30_000 });
    assert.equal(sim.provider.publications.length, 3);
    assert.equal(await cycleStatus(), 'EXPIRED');
    assert.deepEqual(await statuses(), { SIMULATED: 3 }); // later videos were never turned into jobs
  });

  it('Redis loss: wiping the queue mid-cycle is recovered by the sweeper with no duplicates', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { sim, statuses, cycleStatus } = await scenario(6, { batchSize: 2 });
    await sim.advance(25);
    assert.equal(sim.provider.publications.length, 4);
    sim.queue.clear(); // Redis flushed / worker restarted with empty queue
    await sim.advance(120, { sweepEveryMs: 30_000 });
    assert.equal(sim.provider.publications.length, 6);
    assert.equal(new Set(sim.provider.publications.map((p) => p.containerId)).size, 6);
    assert.deepEqual(await statuses(), { SIMULATED: 6 });
    assert.equal(await cycleStatus(), 'COMPLETED');
  });

  it('duplicate queue delivery: five workers receive the same job -> one publication', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { sim, cycle } = await scenario(1, { batchSize: 1 });
    const tick = await sim.runner.runCycleTick(cycle.id);
    const jobId = tick.newJobs[0]!.id;
    const outcomes = await Promise.all(Array.from({ length: 5 }, (_, i) => sim.run(jobId, `w${i}`)));
    assert.equal(outcomes.filter((o) => o.kind === 'COMPLETED').length, 1);
    assert.equal(sim.provider.publications.length, 1);
    await sim.run(jobId, 'late-duplicate'); // redelivery after completion
    assert.equal(sim.provider.publications.length, 1);
  });

  it('uncertain outcome: publish response lost after the provider acted -> reconciled, published exactly once', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { sim, statuses } = await scenario(1, { batchSize: 1 });
    sim.provider.scriptFault('publishContainer', { error: new ProviderError('TIMEOUT', 'timed out', { code: 'ETIMEDOUT' }), applyEffect: true });
    await sim.advance(30);
    assert.equal(sim.provider.publications.length, 1);
    assert.deepEqual(await statuses(), { SIMULATED: 1 });
    assert.equal(sim.provider.callCount('publishContainer'), 1, 'reconciliation must not call publish again');
  });

  it('worker crash after the provider published: lease expires, sweeper redelivers, no second publication', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { sim, statuses } = await scenario(1, { batchSize: 1 });
    const real = sim.provider.publishContainer.bind(sim.provider);
    let crashed = false;
    sim.provider.publishContainer = async (a, c) => {
      const r = await real(a, c);
      if (!crashed) {
        crashed = true;
        throw new Error('SIGKILL'); // raw error: the process died, no state written after the effect
      }
      return r;
    };
    await sim.advance(60, { sweepEveryMs: 30_000 });
    assert.equal(sim.errors.length, 1);
    assert.equal(sim.provider.publications.length, 1);
    assert.deepEqual(await statuses(), { SIMULATED: 1 });
  });

  it('quota exhausted: nothing is published and no jobs are created; recovers when quota frees', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { sim, statuses } = await scenario(3, { batchSize: 3 });
    sim.provider.quota.used = sim.provider.quota.total;
    await sim.advance(40, { sweepEveryMs: 30_000 });
    assert.equal(sim.provider.publications.length, 0);
    assert.deepEqual(await statuses(), {});
    sim.provider.quota.used = 0;
    await sim.advance(80, { sweepEveryMs: 30_000 });
    assert.equal(sim.provider.publications.length, 3);
  });

  it('stop mid-run: no further publication is started and the remaining queue is preserved', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { sim, seed, cycle, cycleStatus } = await scenario(6, { batchSize: 2 });
    await sim.advance(5);
    assert.equal(sim.provider.publications.length, 2);
    const stop = await sim.store.command(seed.userId, cycle.id, 'STOP', sim.clock.now());
    assert.ok(stop.ok);
    await sim.advance(200, { sweepEveryMs: 30_000 });
    assert.equal(sim.provider.publications.length, 2);
    assert.equal(await cycleStatus(), 'STOPPED');
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM videos WHERE user_id = $1 AND status = 'READY' AND deleted_at IS NULL`, [seed.userId]))[0]!.n, 6);
  });

  it('expired token: the cycle auto-pauses, the account is flagged for reauthorization, nothing is published', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { sim, seed, cycleStatus } = await scenario(2, { batchSize: 1 });
    sim.provider.scriptFault('createReelContainer', { error: new ProviderError('AUTH_EXPIRED', 'token expired', { code: '190', httpStatus: 401 }) });
    await sim.advance(10);
    assert.equal(await cycleStatus(), 'PAUSED');
    assert.equal(sim.provider.publications.length, 0);
    assert.equal((await db.query('SELECT status FROM instagram_accounts WHERE id = $1', [seed.accountId]))[0]!.status, 'REAUTH_REQUIRED');
  });

  it('rejected media fails that job permanently (no retry) and the queue moves on', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { sim, statuses } = await scenario(3, { batchSize: 3 });
    sim.provider.rejectedUrlFragments = [(await db.query(`SELECT id FROM videos ORDER BY created_at DESC, position LIMIT 1 OFFSET 1`))[0]!.id as string];
    await sim.advance(60, { sweepEveryMs: 30_000 });
    const s = await statuses();
    assert.equal(s.FAILED, 1);
    assert.equal(s.SIMULATED, 2);
    assert.equal(sim.provider.callCount('createReelContainer'), 3, 'a rejected job must not be retried');
  });
});
