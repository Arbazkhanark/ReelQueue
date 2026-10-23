import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleDriveStore } from '../src';
import { freshDatabase, seedTenant } from './helpers/fixtures';
import type { PsqlPool } from './helpers/psql-executor';

let pool: PsqlPool | null = null;
before(async () => { pool = await freshDatabase(); });
after(() => { pool?.close(); });
const T0 = new Date('2026-10-22T10:00:00Z'); const plus = (ms: number) => new Date(T0.getTime() + ms);
const conn = (userId: string, o: Partial<Parameters<GoogleDriveStore['upsert']>[0]> = {}) => ({ userId, googleAccountId: 'perm-1', accessTokenEnc: 'A1', refreshTokenEnc: 'R1', tokenExpiresAt: plus(3_600_000), scopes: ['https://www.googleapis.com/auth/drive.file'], now: T0, ...o });

describe('GoogleDriveStore (real PostgreSQL)', () => {
  it('OAuth state is single-use, expires, is replaced per user, and expired rows are swept', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const s = new GoogleDriveStore(pool.executor()); const a = await seedTenant(pool.executor(), 1); const b = await seedTenant(pool.executor(), 1);
    await s.createState(a.userId, 'hashA1', 'verA1', T0, plus(600_000));
    assert.deepEqual(await s.consumeState('hashA1', plus(1000)), { userId: a.userId, codeVerifierEnc: 'verA1', expired: false });
    assert.equal(await s.consumeState('hashA1', plus(2000)), null, 'replay is impossible');
    await s.createState(a.userId, 'hashA2', 'v', T0, plus(600_000));
    await s.createState(a.userId, 'hashA3', 'v', T0, plus(600_000)); // starting again invalidates the previous attempt
    assert.equal(await s.consumeState('hashA2', plus(1000)), null);
    await s.createState(b.userId, 'hashB1', 'v', T0, plus(60_000));
    assert.equal((await s.consumeState('hashB1', plus(61_000)))!.expired, true, 'an expired state is reported as expired AND consumed');
    assert.equal(await s.consumeState('hashB1', plus(1000)), null);
    assert.equal((await s.consumeState('hashA3', plus(1000)))!.userId, a.userId, 'another user’s state did not disturb it');
    assert.equal(await s.consumeState('does-not-exist', T0), null);
  });
  it('upsert stores per user, reconnect resets status; a different Google account forgets the folder', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const s = new GoogleDriveStore(pool.executor()); const a = await seedTenant(pool.executor(), 1); const b = await seedTenant(pool.executor(), 1);
    assert.equal(await s.get(a.userId), null);
    const c1 = await s.upsert(conn(a.userId)); assert.deepEqual([c1.status, c1.scopes, c1.appFolderId, c1.accessTokenEnc], ['CONNECTED', ['https://www.googleapis.com/auth/drive.file'], null, 'A1']);
    assert.equal(await s.setAppFolderIfUnset(a.userId, 'folderX', T0), 'folderX');
    assert.equal(await s.setAppFolderIfUnset(a.userId, 'folderY', T0), 'folderX', 'first writer wins');
    await s.markReauth(a.userId, 'AUTH_EXPIRED', T0); assert.equal((await s.get(a.userId))!.status, 'REAUTH_REQUIRED');
    const c2 = await s.upsert(conn(a.userId, { accessTokenEnc: 'A2', now: plus(1000) })); assert.deepEqual([c2.status, c2.lastErrorCode, c2.appFolderId], ['CONNECTED', null, 'folderX']);
    const c3 = await s.upsert(conn(a.userId, { googleAccountId: 'perm-OTHER', now: plus(2000) })); assert.equal(c3.appFolderId, null);
    assert.equal(await s.get(b.userId), null, 'isolated per user');
  });
  it('refresh is compare-and-set; delete removes the row; a user hard-delete cascades', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const db = pool.executor(); const s = new GoogleDriveStore(db); const a = await seedTenant(db, 1);
    await s.upsert(conn(a.userId));
    assert.equal(await s.applyRefreshedAccess(a.userId, 'WRONG', 'A9', plus(5000), T0), false);
    assert.equal(await s.applyRefreshedAccess(a.userId, 'A1', 'A9', plus(5000), T0), true);
    assert.equal((await s.get(a.userId))!.accessTokenEnc, 'A9');
    assert.equal(await s.delete(a.userId), true); assert.equal(await s.delete(a.userId), false);
    await s.upsert(conn(a.userId)); await s.createState(a.userId, 'hCascade', 'v', T0, plus(1000));
    await db.exec(`DELETE FROM users WHERE id = $1`, [a.userId]);
    assert.equal(await s.get(a.userId), null); assert.equal(await s.consumeState('hCascade', T0), null);
  });
});