import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock, type MediaMetadata, type UploadFileSpec } from '@reelqueue/core';
import { AuthStore, SchedulerStore, VideoStore } from '@reelqueue/db';
import { AppError } from '@reelqueue/shared';
import { UploadService, DEFAULT_UPLOAD_CONFIG, type MediaProbe, type UploadConfig } from '../src';
import { freshDatabase, seedTenant } from '../../db/test/helpers/fixtures';
import type { PsqlPool } from '../../db/test/helpers/psql-executor';
import type { SqlExecutor } from '../../db/src/sql';
import { FakeStorage } from './helpers/fake-storage';

const T0 = new Date('2026-10-17T10:00:00Z');
const MB = 1024 * 1024;
const GOOD: MediaMetadata = { durationMs: 20_000, width: 720, height: 1280, videoCodec: 'h264', audioCodec: 'aac', container: 'mov,mp4' };
const mp4 = (name: string, size = 10 * MB): UploadFileSpec => ({ filename: name, contentType: 'video/mp4', sizeBytes: size });
const cfg = (over: Partial<UploadConfig['limits']> = {}): UploadConfig => ({ ...DEFAULT_UPLOAD_CONFIG, limits: { ...DEFAULT_UPLOAD_CONFIG.limits, quotaBytes: 100 * MB, maxVideos: 50, maxBatchFiles: 10, ...over } });

class FakeProbe implements MediaProbe {
  meta: MediaMetadata | null = GOOD; failures = 0; calls = 0;
  async probe(): Promise<MediaMetadata | null> { this.calls++; if (this.failures > 0) { this.failures--; throw new Error('ffprobe failed'); } return this.meta; }
}
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e) => (e instanceof AppError ? e.code : `THROWN:${(e as Error).message}`));

let pool: PsqlPool | null; let db: SqlExecutor; let clock: FakeClock; let storage: FakeStorage; let probe: FakeProbe; let store: VideoStore; let svc: UploadService;
let n = 0;
async function user(): Promise<string> { const r = await new AuthStore(db).createUser(`up${++n}@example.test`, 'h'); assert.ok(r.ok); return r.user.id; }
function fresh(c: UploadConfig = cfg(), executor?: SqlExecutor) {
  clock = new FakeClock(T0); storage = new FakeStorage(); probe = new FakeProbe();
  store = new VideoStore(executor ?? db); svc = new UploadService(store, storage, probe, clock, c);
}
before(async () => { pool = await freshDatabase(); if (pool) db = pool.executor(); });
after(() => pool?.close());

/** The quota ledger must always equal the truth in the videos table. */
async function assertAccounting(userId: string) {
  const u = (await db.query(`SELECT bytes_used, bytes_reserved, video_count FROM storage_usage WHERE user_id = $1`, [userId]))[0];
  const t = (await db.query(
    `SELECT COALESCE(sum(size_bytes) FILTER (WHERE status = 'READY'), 0) AS ready,
            COALESCE(sum(size_bytes) FILTER (WHERE status IN ('PENDING_UPLOAD','VALIDATING')), 0) AS pending,
            count(*) FILTER (WHERE status IN ('PENDING_UPLOAD','VALIDATING','READY')) AS live
     FROM videos WHERE user_id = $1 AND deleted_at IS NULL`, [userId]))[0]!;
  assert.equal(Number(u?.bytes_used ?? 0), Number(t.ready), 'bytes_used == sum(READY)');
  assert.equal(Number(u?.bytes_reserved ?? 0), Number(t.pending), 'bytes_reserved == sum(pending)');
  assert.equal(Number(u?.video_count ?? 0), Number(t.live), 'video_count == live videos');
}
async function upload(uid: string, files: UploadFileSpec[]) {
  const r = await svc.createBatch(uid, files);
  for (const t of r.uploads) { const f = files[t.index]!; storage.put((await store.getVideo(uid, t.videoId))!.storageKey, f.sizeBytes, f.contentType); }
  return r;
}

describe('UploadService (real PostgreSQL, fake storage + probe)', () => {
  it('createBatch: reserves quota atomically, orders positions, presigns bound to the content type, reports per-file rejects', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    fresh(); const uid = await user();
    const r = await svc.createBatch(uid, [mp4('a.mp4'), { filename: 'b.avi', contentType: 'video/x-msvideo', sizeBytes: 5 }, mp4('c.mp4', 20 * MB), { filename: 'x/y.mp4', contentType: 'video/mp4', sizeBytes: 1 }]);
    assert.deepEqual(r.uploads.map((u) => u.index), [0, 2]);
    assert.deepEqual(r.rejected.map((x) => [x.index, x.code]), [[1, 'UNSUPPORTED_MEDIA'], [3, 'INVALID_NAME']]);
    assert.equal(r.uploads[0]!.headers['Content-Type'], 'video/mp4');
    assert.equal(r.uploads[0]!.expiresAt.getTime(), T0.getTime() + 3600_000);
    const list = await svc.listVideos(uid);
    assert.deepEqual(list.items.map((v) => [v.filename, v.status, v.position]), [['a.mp4', 'PENDING_UPLOAD', 0], ['c.mp4', 'PENDING_UPLOAD', 1]]);
    assert.deepEqual(await svc.usage(uid), { usedBytes: 0, reservedBytes: 30 * MB, quotaBytes: 100 * MB, videoCount: 2, maxVideos: 50, percentUsed: 30, level: 'OK' });
    assert.ok(!list.items[0]!.storageKey.includes('a.mp4'), 'filename is never part of the storage key');
    await assertAccounting(uid);
  });

  it('createBatch: all files rejected -> no batch and no reservation; limits throw typed errors and change nothing', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    fresh(cfg({ maxBatchFiles: 3 })); const uid = await user();
    const r = await svc.createBatch(uid, [{ filename: 'a.gif', contentType: 'image/gif', sizeBytes: 5 }]);
    assert.equal(r.batchId, null); assert.equal(r.rejected.length, 1);
    assert.equal(await code(svc.createBatch(uid, [])), 'UPLOAD_LIMIT_EXCEEDED');
    assert.equal(await code(svc.createBatch(uid, [1, 2, 3, 4].map((i) => mp4(`${i}.mp4`)))), 'UPLOAD_LIMIT_EXCEEDED');
    const big = await svc.createBatch(uid, [{ ...mp4('big.mp4'), sizeBytes: DEFAULT_UPLOAD_CONFIG.limits.maxFileBytes + 1 }]);
    assert.deepEqual([big.batchId, big.rejected.map((x) => x.code)], [null, ['FILE_TOO_LARGE']], 'an oversize file is a per-file reject, not a throw');
    fresh(cfg({ quotaBytes: 25 * MB })); const u2 = await user();
    assert.equal(await code(svc.createBatch(u2, [mp4('a.mp4'), mp4('b.mp4'), mp4('c.mp4')])), 'STORAGE_QUOTA_EXCEEDED');
    assert.equal((await svc.usage(u2)).reservedBytes, 0);
    assert.equal(await db.query(`SELECT 1 FROM upload_batches WHERE user_id = $1`, [u2]).then((x) => x.length), 0);
    await assertAccounting(uid); await assertAccounting(u2);
  });

  it('concurrent batches cannot oversubscribe the quota', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    fresh(cfg({ quotaBytes: 50 * MB })); const uid = await user();
    const rs = await Promise.all(Array.from({ length: 6 }, (_, i) => code(svc.createBatch(uid, [mp4(`${i}.mp4`, 20 * MB)]))));
    assert.equal(rs.filter((r) => r === 'OK').length, 2, rs.join());
    assert.equal(rs.filter((r) => r === 'STORAGE_QUOTA_EXCEEDED').length, 4);
    assert.equal((await svc.usage(uid)).reservedBytes, 40 * MB);
    await assertAccounting(uid);
  });

  it('complete: verifies HEAD + probe, marks READY with metadata, moves reservation to usage, closes the batch', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    fresh(); const uid = await user();
    const b = await upload(uid, [mp4('a.mp4'), mp4('b.mp4', 5 * MB)]);
    const r1 = await svc.complete(uid, b.uploads[0]!.videoId);
    assert.equal(r1.status, 'READY'); assert.equal(r1.video.durationMs, 20_000); assert.equal(r1.video.width, 720);
    assert.equal((await db.query(`SELECT status FROM upload_batches WHERE id = $1`, [b.batchId]))[0]!.status, 'OPEN');
    await svc.complete(uid, b.uploads[1]!.videoId);
    assert.equal((await db.query(`SELECT status, completed_files FROM upload_batches WHERE id = $1`, [b.batchId]))[0]!.status, 'COMPLETED');
    assert.deepEqual(await svc.usage(uid), { usedBytes: 15 * MB, reservedBytes: 0, quotaBytes: 100 * MB, videoCount: 2, maxVideos: 50, percentUsed: 15, level: 'OK' });
    await assertAccounting(uid);
  });

  it('duplicate completion (sequential and 6 concurrent) accounts exactly once', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    fresh(); const uid = await user();
    const b = await upload(uid, [mp4('a.mp4')]); const id = b.uploads[0]!.videoId;
    const rs = await Promise.all(Array.from({ length: 6 }, () => svc.complete(uid, id)));
    assert.ok(rs.every((r) => r.status === 'READY'));
    assert.equal((await svc.complete(uid, id)).status, 'READY');
    assert.equal((await svc.usage(uid)).usedBytes, 10 * MB);
    assert.equal((await db.query(`SELECT completed_files FROM upload_batches WHERE id = $1`, [b.batchId]))[0]!.completed_files, 1);
    await assertAccounting(uid);
  });

  it('missing object: retryable error, nothing changes; works once the object exists', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    fresh(); const uid = await user();
    const b = await svc.createBatch(uid, [mp4('a.mp4')]); const id = b.uploads[0]!.videoId;
    assert.equal(await code(svc.complete(uid, id)), 'INVALID_STATE');
    assert.equal((await store.getVideo(uid, id))!.status, 'PENDING_UPLOAD');
    storage.put((await store.getVideo(uid, id))!.storageKey, 10 * MB);
    assert.equal((await svc.complete(uid, id)).status, 'READY');
    await assertAccounting(uid);
  });

  it('size mismatch: REJECTED, object deleted, reservation released, never resurrected', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    fresh(); const uid = await user();
    const b = await svc.createBatch(uid, [mp4('a.mp4')]); const id = b.uploads[0]!.videoId; const key = (await store.getVideo(uid, id))!.storageKey;
    storage.put(key, 999 * MB); // client lied about the size
    const r = await svc.complete(uid, id);
    assert.equal(r.status, 'REJECTED'); assert.equal(r.reason, 'SIZE_MISMATCH');
    assert.deepEqual(storage.deleted, [key]); assert.equal(storage.objects.has(key), false);
    assert.equal((await svc.usage(uid)).reservedBytes, 0); assert.equal((await svc.usage(uid)).videoCount, 0);
    storage.put(key, 10 * MB); // even a corrected re-upload cannot revive a rejected video
    assert.equal((await svc.complete(uid, id)).status, 'REJECTED');
    assert.equal((await db.query(`SELECT storage_deleted_at FROM videos WHERE id = $1`, [id]))[0]!.storage_deleted_at !== null, true);
    await assertAccounting(uid);
  });

  it('content-type mismatch is rejected', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    fresh(); const uid = await user();
    const b = await svc.createBatch(uid, [mp4('a.mp4')]); const id = b.uploads[0]!.videoId;
    storage.put((await store.getVideo(uid, id))!.storageKey, 10 * MB, 'application/zip');
    assert.equal((await svc.complete(uid, id)).reason, 'CONTENT_TYPE_MISMATCH');
    await assertAccounting(uid);
  });

  it('ffprobe: transient failure retried, repeated failure -> UNREADABLE_MEDIA, no stream / too long rejected', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    fresh(); const uid = await user();
    const b = await upload(uid, [mp4('a.mp4'), mp4('b.mp4'), mp4('c.mp4'), mp4('d.mp4')]);
    const [a, bb, c, d] = b.uploads.map((u) => u.videoId) as [string, string, string, string];
    probe.failures = 1;
    assert.equal(await code(svc.complete(uid, a)), 'INVALID_STATE');
    assert.equal((await svc.complete(uid, a)).status, 'READY', 'second attempt succeeds');
    probe.failures = 99;
    assert.equal(await code(svc.complete(uid, bb)), 'INVALID_STATE');
    assert.equal(await code(svc.complete(uid, bb)), 'INVALID_STATE');
    const dead = await svc.complete(uid, bb);
    assert.deepEqual([dead.status, dead.reason], ['REJECTED', 'UNREADABLE_MEDIA']);
    assert.ok(storage.deleted.includes((await db.query(`SELECT storage_key FROM videos WHERE id = $1`, [bb]))[0]!.storage_key as string));
    probe.failures = 0; probe.meta = null;
    assert.equal((await svc.complete(uid, c)).reason, 'NO_VIDEO_STREAM');
    probe.meta = { ...GOOD, durationMs: 3_600_000 };
    assert.equal((await svc.complete(uid, d)).reason, 'TOO_LONG');
    await assertAccounting(uid);
  });

  it('storage outage during completion changes nothing and is retryable', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    fresh(); const uid = await user();
    const b = await upload(uid, [mp4('a.mp4')]); const id = b.uploads[0]!.videoId;
    storage.failHead = true;
    assert.match(await code(svc.complete(uid, id)), /^THROWN:storage down/);
    assert.equal((await store.getVideo(uid, id))!.status, 'PENDING_UPLOAD');
    storage.failHead = false;
    assert.equal((await svc.complete(uid, id)).status, 'READY');
    await assertAccounting(uid);
  });

  it('failed object deletion still records the rejection; cleanup retries until the object is gone', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    fresh(); const uid = await user();
    const b = await svc.createBatch(uid, [mp4('a.mp4')]); const id = b.uploads[0]!.videoId; const key = (await store.getVideo(uid, id))!.storageKey;
    await svc.cleanup(); // drain leftovers from earlier tests (global sweep)
    storage.put(key, 1); storage.failDelete = true;
    assert.equal((await svc.complete(uid, id)).status, 'REJECTED');
    assert.equal(storage.objects.has(key), true);
    assert.deepEqual(await svc.cleanup(), { abandoned: 0, purged: 0, purgeFailures: 1 });
    storage.failDelete = false;
    assert.deepEqual(await svc.cleanup(), { abandoned: 0, purged: 1, purgeFailures: 0 });
    assert.equal(storage.objects.has(key), false);
    assert.deepEqual(await svc.cleanup(), { abandoned: 0, purged: 0, purgeFailures: 0 });
    await assertAccounting(uid);
  });

  it('database failure mid-completion: no partial state; retry succeeds', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    let armed = false;
    const flaky = (inner: SqlExecutor): SqlExecutor => ({
      query: (sql, p) => (armed && /UPDATE storage_usage SET bytes_reserved = GREATEST/.test(sql) ? (armed = false, Promise.reject(new Error('connection reset'))) : inner.query(sql, p)),
      exec: (sql, p) => (armed && /UPDATE storage_usage SET bytes_reserved = GREATEST/.test(sql) ? (armed = false, Promise.reject(new Error('connection reset'))) : inner.exec(sql, p)),
      transaction: (fn) => inner.transaction((tx) => fn(flaky(tx))),
    });
    fresh(cfg(), flaky(db)); const uid = await user();
    const b = await upload(uid, [mp4('a.mp4')]); const id = b.uploads[0]!.videoId;
    armed = true;
    assert.match(await code(svc.complete(uid, id)), /^THROWN:connection reset/);
    assert.equal((await store.getVideo(uid, id))!.status, 'VALIDATING', 'the READY update was rolled back with the failed accounting update');
    assert.equal((await svc.usage(uid)).usedBytes, 0);
    await assertAccounting(uid);
    assert.equal((await svc.complete(uid, id)).status, 'READY');
    await assertAccounting(uid);
  });

  it('a failing batch insert rolls the whole reservation back', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    fresh(); const uid = await user();
    // both videos get the same storage key -> the second INSERT violates videos_storage_key_key mid-transaction
    await assert.rejects(store.reserveBatch({ userId: uid, files: [mp4('a.mp4'), mp4('b.mp4')], limits: cfg().limits, now: T0, ttlMs: 1000, newKey: () => 'dup/key' }), /videos_storage_key_key|duplicate key/);
    assert.equal((await db.query(`SELECT 1 FROM upload_batches WHERE user_id = $1`, [uid])).length, 0);
    assert.equal((await db.query(`SELECT 1 FROM videos WHERE user_id = $1`, [uid])).length, 0);
    assert.deepEqual([(await svc.usage(uid)).reservedBytes, (await svc.usage(uid)).videoCount], [0, 0]);
    await assertAccounting(uid);
  });

  it('presign failure releases the reservation instead of leaking it', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    fresh(); const uid = await user();
    storage.failPresign = true;
    assert.equal(await code(svc.createBatch(uid, [mp4('a.mp4'), mp4('b.mp4')])), 'INTERNAL');
    assert.deepEqual([(await svc.usage(uid)).reservedBytes, (await svc.usage(uid)).videoCount], [0, 0]);
    await assertAccounting(uid);
  });

  it('tenant isolation: another user cannot complete, delete, list or reorder your videos', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    fresh(); const a = await user(); const b = await user();
    const up = await upload(a, [mp4('secret.mp4')]); const id = up.uploads[0]!.videoId;
    assert.equal(await code(svc.complete(b, id)), 'NOT_FOUND');
    assert.equal(await code(svc.deleteVideo(b, id)), 'NOT_FOUND');
    assert.equal((await svc.listVideos(b)).total, 0);
    assert.equal(await store.getVideo(b, id), null);
    assert.equal((await store.getVideo(a, id))!.status, 'PENDING_UPLOAD', "A's video untouched");
    assert.equal(await code(svc.complete(a, id)), 'OK');
    assert.equal((await svc.usage(b)).videoCount, 0);
    await assertAccounting(a); await assertAccounting(b);
  });

  it('cleanup abandons expired batches, deletes their objects, spares completed videos, and is idempotent', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    fresh(); const uid = await user();
    clock.advanceMs(10 * 24 * 3600_000); await svc.cleanup(); // global sweep: expire + drain batches/objects left by earlier tests so the counts below are about THIS test
    const b = await upload(uid, [mp4('done.mp4'), mp4('late.mp4'), mp4('never.mp4')]);
    const [done, late, never] = b.uploads.map((u) => u.videoId) as [string, string, string];
    await svc.complete(uid, done);
    assert.deepEqual(await svc.cleanup(), { abandoned: 0, purged: 0, purgeFailures: 0 }, 'not expired yet');
    clock.advanceMs(3600_001);
    const r = await svc.cleanup();
    assert.deepEqual(r, { abandoned: 2, purged: 2, purgeFailures: 0 });
    assert.equal((await store.getVideo(uid, done))!.status, 'READY');
    for (const id of [late, never]) { const v = (await store.getVideo(uid, id))!; assert.deepEqual([v.status, v.rejectionReason], ['FAILED', 'UPLOAD_ABANDONED']); }
    assert.equal((await db.query(`SELECT status FROM upload_batches WHERE id = $1`, [b.batchId]))[0]!.status, 'ABANDONED');
    const late2 = await svc.complete(uid, late); // object is gone and the video is dead: no resurrection, no accounting change
    assert.equal(late2.status, 'FAILED');
    assert.deepEqual(await svc.cleanup(), { abandoned: 0, purged: 0, purgeFailures: 0 });
    assert.deepEqual([(await svc.usage(uid)).usedBytes, (await svc.usage(uid)).reservedBytes, (await svc.usage(uid)).videoCount], [10 * MB, 0, 1]);
    await assertAccounting(uid);
  });

  it('delete: READY frees quota and removes the object; a live publishing job blocks it (VIDEO_IN_USE)', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    fresh(); const uid = await user();
    const b = await upload(uid, [mp4('a.mp4'), mp4('b.mp4')]);
    for (const u of b.uploads) await svc.complete(uid, u.videoId);
    const key = (await store.getVideo(uid, b.uploads[0]!.videoId))!.storageKey;
    await svc.deleteVideo(uid, b.uploads[0]!.videoId);
    assert.equal(storage.objects.has(key), false);
    assert.equal(await store.getVideo(uid, b.uploads[0]!.videoId), null);
    assert.deepEqual([(await svc.usage(uid)).usedBytes, (await svc.usage(uid)).videoCount], [10 * MB, 1]);
    assert.equal(await code(svc.deleteVideo(uid, b.uploads[0]!.videoId)), 'NOT_FOUND', 'second delete');
    await assertAccounting(uid);

    const seed = await seedTenant(db, 1);
    const sched = new SchedulerStore(db);
    const c = await sched.createCycle({ userId: seed.userId, accountId: seed.accountId, provider: 'MOCK', batchSize: 1, intervalMinutes: 20, loopEnabled: false, durationHours: 24, now: T0 });
    assert.ok(c.ok);
    await db.exec(
      `INSERT INTO publish_jobs (user_id, cycle_id, instagram_account_id, video_id, sequence_no, iteration, idempotency_key, provider, next_attempt_at)
       VALUES ($1,$2,$3,$4,1,1,'k-in-use','MOCK',$5)`, [seed.userId, c.cycle.id, seed.accountId, seed.videoIds[0], T0]);
    assert.equal(await code(svc.deleteVideo(seed.userId, seed.videoIds[0]!)), 'VIDEO_IN_USE');
    assert.notEqual(await store.getVideo(seed.userId, seed.videoIds[0]!), null);
  });

  it('reorder: needs the complete set, rejects strangers, blocked while a cycle is live', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    fresh(); const seed = await seedTenant(db, 3); const other = await seedTenant(db, 1);
    const [v0, v1, v2] = seed.videoIds as [string, string, string];
    await svc.reorder(seed.userId, [v2, v0, v1]);
    assert.deepEqual((await svc.listVideos(seed.userId)).items.map((v) => v.id), [v2, v0, v1]);
    assert.equal(await code(svc.reorder(seed.userId, [v0, v1])), 'VALIDATION_FAILED', 'missing one');
    assert.equal(await code(svc.reorder(seed.userId, [v0, v0, v1])), 'VALIDATION_FAILED', 'duplicate');
    assert.equal(await code(svc.reorder(seed.userId, [v0, v1, other.videoIds[0]!])), 'VALIDATION_FAILED', "someone else's video");
    assert.deepEqual((await svc.listVideos(seed.userId)).items.map((v) => v.id), [v2, v0, v1], 'unchanged after refusals');
    const c = await new SchedulerStore(db).createCycle({ userId: seed.userId, accountId: seed.accountId, provider: 'MOCK', batchSize: 1, intervalMinutes: 20, loopEnabled: false, durationHours: 24, now: T0 });
    assert.ok(c.ok);
    assert.equal(await code(svc.reorder(seed.userId, [v0, v1, v2])), 'INVALID_STATE');
  });
});
