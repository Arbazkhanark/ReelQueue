import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { FakeClock } from '@reelqueue/core';
import { createApi, createNodeServer } from '@reelqueue/http';
import { loadConfig, compose } from '../src';
import { freshDatabase } from '../../db/test/helpers/fixtures';
import type { PsqlPool } from '../../db/test/helpers/psql-executor';
import { FakeStorage } from '../../services/test/helpers/fake-storage';

const key = Buffer.alloc(32, 7).toString('base64');
const env = { DATABASE_URL: 'x', REDIS_URL: 'x', APP_ORIGINS: 'https://app.example.test', JWT_SECRET: 'j'.repeat(40), TOKEN_ENCRYPTION_KEYS: `k1:${key}`, TOKEN_ENCRYPTION_ACTIVE_KEY_ID: 'k1', S3_ENDPOINT: 'http://s3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's' };
let pool: PsqlPool | null = null;
before(async () => { pool = await freshDatabase(); });
after(() => { pool?.close(); });

async function boot(provider: 'mock' | 'meta') {
  const cfg = loadConfig({ ...env, INSTAGRAM_PROVIDER: provider, ...(provider === 'meta' ? { META_GRAPH_BASE_URL: 'https://graph.example.test', META_GRAPH_VERSION: 'v0.0' } : {}) });
  const mails: { to: string; token: string }[] = [];
  const c = compose({ cfg, db: pool!.executor(), clock: new FakeClock(new Date()), queue: { wakeCycle: async () => undefined, wakeJob: async () => undefined }, storage: new FakeStorage(), logger: { info: () => undefined, error: () => undefined },
    mailer: { sendVerificationEmail: async (to, token) => { mails.push({ to, token }); }, sendPasswordResetEmail: async () => undefined } });
  const handle = createApi({ ...c.apiDeps, checks: { database: async () => true, redis: async () => true } });
  const server: Server = createNodeServer(handle, { trustProxy: true });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { c, mails, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const signIn = async (url: string, mails: { to: string; token: string }[], email: string) => {
  assert.equal((await call(url, 'POST', '/v1/auth/register', { email, password: 'correct-horse-battery-staple' })).status, 202);
  assert.equal((await call(url, 'POST', '/v1/auth/verify-email', { token: mails.filter((m) => m.to === email).pop()!.token })).status, 204);
  const login = await call(url, 'POST', '/v1/auth/login', { email, password: 'correct-horse-battery-staple' });
  assert.equal(login.status, 200); return login;
};
const call = async (url: string, method: string, path: string, body?: unknown, cookie = '') => {
  const r = await fetch(url + path, { method, headers: { origin: 'https://app.example.test', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json().catch(() => undefined) as any, cookie: r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') }; // eslint-disable-line @typescript-eslint/no-explicit-any
};

describe('composition root (real PostgreSQL)', () => {
  it('mock mode: a user can register, sign in, connect a mock account; dashboard flags simulation; worker runner is wired', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { c, mails, server, url } = await boot('mock');
    try {
      const login = await signIn(url, mails, 'a@example.test');
      assert.equal((await call(url, 'POST', '/v1/instagram/mock-connect', { username: 'demo' }, login.cookie)).status, 201);
      const dash = await call(url, 'GET', '/v1/dashboard', undefined, login.cookie);
      assert.equal(dash.status, 200); assert.equal(dash.body.mockMode, true);
      assert.deepEqual(await c.runner.sweep(), { jobs: 0, cycles: 0 });
    } finally { server.close(); server.closeAllConnections(); }
  });
  it('meta mode: mock-connect is refused (404) so simulated accounts cannot exist next to real ones', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const { c, mails, server, url } = await boot('meta');
    try {
      const login = await signIn(url, mails, 'b@example.test');
      assert.equal((await call(url, 'POST', '/v1/instagram/mock-connect', { username: 'demo' }, login.cookie)).status, 404);
      assert.equal((await call(url, 'GET', '/v1/dashboard', undefined, login.cookie)).body.mockMode, false);
      assert.equal(c.mockMode, false);
    } finally { server.close(); server.closeAllConnections(); }
  });
});
