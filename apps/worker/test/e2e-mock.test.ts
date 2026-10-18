import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { FakeClock } from '@reelqueue/core';
import { createApi, createNodeServer } from '@reelqueue/http';
import { BullWakeQueue, compose, loadConfig, type BullQueueLike } from '@reelqueue/runtime';
import { makeProcessor, Sweeper } from '../src';
import { freshDatabase } from '../../../packages/db/test/helpers/fixtures';
import type { PsqlPool } from '../../../packages/db/test/helpers/psql-executor';
import { FakeStorage } from '../../../packages/services/test/helpers/fake-storage';

/** Stand-in for Redis/BullMQ: delayed jobs, jobId de-duplication while present, can be wiped (Redis flush). */
class DelayQueue implements BullQueueLike {
  jobs: { name: string; id: string; jobId: string; runAt: number }[] = [];
  constructor(private readonly now: () => number) {}
  async add(name: string, data: Record<string, unknown>, o: { jobId: string; delay: number }) {
    if (this.jobs.some((j) => j.jobId === o.jobId)) return;
    this.jobs.push({ name, id: String(data.id), jobId: o.jobId, runAt: this.now() + o.delay });
  }
  take(until: number) { const d = this.jobs.filter((j) => j.runAt <= until).sort((a, b) => a.runAt - b.runAt)[0]; if (d) this.jobs.splice(this.jobs.indexOf(d), 1); return d; }
}

const key = Buffer.alloc(32, 9).toString('base64');
const env = { DATABASE_URL: 'x', REDIS_URL: 'x', APP_ORIGINS: 'https://app.example.test', JWT_SECRET: 'j'.repeat(40), TOKEN_ENCRYPTION_KEYS: `k1:${key}`, TOKEN_ENCRYPTION_ACTIVE_KEY_ID: 'k1', S3_ENDPOINT: 'http://s3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's' };
const MIN = 60_000, MB = 1024 * 1024;
let pool: PsqlPool | null = null;
before(async () => { pool = await freshDatabase(); });
after(() => { pool?.close(); });

describe('mock-mode end-to-end through the PRODUCTION wiring (config -> compose -> HTTP API -> BullWakeQueue -> processor -> runner)', () => {
  it('register -> mock account -> upload -> 20-min cycle -> SIMULATED jobs -> Redis flush recovered by sweeper -> pause/resume/loop/stop', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const db = pool.executor();
    const clock = new FakeClock(new Date('2026-10-14T10:00:00Z'));
    const wake = new DelayQueue(() => clock.now().getTime());
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const storage = new FakeStorage();
    const mails: { to: string; token: string }[] = [];
    const c = compose({ cfg: loadConfig(env), db, clock, queue: new BullWakeQueue(wake, () => clock.now(), log), storage, logger: log,
      probe: { probe: async () => ({ durationMs: 20_000, width: 720, height: 1280, videoCodec: 'h264', audioCodec: 'aac', container: 'mov,mp4' }) },
      mailer: { sendVerificationEmail: async (to, token) => { mails.push({ to, token }); }, sendPasswordResetEmail: async () => undefined }, rngSeed: 5 });
    const server: Server = createNodeServer(createApi({ ...c.apiDeps, checks: { database: async () => true, redis: async () => true } }), { trustProxy: true });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    let cookie = '';
    const call = async (method: string, path: string, body?: unknown) => {
      const r = await fetch(url + path, { method, headers: { origin: 'https://app.example.test', 'x-forwarded-for': '10.9.9.9', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, ...(body !== undefined ? { body: JSON.stringify(body) } : {}) });
      const sc = r.headers.getSetCookie(); if (sc.length) cookie = sc.map((x) => x.split(';')[0]).join('; ');
      const text = await r.text(); return { status: r.status, body: text ? JSON.parse(text) : undefined };
    };
    const proc = makeProcessor(c.runner, 'w-test', log);
    /** Run worker + sweeper behaviour up to `minutes` from now in virtual time; re-login afterwards (15-min access tokens). */
    const run = async (minutes: number) => {
      const target = clock.now().getTime() + minutes * MIN;
      for (let j = wake.take(target); j; j = wake.take(target)) { if (j.runAt > clock.now().getTime()) clock.set(new Date(j.runAt)); await proc({ name: j.name, data: { id: j.id } }); }
      clock.set(new Date(target));
      assert.equal((await call('POST', '/v1/auth/refresh')).status, 200);
    };
    try {
      assert.equal((await call('POST', '/v1/auth/register', { email: 'e2e@example.test', password: 'correct-horse-battery-staple' })).status, 202);
      assert.equal((await call('POST', '/v1/auth/verify-email', { token: mails.pop()!.token })).status, 204);
      assert.equal((await call('POST', '/v1/auth/login', { email: 'e2e@example.test', password: 'correct-horse-battery-staple' })).status, 200);
      const acc = await call('POST', '/v1/instagram/mock-connect', { username: 'e2e_demo' }); assert.equal(acc.status, 201);

      const init = await call('POST', '/v1/uploads/init', { files: ['a', 'b', 'c'].map((n) => ({ filename: `${n}.mp4`, contentType: 'video/mp4', sizeBytes: 5 * MB })) });
      assert.equal(init.status, 200);
      for (const tg of init.body.targets) storage.put((await db.query(`SELECT storage_key FROM videos WHERE id = $1`, [tg.videoId]))[0]!.storage_key as string, 5 * MB);
      const done = await call('POST', `/v1/uploads/${init.body.batchId}/complete`, { uploaded: init.body.targets.map((x: { videoId: string }) => x.videoId) });
      assert.deepEqual(done.body.videos.map((v: { status: string }) => v.status), ['READY', 'READY', 'READY']);

      // default 20-minute interval, batch of 2
      const st = await call('POST', '/v1/cycles', { instagramAccountId: acc.body.id, batchSize: 2, loopEnabled: true });
      assert.equal(st.status, 201, JSON.stringify(st.body)); assert.equal(st.body.intervalMinutes, 20);
      await run(1);
      let jobs = (await call('GET', '/v1/jobs')).body.items as { status: string; isMock: boolean }[];
      assert.equal(jobs.length, 2, 'first batch of 2 materialised at start');
      assert.ok(jobs.every((j) => j.isMock && !['ACCEPTED', 'CONFIRMED'].includes(j.status)), 'mock results are never ACCEPTED/CONFIRMED');

      // Redis is flushed: all pending wakes vanish. The DB still knows what is due; the sweeper recovers it.
      wake.jobs.length = 0;
      await run(25);
      jobs = (await call('GET', '/v1/jobs')).body.items;
      const before = jobs.length;
      const sw = new Sweeper(c.runner, { intervalMs: 1000, jitterMs: 0 }, log); await sw.runOnce();
      await run(1);
      jobs = (await call('GET', '/v1/jobs')).body.items;
      assert.ok(jobs.length > before || jobs.length === 3, `sweeper recovered the lost wake (jobs ${before} -> ${jobs.length})`);

      await run(45);
      jobs = (await call('GET', '/v1/jobs')).body.items;
      assert.ok(jobs.length >= 3);
      assert.ok(jobs.every((j) => j.status === 'SIMULATED' || j.status === 'SCHEDULED'), `statuses: ${jobs.map((j) => j.status)}`);
      assert.ok(jobs.filter((j) => j.status === 'SIMULATED').length >= 2);
      const cyc = (await call('GET', '/v1/cycles/current')).body;
      assert.equal(cyc.counts.published, 0, 'nothing counted as really published'); assert.ok(cyc.counts.simulated >= 2);

      // pause stops new batches; resume continues; loop toggles; stop ends
      const id = cyc.id;
      assert.equal((await call('POST', `/v1/cycles/${id}/pause`)).body.status, 'PAUSED');
      const n0 = ((await call('GET', '/v1/jobs')).body.items as unknown[]).length;
      await run(60);
      assert.equal(((await call('GET', '/v1/jobs')).body.items as unknown[]).length, n0, 'no new jobs while paused');
      assert.equal((await call('POST', `/v1/cycles/${id}/resume`)).body.status, 'ACTIVE');
      assert.equal((await call('PATCH', `/v1/cycles/${id}`, { loopEnabled: false })).body.loopEnabled, false);
      assert.equal((await call('PATCH', `/v1/cycles/${id}`, { loopEnabled: true })).body.loopEnabled, true);
      await run(90);
      assert.ok(((await call('GET', '/v1/jobs')).body.items as unknown[]).length > n0, 'looping keeps producing jobs after resume');
      assert.equal((await call('POST', `/v1/cycles/${id}/stop`)).body.status, 'STOPPED');
      await run(60);
      assert.equal((await call('GET', '/v1/cycles/current')).body?.status ?? 'STOPPED', 'STOPPED');
      const hist = (await call('GET', '/v1/cycles')).body; assert.equal(hist.items[0].status, 'STOPPED');
    } finally { server.close(); server.closeAllConnections(); }
  });
});
