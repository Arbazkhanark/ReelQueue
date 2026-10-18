import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AccountStore, FallbackRateLimitStore, PgRateLimitStore, RetentionStore, SchedulerStore, VideoStore } from '../src';
import { MemoryRateLimitStore } from '@reelqueue/core';
import { freshDatabase, seedTenant } from './helpers/fixtures';
import type { PsqlPool } from './helpers/psql-executor';
import type { SqlExecutor } from '../src/sql';

const T0 = new Date('2026-10-14T10:00:00.000Z');
const MIN = 60_000, DAY = 86_400_000;
let pool: PsqlPool | null; let db: SqlExecutor;
before(async () => { pool = await freshDatabase(); if (pool) db = pool.executor(); });
after(() => pool?.close());
const skip = (t: { skip(m: string): void }) => { if (!pool) { t.skip('no PostgreSQL'); return true; } return false; };
const n = async (sql: string, p: unknown[] = []) => Number((await db.query(sql, p))[0]!.n);

describe('PgRateLimitStore (shared across replicas)', () => {
  it('counts atomically under concurrency, rolls the window over, and purges expired rows', async (t) => {
    if (skip(t)) return;
    const s = new PgRateLimitStore(db);
    const rs = await Promise.all(Array.from({ length: 25 }, () => s.hit('k1', MIN, T0)));
    assert.deepEqual(rs.map((r) => r.count).sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 1), 'no lost increments');
    assert.equal(new Set(rs.map((r) => r.resetAt.getTime())).size, 1, 'one window');
    assert.equal((await s.hit('k1', MIN, new Date(T0.getTime() + MIN))).count, 1, 'window rolled over');
    assert.equal((await s.hit('k2', MIN, T0)).count, 1, 'keys are independent');
    assert.equal(await s.purgeExpired(new Date(T0.getTime() + 10 * MIN)), 2);
  });
  it('two "replicas" (separate store instances) share one counter; a failing primary degrades to the per-replica fallback', async (t) => {
    if (skip(t)) return;
    const a = new PgRateLimitStore(db), b = new PgRateLimitStore(db);
    await a.hit('shared', MIN, T0); assert.equal((await b.hit('shared', MIN, T0)).count, 2);
    let degraded = 0;
    const broken = { hit: async () => { throw new Error('db down'); } };
    const f = new FallbackRateLimitStore(broken, new MemoryRateLimitStore(), () => degraded++);
    assert.equal((await f.hit('x', MIN, T0)).count, 1); assert.equal((await f.hit('x', MIN, T0)).count, 2);
    assert.equal(degraded, 2);
  });
});

describe('AccountStore: OAuth upsert and token refresh claims', () => {
  const tok = (x: string) => `v1:k1:iv:${x}:tag`;
  const base = { providerAccountId: 'ig_100', username: 'brand', accountType: 'Business', scopes: ['instagram_business_basic'], tokenEnc: tok('a'), issuedAt: T0, expiresAt: new Date(T0.getTime() + 60 * DAY) };

  it('creates, updates in place for the same user, refuses another user, and frees the id after disconnect', async (t) => {
    if (skip(t)) return;
    const acc = new AccountStore(db);
    const u1 = (await seedTenant(db, 0)).userId, u2 = (await seedTenant(db, 0)).userId;
    const c = await acc.upsertMeta({ ...base, userId: u1 });
    assert.ok(c.ok && c.created && c.account.status === 'CONNECTED' && c.account.provider === 'META');
    const again = await acc.upsertMeta({ ...base, userId: u1, tokenEnc: tok('b'), username: 'renamed' });
    assert.ok(again.ok && !again.created && again.account.id === (c.ok ? c.account.id : '') && again.account.username === 'renamed');
    assert.equal(await n(`SELECT count(*) n FROM instagram_accounts WHERE provider_account_id = 'ig_100'`), 1);
    assert.deepEqual(await acc.upsertMeta({ ...base, userId: u2 }), { ok: false, code: 'IN_USE' });
    assert.ok((await acc.disconnect(u1, again.ok ? again.account.id : '', T0)).ok);
    assert.ok((await acc.upsertMeta({ ...base, userId: u2 })).ok, 'another user may connect it once the first disconnected');
  });
  it('two users racing for the same Instagram account: exactly one wins', async (t) => {
    if (skip(t)) return;
    const acc = new AccountStore(db);
    const u1 = (await seedTenant(db, 0)).userId, u2 = (await seedTenant(db, 0)).userId;
    const rs = await Promise.all([acc.upsertMeta({ ...base, providerAccountId: 'ig_race', userId: u1 }), acc.upsertMeta({ ...base, providerAccountId: 'ig_race', userId: u2 })]);
    assert.equal(rs.filter((r) => r.ok).length, 1); assert.equal(rs.filter((r) => !r.ok).length, 1);
    assert.equal(await n(`SELECT count(*) n FROM instagram_accounts WHERE provider_account_id = 'ig_race'`), 1);
  });
  it('refresh claim is exclusive, expires, and the token swap is compare-and-set; candidates/needs-auth behave', async (t) => {
    if (skip(t)) return;
    const acc = new AccountStore(db);
    const u = (await seedTenant(db, 0)).userId;
    const r = await acc.upsertMeta({ ...base, providerAccountId: 'ig_refresh', userId: u, expiresAt: new Date(T0.getTime() + 5 * DAY) });
    const id = r.ok ? r.account.id : '';
    assert.deepEqual((await acc.listTokenCandidates(T0, 10 * DAY)).map((c) => c.id).filter((x) => x === id), [id]);
    assert.deepEqual((await acc.listTokenCandidates(T0, 1 * DAY)).filter((c) => c.id === id), [], 'not yet within the lead time');
    const claims = await Promise.all(Array.from({ length: 6 }, () => acc.claimTokenRefresh(id, T0, 5 * MIN)));
    assert.equal(claims.filter((c) => c !== null).length, 1, 'exactly one worker wins the claim');
    assert.deepEqual((await acc.listTokenCandidates(T0, 10 * DAY)).filter((c) => c.id === id), [], 'claimed accounts are hidden from other sweeps');
    assert.equal(await acc.claimTokenRefresh(id, new Date(T0.getTime() + 6 * MIN), 5 * MIN), tok('a'), 'claim expires; a crashed worker does not block forever');
    const later = new Date(T0.getTime() + 2 * DAY);
    assert.equal(await acc.applyRefreshedToken(id, tok('STALE'), tok('x'), later, new Date(later.getTime() + 60 * DAY)), false, 'stale old token is refused');
    assert.equal(await acc.applyRefreshedToken(id, tok('a'), tok('new'), later, new Date(later.getTime() + 60 * DAY)), true);
    assert.equal((await db.query(`SELECT access_token_enc t FROM instagram_accounts WHERE id = $1`, [id]))[0]!.t, tok('new'));
    await acc.markNeedsAuth(id, 'REAUTH_REQUIRED', 'AUTH_EXPIRED');
    const row = (await db.query(`SELECT status, last_error_code FROM instagram_accounts WHERE id = $1`, [id]))[0]!;
    assert.deepEqual([row.status, row.last_error_code], ['REAUTH_REQUIRED', 'AUTH_EXPIRED']);
  });
});

describe('retention', () => {
  it('video purge: deletes unreferenced rows, scrubs referenced ones, ignores recent/object-present, is idempotent', async (t) => {
    if (skip(t)) return;
    const vs = new VideoStore(db);
    const s = await seedTenant(db, 4);
    const [a, b, c, d] = s.videoIds as [string, string, string, string];
    const old = new Date(T0.getTime() - 40 * DAY), recent = new Date(T0.getTime() - 2 * DAY);
    await db.exec(`UPDATE videos SET deleted_at = $2, storage_deleted_at = $2 WHERE id = $1`, [a, old]);          // old, object gone, unreferenced -> deleted
    await db.exec(`UPDATE videos SET deleted_at = $2, storage_deleted_at = $2, caption = 'secret caption' WHERE id = $1`, [b, old]); // referenced -> scrubbed
    await db.exec(`UPDATE videos SET deleted_at = $2, storage_deleted_at = $2 WHERE id = $1`, [c, recent]);       // too recent
    await db.exec(`UPDATE videos SET deleted_at = $2 WHERE id = $1`, [d, old]);                                   // object still stored -> untouched
    const cyc = await new SchedulerStore(db).createCycle({ userId: s.userId, accountId: s.accountId, provider: 'MOCK', batchSize: 1, intervalMinutes: 20, loopEnabled: false, durationHours: 24, now: T0 });
    assert.ok(cyc.ok);
    await db.exec(`INSERT INTO publish_jobs (user_id, cycle_id, instagram_account_id, video_id, provider, sequence_no, iteration, idempotency_key, status, next_attempt_at)
                   VALUES ($1, $2, $3, $4, 'MOCK', 1, 1, 'idem-ret', 'SIMULATED', $5)`, [s.userId, cyc.ok ? cyc.cycle.id : '', s.accountId, b, T0]);
    const r = await vs.purgeSoftDeleted(new Date(T0.getTime() - 30 * DAY), T0);
    assert.deepEqual(r, { deleted: 1, scrubbed: 1 });
    assert.equal(await n(`SELECT count(*) n FROM videos WHERE id = $1`, [a]), 0);
    const kept = (await db.query(`SELECT original_filename f, caption c, purged_at p FROM videos WHERE id = $1`, [b]))[0]!;
    assert.deepEqual([kept.f, kept.c, kept.p !== null], ['[deleted video]', null, true]);
    assert.equal(await n(`SELECT count(*) n FROM videos WHERE id IN ($1, $2) AND purged_at IS NULL`, [c, d]), 2);
    assert.deepEqual(await vs.purgeSoftDeleted(new Date(T0.getTime() - 30 * DAY), T0), { deleted: 0, scrubbed: 0 }, 'idempotent');
  });

  it('hard delete user: only after grace, not if cancelled, not while objects remain; removes everything; audit rows are detached', async (t) => {
    if (skip(t)) return;
    const rs = new RetentionStore(db);
    const s = await seedTenant(db, 2);
    const cutoff = new Date(T0.getTime() - 14 * DAY);
    assert.equal(await rs.hardDeleteUser(s.userId, cutoff), 'NOT_ELIGIBLE', 'active user is never deleted');
    await db.exec(`UPDATE users SET status = 'PENDING_DELETION', deletion_requested_at = $2 WHERE id = $1`, [s.userId, new Date(T0.getTime() - 5 * DAY)]);
    assert.equal(await rs.hardDeleteUser(s.userId, cutoff), 'NOT_ELIGIBLE', 'still inside the grace period');
    assert.ok(!(await rs.listUsersPastGrace(cutoff)).includes(s.userId));
    await db.exec(`UPDATE users SET deletion_requested_at = $2 WHERE id = $1`, [s.userId, new Date(T0.getTime() - 20 * DAY)]);
    assert.ok((await rs.listUsersPastGrace(cutoff)).includes(s.userId));
    assert.equal(await rs.hardDeleteUser(s.userId, cutoff), 'OBJECTS_REMAIN', 'storage objects must be removed first');
    assert.equal((await rs.pendingObjects(s.userId)).length, 2);
    await db.exec(`UPDATE videos SET storage_deleted_at = $2 WHERE user_id = $1`, [s.userId, T0]);
    const cyc = await new SchedulerStore(db).createCycle({ userId: s.userId, accountId: s.accountId, provider: 'MOCK', batchSize: 1, intervalMinutes: 20, loopEnabled: false, durationHours: 24, now: T0 });
    assert.ok(cyc.ok);
    assert.equal(await rs.hardDeleteUser(s.userId, cutoff), 'LIVE_CYCLE');
    await db.exec(`UPDATE publishing_cycles SET status = 'STOPPED', ended_at = $2 WHERE user_id = $1`, [s.userId, T0]);
    await db.exec(`INSERT INTO publish_jobs (user_id, cycle_id, instagram_account_id, video_id, provider, sequence_no, iteration, idempotency_key, status, next_attempt_at)
                   VALUES ($1, $2, $3, $4, 'MOCK', 1, 1, 'idem-del', 'SIMULATED', $5)`, [s.userId, cyc.ok ? cyc.cycle.id : '', s.accountId, s.videoIds[0], T0]);
    await db.exec(`INSERT INTO audit_logs (user_id, action) VALUES ($1, 'SOMETHING')`, [s.userId]);
    assert.equal(await rs.hardDeleteUser(s.userId, cutoff), 'DELETED');
    for (const tbl of ['users WHERE id', 'videos WHERE user_id', 'publish_jobs WHERE user_id', 'instagram_accounts WHERE user_id', 'publishing_cycles WHERE user_id', 'storage_usage WHERE user_id']) {
      assert.equal(await n(`SELECT count(*) n FROM ${tbl} = $1`, [s.userId]), 0, tbl);
    }
    assert.equal(await n(`SELECT count(*) n FROM audit_logs WHERE action = 'SOMETHING' AND user_id IS NULL`), 1, 'audit row survives, detached');
    assert.equal(await rs.hardDeleteUser(s.userId, cutoff), 'NOT_ELIGIBLE', 'idempotent');
  });

  it('a user who cancelled deletion between listing and deleting is NOT deleted', async (t) => {
    if (skip(t)) return;
    const rs = new RetentionStore(db);
    const s = await seedTenant(db, 0);
    await db.exec(`UPDATE users SET status = 'PENDING_DELETION', deletion_requested_at = $2 WHERE id = $1`, [s.userId, new Date(T0.getTime() - 20 * DAY)]);
    const cutoff = new Date(T0.getTime() - 14 * DAY);
    assert.ok((await rs.listUsersPastGrace(cutoff)).includes(s.userId));
    await db.exec(`UPDATE users SET status = 'ACTIVE', deletion_requested_at = NULL WHERE id = $1`, [s.userId]); // user cancels
    assert.equal(await rs.hardDeleteUser(s.userId, cutoff), 'NOT_ELIGIBLE');
    assert.equal(await n(`SELECT count(*) n FROM users WHERE id = $1`, [s.userId]), 1);
  });
});

describe('soft delete racing a scheduler tick', () => {
  it('a job is never created for a video whose soft-delete is in flight (tick waits for the row lock, then skips it)', async (t) => {
    if (skip(t)) return;
    const sched = new SchedulerStore(db);
    const s = await seedTenant(db, 2);
    const cyc = await sched.createCycle({ userId: s.userId, accountId: s.accountId, provider: 'MOCK', batchSize: 2, intervalMinutes: 20, loopEnabled: false, durationHours: 24, now: T0 });
    assert.ok(cyc.ok); const cycleId = cyc.ok ? cyc.cycle.id : '';
    let tick!: Promise<unknown>;
    await db.transaction(async (tx) => {
      // the deleting transaction holds the row lock (exactly what VideoStore.softDelete does) ...
      await tx.query(`SELECT id FROM videos WHERE id = $1 FOR UPDATE`, [s.videoIds[0]]);
      await tx.exec(`UPDATE videos SET deleted_at = $2 WHERE id = $1`, [s.videoIds[0], T0]);
      tick = sched.tick(cycleId, new Date(T0.getTime() + 1), { used: 0, total: 25, windowSeconds: 86_400, fetchedAt: T0 });
      await new Promise((r) => setTimeout(r, 400)); // ... while the tick is running concurrently and must be blocked on it
    });
    await tick;
    const jobs = await db.query(`SELECT video_id FROM publish_jobs WHERE cycle_id = $1`, [cycleId]);
    assert.ok(jobs.every((j) => j.video_id !== s.videoIds[0]), 'no job for the deleted video');
    assert.equal(jobs.length, 1, 'the other video still gets its job');
  });
});
