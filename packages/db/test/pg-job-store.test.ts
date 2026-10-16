import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { InvalidTransitionError, LeaseLostError, makeIdempotencyKey } from '@reelqueue/core';
import { PgJobStore, SchedulerStore } from '../src';
import { freshDatabase, seedTenant, type Seed } from './helpers/fixtures';
import type { PsqlPool } from './helpers/psql-executor';
import type { SqlExecutor } from '../src/sql';

const T0 = new Date('2026-10-14T10:00:00.000Z');
const MIN = 60_000;
let pool: PsqlPool | null;
let db: SqlExecutor;

before(async () => {
  pool = await freshDatabase();
  if (pool) db = pool.executor();
});
after(() => pool?.close());

async function setup(videos = 3): Promise<{ seed: Seed; cycleId: string; jobs: string[]; store: PgJobStore }> {
  const seed = await seedTenant(db, videos);
  const sched = new SchedulerStore(db);
  const created = await sched.createCycle({
    userId: seed.userId, accountId: seed.accountId, provider: 'MOCK', batchSize: 3, intervalMinutes: 20,
    loopEnabled: false, durationHours: 24, now: T0,
  });
  assert.ok(created.ok);
  const cycleId = created.cycle.id;
  const jobs: string[] = [];
  for (let i = 0; i < videos; i++) {
    const r = await db.query(
      `INSERT INTO publish_jobs (user_id, cycle_id, instagram_account_id, video_id, sequence_no, iteration, idempotency_key, provider, next_attempt_at)
       VALUES ($1,$2,$3,$4,$5,1,$6,'MOCK',$7::timestamptz) RETURNING id`,
      [seed.userId, cycleId, seed.accountId, seed.videoIds[i], i + 1, makeIdempotencyKey(cycleId, seed.videoIds[i]!, 1), T0],
    );
    jobs.push(String(r[0]!.id));
  }
  return { seed, cycleId, jobs, store: new PgJobStore(db) };
}
const args = (workerId: string, now = T0) => ({ workerId, now, leaseMs: 5 * MIN });

describe('PgJobStore (real PostgreSQL)', () => {
  it('claims a due job, writes the lease, and refuses a second claim (LEASED)', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { jobs, store } = await setup(1);
    const a = await store.claim(jobs[0]!, args('w1'));
    assert.ok(a.claimed);
    assert.equal(a.job.leaseOwner, 'w1');
    assert.equal(a.job.leaseExpiresAt!.getTime(), T0.getTime() + 5 * MIN);
    const b = await store.claim(jobs[0]!, args('w2'));
    assert.deepEqual([b.claimed, !b.claimed && b.reason], [false, 'LEASED']);
    // after the lease expires another worker can take over (crash recovery)
    const c = await store.claim(jobs[0]!, args('w2', new Date(T0.getTime() + 6 * MIN)));
    assert.ok(c.claimed && c.job.leaseOwner === 'w2');
  });

  it('NOT_FOUND, NOT_DUE, TERMINAL', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { jobs, store } = await setup(2);
    const missing = await store.claim('00000000-0000-0000-0000-000000000999', args('w1'));
    assert.equal(!missing.claimed && missing.reason, 'NOT_FOUND');
    await db.exec(`UPDATE publish_jobs SET next_attempt_at = $2::timestamptz WHERE id = $1`, [jobs[0], new Date(T0.getTime() + 10 * MIN)]);
    const nd = await store.claim(jobs[0]!, args('w1'));
    assert.equal(!nd.claimed && nd.reason, 'NOT_DUE');
    await db.exec(`UPDATE publish_jobs SET status = 'CANCELLED' WHERE id = $1`, [jobs[1]]);
    const tm = await store.claim(jobs[1]!, args('w1'));
    assert.equal(!tm.claimed && tm.reason, 'TERMINAL');
  });

  it('enforces per-account order (OUT_OF_ORDER) and a single live lease per account (ACCOUNT_BUSY)', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { jobs, store } = await setup(3);
    const early = await store.claim(jobs[1]!, args('w1'));
    assert.equal(!early.claimed && early.reason, 'OUT_OF_ORDER');
    assert.ok((await store.claim(jobs[0]!, args('w1'))).claimed);
    const busy = await store.claim(jobs[2]!, args('w2'));
    assert.equal(!busy.claimed && busy.reason, 'ACCOUNT_BUSY');
  });

  it('a permanently FAILED earlier job does not block later jobs; a DEFERRED one does', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { jobs, store } = await setup(3);
    await db.exec(`UPDATE publish_jobs SET status = 'DEFERRED' WHERE id = $1`, [jobs[0]]);
    const blocked = await store.claim(jobs[1]!, args('w1'));
    assert.equal(!blocked.claimed && blocked.reason, 'OUT_OF_ORDER');
    await db.exec(`UPDATE publish_jobs SET status = 'FAILED' WHERE id = $1`, [jobs[0]]);
    assert.ok((await store.claim(jobs[1]!, args('w1'))).claimed);
  });

  it('CONCURRENCY: 8 workers racing for the same job -> exactly one wins', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { jobs, store } = await setup(1);
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => store.claim(jobs[0]!, args(`w${i}`))));
    assert.equal(results.filter((r) => r.claimed).length, 1);
  });

  it('CONCURRENCY: racing for different jobs of one account -> never two live leases, order respected', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { jobs, store } = await setup(3);
    const results = await Promise.all(jobs.map((j, i) => store.claim(j, args(`w${i}`))));
    assert.equal(results.filter((r) => r.claimed).length, 1);
    const winner = results.findIndex((r) => r.claimed);
    assert.equal(winner, 0, 'only the earliest job may win');
    const live = await db.query(`SELECT count(*)::int AS n FROM publish_jobs WHERE lease_owner IS NOT NULL AND id = ANY($1::text[])`.replace('id =', 'id::text ='), [jobs]);
    assert.equal(live[0]!.n, 1);
  });

  it('update(): compare-and-set on the lease, validated transitions, honest status constraints', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { jobs, store } = await setup(1);
    await assert.rejects(store.update(jobs[0]!, 'w1', { status: 'CREATING_CONTAINER' }, T0), LeaseLostError);
    assert.ok((await store.claim(jobs[0]!, args('w1'))).claimed);
    await assert.rejects(store.update(jobs[0]!, 'w2', { status: 'CREATING_CONTAINER' }, T0), LeaseLostError);
    await assert.rejects(store.update(jobs[0]!, 'w1', { status: 'CREATING_CONTAINER' }, new Date(T0.getTime() + 6 * MIN)), LeaseLostError);
    await assert.rejects(store.update(jobs[0]!, 'w1', { status: 'CONFIRMED' }, T0), InvalidTransitionError);
    const u = await store.update(jobs[0]!, 'w1', { status: 'CREATING_CONTAINER', attemptCount: 1 }, T0);
    assert.equal(u.status, 'CREATING_CONTAINER');
    assert.equal(u.attemptCount, 1);
    const v = await store.update(jobs[0]!, 'w1', { status: 'PROCESSING_MEDIA', containerId: 'c1', releaseLease: true }, T0);
    assert.equal(v.leaseOwner, null);
    assert.equal(v.containerId, 'c1');
    // a MOCK job can never be recorded as API-accepted, even if buggy code tried (database CHECK)
    assert.ok((await store.claim(jobs[0]!, args('w1'))).claimed);
    await store.update(jobs[0]!, 'w1', { status: 'PUBLISH_REQUESTED', publishRequestedAt: T0 }, T0);
    await assert.rejects(store.update(jobs[0]!, 'w1', { status: 'ACCEPTED', mediaId: 'm' }, T0), (e: any) => e.code === '23514');
  });

  it('records attempts, context (caption) and pauses the cycle + flags the account', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { seed, cycleId, jobs, store } = await setup(1);
    await db.exec(`UPDATE videos SET caption = 'hello #reel' WHERE id = $1`, [seed.videoIds[0]]);
    assert.deepEqual(await store.getJobContext(jobs[0]!), { accountId: seed.accountId, videoId: seed.videoIds[0]!, caption: 'hello #reel' });
    await store.recordAttempt({ jobId: jobs[0]!, step: 'PUBLISH', at: T0, outcome: 'ERROR', errorKind: 'TIMEOUT', httpStatus: 504 });
    const rows = await db.query(`SELECT user_id, step, outcome, error_kind, http_status FROM publish_attempts WHERE job_id = $1`, [jobs[0]]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.user_id, seed.userId);
    assert.equal(rows[0]!.http_status, 504);
    await store.pauseCycle(cycleId, 'ACCOUNT_REAUTH_REQUIRED', T0);
    assert.equal((await store.getCycleGuard(cycleId))!.status, 'PAUSED');
    assert.equal((await db.query('SELECT status FROM instagram_accounts WHERE id = $1', [seed.accountId]))[0]!.status, 'REAUTH_REQUIRED');
  });
});
