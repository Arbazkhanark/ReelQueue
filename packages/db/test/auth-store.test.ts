import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { AuthStore } from '../src';
import { freshDatabase } from './helpers/fixtures';
import type { PsqlPool } from './helpers/psql-executor';
import type { SqlExecutor } from '../src/sql';

const T0 = new Date('2026-10-17T10:00:00Z');
const at = (s: number) => new Date(T0.getTime() + s * 1000);
let pool: PsqlPool | null; let db: SqlExecutor; let store: AuthStore;
before(async () => { pool = await freshDatabase(); if (pool) { db = pool.executor(); store = new AuthStore(db); } });
after(() => pool?.close());
let n = 0;
async function user() { const r = await store.createUser(`User${++n}@Example.test`, 'scrypt$hash'); assert.ok(r.ok); return r.user; }

describe('AuthStore (real PostgreSQL)', () => {
  it('creates users with lower-cased unique email; duplicate (any case) is EMAIL_TAKEN', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const u = await store.createUser('Alice@Example.TEST', 'h');
    assert.ok(u.ok); assert.equal(u.user.email, 'alice@example.test'); assert.equal(u.user.status, 'ACTIVE'); assert.equal(u.user.role, 'USER');
    assert.deepEqual(await store.createUser('alice@EXAMPLE.test', 'h2'), { ok: false, code: 'EMAIL_TAKEN' });
    assert.equal((await store.findByEmail('ALICE@example.test'))?.id, u.user.id);
    assert.equal(await store.findByEmail('nobody@example.test'), null);
  });

  it('two concurrent signups with one email: exactly one wins', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const rs = await Promise.all(Array.from({ length: 5 }, () => store.createUser('race@example.test', 'h')));
    assert.equal(rs.filter((r) => r.ok).length, 1);
  });

  it('login failures count atomically, lock at the threshold, and success clears them', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const u = await user();
    await Promise.all(Array.from({ length: 4 }, () => store.recordLoginFailure(u.id, T0, 5, 15 * 60_000)));
    assert.equal((await store.findById(u.id))!.failedLoginCount, 4);
    assert.equal((await store.findById(u.id))!.lockedUntil, null);
    const r = await store.recordLoginFailure(u.id, T0, 5, 15 * 60_000);
    assert.equal(r.failedCount, 5); assert.equal(r.lockedUntil!.getTime(), T0.getTime() + 15 * 60_000);
    await store.recordLoginSuccess(u.id, at(1));
    const after = (await store.findById(u.id))!;
    assert.equal(after.failedLoginCount, 0); assert.equal(after.lockedUntil, null);
  });

  it('refresh rotation: old token dies, new works, same family', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const u = await user();
    const a = await store.issueRefreshToken({ userId: u.id, tokenHash: 'h1', expiresAt: at(3600) });
    const r1 = await store.rotateRefreshToken({ oldHash: 'h1', newHash: 'h2', newExpiresAt: at(7200), now: at(10), graceMs: 10_000 });
    assert.deepEqual(r1, { status: 'OK', userId: u.id, familyId: a.familyId });
    const r2 = await store.rotateRefreshToken({ oldHash: 'h2', newHash: 'h3', newExpiresAt: at(7200), now: at(20), graceMs: 10_000 });
    assert.equal(r2.status, 'OK');
    assert.deepEqual(await store.rotateRefreshToken({ oldHash: 'nope', newHash: 'x', newExpiresAt: at(1), now: at(1), graceMs: 0 }), { status: 'INVALID' });
  });

  it('reuse of a rotated token outside the grace window revokes the whole family', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const u = await user();
    await store.issueRefreshToken({ userId: u.id, tokenHash: 'f1', expiresAt: at(3600) });
    await store.rotateRefreshToken({ oldHash: 'f1', newHash: 'f2', newExpiresAt: at(3600), now: at(10), graceMs: 5000 });
    const reuse = await store.rotateRefreshToken({ oldHash: 'f1', newHash: 'evil', newExpiresAt: at(3600), now: at(100), graceMs: 5000 });
    assert.deepEqual(reuse, { status: 'REUSED', userId: u.id });
    // the legitimate newest token is now dead too
    assert.equal((await store.rotateRefreshToken({ oldHash: 'f2', newHash: 'f3', newExpiresAt: at(3600), now: at(101), graceMs: 5000 })).status, 'REUSED');
    assert.equal(Number((await db.query(`SELECT count(*) c FROM refresh_tokens WHERE user_id = $1 AND token_hash = 'evil'`, [u.id]))[0]!.c), 0);
  });

  it('a near-simultaneous second refresh (grace) is rejected WITHOUT killing the family', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const u = await user();
    await store.issueRefreshToken({ userId: u.id, tokenHash: 'g1', expiresAt: at(3600) });
    await store.rotateRefreshToken({ oldHash: 'g1', newHash: 'g2', newExpiresAt: at(3600), now: at(10), graceMs: 10_000 });
    assert.deepEqual(await store.rotateRefreshToken({ oldHash: 'g1', newHash: 'g2b', newExpiresAt: at(3600), now: at(12), graceMs: 10_000 }), { status: 'CONCURRENT' });
    assert.equal((await store.rotateRefreshToken({ oldHash: 'g2', newHash: 'g3', newExpiresAt: at(3600), now: at(13), graceMs: 10_000 })).status, 'OK');
  });

  it('concurrent rotation of ONE token yields exactly one success (row lock)', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const u = await user();
    await store.issueRefreshToken({ userId: u.id, tokenHash: 'c1', expiresAt: at(3600) });
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => store.rotateRefreshToken({ oldHash: 'c1', newHash: `c-new-${i}`, newExpiresAt: at(3600), now: at(10), graceMs: 10_000 })));
    assert.equal(rs.filter((r) => r.status === 'OK').length, 1);
    assert.equal(rs.filter((r) => r.status === 'CONCURRENT').length, 5);
    assert.equal(Number((await db.query(`SELECT count(*) c FROM refresh_tokens WHERE user_id = $1 AND revoked_at IS NULL`, [u.id]))[0]!.c), 1);
  });

  it('expired tokens are refused; logout revokes the family; revokeAll signs everything out', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const u = await user();
    await store.issueRefreshToken({ userId: u.id, tokenHash: 'e1', expiresAt: at(5) });
    assert.deepEqual(await store.rotateRefreshToken({ oldHash: 'e1', newHash: 'e2', newExpiresAt: at(99), now: at(5), graceMs: 0 }), { status: 'EXPIRED' });
    await store.issueRefreshToken({ userId: u.id, tokenHash: 'l1', expiresAt: at(3600) });
    await store.revokeFamilyOf('l1', at(1));
    assert.equal((await store.rotateRefreshToken({ oldHash: 'l1', newHash: 'l2', newExpiresAt: at(99), now: at(2), graceMs: 0 })).status, 'REUSED');
    await store.revokeFamilyOf('unknown', at(1)); // no throw
    await store.issueRefreshToken({ userId: u.id, tokenHash: 'a1', expiresAt: at(3600) });
    await store.issueRefreshToken({ userId: u.id, tokenHash: 'a2', expiresAt: at(3600) });
    assert.equal(await store.revokeAllForUser(u.id, at(3)), 3, 'a1, a2 and the expired-but-unrevoked e1');
  });

  it('auth tokens are single-use, purpose-bound, expiring; a new token supersedes the old', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const u = await user();
    await store.createAuthToken({ userId: u.id, purpose: 'EMAIL_VERIFICATION', tokenHash: 'v1', expiresAt: at(100), now: T0 });
    assert.equal(await store.consumeAuthToken('v1', 'PASSWORD_RESET', at(1)), null, 'wrong purpose');
    const wins = await Promise.all(Array.from({ length: 5 }, () => store.consumeAuthToken('v1', 'EMAIL_VERIFICATION', at(1))));
    assert.equal(wins.filter(Boolean).length, 1, 'exactly one consumer wins');
    await store.createAuthToken({ userId: u.id, purpose: 'EMAIL_VERIFICATION', tokenHash: 'v2', expiresAt: at(100), now: T0 });
    await store.createAuthToken({ userId: u.id, purpose: 'EMAIL_VERIFICATION', tokenHash: 'v3', expiresAt: at(100), now: at(1) });
    assert.equal(await store.consumeAuthToken('v2', 'EMAIL_VERIFICATION', at(2)), null, 'superseded');
    assert.equal(await store.consumeAuthToken('v3', 'EMAIL_VERIFICATION', at(101)), null, 'expired');
    await store.markEmailVerified(u.id, at(5));
    await store.markEmailVerified(u.id, at(500));
    assert.equal((await store.findById(u.id))!.emailVerifiedAt!.getTime(), at(5).getTime(), 'first verification time kept');
  });

  it('password reset is atomic: sets the hash, clears the lock, signs out all sessions, burns the token', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const u = await user();
    for (let i = 0; i < 5; i++) await store.recordLoginFailure(u.id, T0, 5, 60_000);
    await store.issueRefreshToken({ userId: u.id, tokenHash: 'r-s1', expiresAt: at(3600) });
    await store.createAuthToken({ userId: u.id, purpose: 'PASSWORD_RESET', tokenHash: 'rst', expiresAt: at(900), now: T0 });
    assert.equal(await store.resetPassword({ tokenHash: 'rst', newPasswordHash: 'new', now: at(1) }).then((r) => r?.userId), u.id);
    const after = (await store.findById(u.id))!;
    assert.equal(after.passwordHash, 'new'); assert.equal(after.lockedUntil, null); assert.equal(after.failedLoginCount, 0);
    assert.equal((await store.rotateRefreshToken({ oldHash: 'r-s1', newHash: 'z', newExpiresAt: at(9), now: at(2), graceMs: 0 })).status, 'REUSED');
    assert.equal(await store.resetPassword({ tokenHash: 'rst', newPasswordHash: 'again', now: at(3) }), null, 'token is single use');
    assert.equal((await store.findById(u.id))!.passwordHash, 'new');
  });
});
