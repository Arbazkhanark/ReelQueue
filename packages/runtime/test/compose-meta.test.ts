import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { FakeClock } from '@reelqueue/core';
import { createApi, createNodeServer } from '@reelqueue/http';
import type { HttpFn } from '@reelqueue/integrations';
import { loadConfig, compose } from '../src';
import { freshDatabase } from '../../db/test/helpers/fixtures';
import type { PsqlPool } from '../../db/test/helpers/psql-executor';
import { FakeStorage } from '../../services/test/helpers/fake-storage';

const key = Buffer.alloc(32, 7).toString('base64');
const WEB = 'https://app.example.test';
const env = {
  DATABASE_URL: 'x', REDIS_URL: 'x', APP_ORIGINS: WEB, JWT_SECRET: 'j'.repeat(40), TOKEN_ENCRYPTION_KEYS: `k1:${key}`, TOKEN_ENCRYPTION_ACTIVE_KEY_ID: 'k1', S3_ENDPOINT: 'http://s3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's',
  INSTAGRAM_PROVIDER: 'meta', META_GRAPH_BASE_URL: 'https://graph.example.test', META_GRAPH_VERSION: 'v25.0', META_APP_ID: 'APP', META_APP_SECRET: 'APP_SECRET_VALUE', META_REDIRECT_URI: 'https://api.example.test/v1/instagram/callback', OAUTH_STATE_SECRET: 's'.repeat(40),
};
let pool: PsqlPool | null = null;
before(async () => { pool = await freshDatabase(); });
after(() => { pool?.close(); });

/** Fake Meta: routes by URL; `refresh` is switchable per test. Records every call so tests can assert on secrets. */
function fakeMeta(igId: string) {
  const seen: string[] = [];
  const state = { refresh: { status: 200, body: { access_token: 'LONG_REFRESHED', token_type: 'bearer', expires_in: 5_184_000 } as unknown } };
  const http: HttpFn = async (url, init) => {
    seen.push(`${init.method} ${url} ${init.body ?? ''}`);
    const reply = (status: number, body: unknown) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    if (url.startsWith('https://api.instagram.com/oauth/access_token')) return reply(200, { data: [{ access_token: 'SHORT', user_id: igId, permissions: ['instagram_business_basic', 'instagram_business_content_publish'] }] });
    if (url.startsWith('https://graph.instagram.com/access_token')) return reply(200, { access_token: 'LONG_ORIGINAL', token_type: 'bearer', expires_in: 5_184_000 });
    if (url.startsWith('https://graph.instagram.com/refresh_access_token')) return reply(state.refresh.status, state.refresh.body);
    if (url.includes('/me?')) return reply(200, { user_id: igId, username: 'brand', account_type: 'Business' });
    return reply(404, {});
  };
  return { http, seen, state };
}

async function boot(o: { clock: FakeClock; http: HttpFn; extraEnv?: Record<string, string> }) {
  const cfg = loadConfig({ ...env, ...o.extraEnv });
  const mails: { to: string; token: string }[] = [];
  const c = compose({ cfg, db: pool!.executor(), clock: o.clock, queue: { wakeCycle: async () => undefined, wakeJob: async () => undefined }, storage: new FakeStorage(), logger: { info: () => undefined, error: () => undefined }, metaHttp: o.http,
    mailer: { sendVerificationEmail: async (to, token) => { mails.push({ to, token }); }, sendPasswordResetEmail: async () => undefined } });
  const server: Server = createNodeServer(createApi({ ...c.apiDeps, checks: { database: async () => true, redis: async () => true } }), { trustProxy: true });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { c, cfg, mails, server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}
const call = async (url: string, method: string, path: string, body?: unknown, cookie = '') => {
  const r = await fetch(url + path, { method, redirect: 'manual', headers: { origin: WEB, 'x-forwarded-for': '10.9.9.9', ...(body ? { 'content-type': 'application/json' } : {}), ...(cookie ? { cookie } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, location: r.headers.get('location'), body: await r.json().catch(() => undefined) as any, setCookies: r.headers.getSetCookie(), cookie: r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
async function signIn(url: string, mails: { to: string; token: string }[], email: string) {
  assert.equal((await call(url, 'POST', '/v1/auth/register', { email, password: 'correct-horse-battery-staple' })).status, 202);
  assert.equal((await call(url, 'POST', '/v1/auth/verify-email', { token: mails.filter((m) => m.to === email).pop()!.token })).status, 204);
  const login = await call(url, 'POST', '/v1/auth/login', { email, password: 'correct-horse-battery-staple' });
  assert.equal(login.status, 200); return login.cookie;
}
const stateOf = (authUrl: string) => new URL(authUrl).searchParams.get('state')!;
const accountRows = (email: string) => pool!.executor().query<{ status: string; reauth_reason: string | null; token_expires_at: Date | null; id: string }>(
  `SELECT a.id, a.status, a.last_error_code AS reauth_reason, a.token_expires_at FROM instagram_accounts a JOIN users u ON u.id = a.user_id WHERE u.email = $1 AND a.provider = 'META'`, [email]);

describe('runtime composition: Meta mode, OAuth + refresh + shared limiter (real PostgreSQL, FAKE Meta HTTP)', () => {
  it('connect -> callback through the composed API stores an encrypted token and the app secret never reaches the browser; refresh keeps the account alive', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const clock = new FakeClock(new Date('2026-10-18T10:00:00Z')); const meta = fakeMeta('IG_RT_1');
    const { c, mails, server, url } = await boot({ clock, http: meta.http });
    try {
      const cookie = await signIn(url, mails, 'rt1@example.test');
      const conn = await call(url, 'POST', '/v1/instagram/connect', undefined, cookie);
      assert.equal(conn.status, 200);
      assert.ok(!JSON.stringify(conn.body).includes('APP_SECRET_VALUE'));
      const nonce = conn.setCookies.find((x) => x.startsWith('rq_oauth='))!.split(';')[0]!;
      const cb = await call(url, 'GET', `/v1/instagram/callback?code=CODE1&state=${encodeURIComponent(stateOf(conn.body.authorizationUrl))}`, undefined, `${cookie}; ${nonce}`);
      assert.equal(cb.status, 302); assert.equal(cb.location, `${WEB}/accounts?connected=1`);
      const [row] = await accountRows('rt1@example.test');
      assert.equal(row!.status, 'CONNECTED');
      const enc = await pool.executor().query<{ e: string }>(`SELECT access_token_enc AS e FROM instagram_accounts WHERE id = $1`, [row!.id]);
      assert.ok(!enc[0]!.e.includes('LONG_ORIGINAL'), 'token is stored encrypted');
      assert.ok(!(await call(url, 'GET', '/v1/instagram/accounts', undefined, cookie)).body.toString().includes('LONG'), 'and never returned');

      // not due yet: nothing to do
      assert.equal((await c.tokenRefresh!.run()).refreshed, 0);
      // 55 days later (10 d before expiry) the worker refreshes it with the documented grant
      clock.advanceMs(55 * 86_400_000);
      const rep = await c.tokenRefresh!.run();
      assert.equal(rep.refreshed, 1);
      assert.ok(meta.seen.some((s) => s.startsWith('GET https://graph.instagram.com/refresh_access_token?grant_type=ig_refresh_token')));
      const [after1] = await accountRows('rt1@example.test');
      assert.ok(new Date(after1!.token_expires_at as unknown as string).getTime() > clock.now().getTime() + 59 * 86_400_000, 'expiry extended by ~60 days');
    } finally { server.close(); server.closeAllConnections(); }
  });

  it('refresh failures: an expired/revoked token marks the account for reconnect; a transient failure keeps it CONNECTED and is retried', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const clock = new FakeClock(new Date('2026-10-18T10:00:00Z')); const meta = fakeMeta('IG_RT_2');
    const { c, mails, server, url } = await boot({ clock, http: meta.http });
    try {
      const cookie = await signIn(url, mails, 'rt2@example.test');
      const conn = await call(url, 'POST', '/v1/instagram/connect', undefined, cookie);
      await call(url, 'GET', `/v1/instagram/callback?code=C&state=${encodeURIComponent(stateOf(conn.body.authorizationUrl))}`, undefined, `${cookie}; ${conn.setCookies.find((x) => x.startsWith('rq_oauth='))!.split(';')[0]}`);
      clock.advanceMs(55 * 86_400_000);

      meta.state.refresh = { status: 500, body: { error: { message: 'oops', code: 2 } } };
      let rep = await c.tokenRefresh!.run();
      assert.equal(rep.transientFailures, 1);
      assert.equal((await accountRows('rt2@example.test'))[0]!.status, 'CONNECTED', 'a Meta outage must not disconnect anybody');

      meta.state.refresh = { status: 400, body: { error: { message: 'Invalid OAuth access token', code: 190 } } };
      rep = await c.tokenRefresh!.run();
      assert.equal(rep.needsAuth, 1);
      const [row] = await accountRows('rt2@example.test');
      assert.notEqual(row!.status, 'CONNECTED');
      assert.equal((await c.tokenRefresh!.run()).refreshed, 0, 'accounts needing re-auth are not retried forever');
    } finally { server.close(); server.closeAllConnections(); }
  });

  it('two API replicas share ONE rate-limit counter in PostgreSQL', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const clock = new FakeClock(new Date('2026-10-18T10:00:00Z'));
    const a = await boot({ clock, http: fakeMeta('x').http }); const b = await boot({ clock, http: fakeMeta('x').http });
    try {
      const k = `shared-test:${Date.now()}`;
      const r = [await a.c.apiDeps.limiter.check(k, 3, 60_000), await b.c.apiDeps.limiter.check(k, 3, 60_000), await a.c.apiDeps.limiter.check(k, 3, 60_000), await b.c.apiDeps.limiter.check(k, 3, 60_000)];
      assert.deepEqual(r.map((x) => x.allowed), [true, true, true, false], 'the 4th hit is refused even though it landed on the other replica');
      clock.advanceMs(61_000);
      assert.equal((await a.c.apiDeps.limiter.check(k, 3, 60_000)).allowed, true, 'window expired');
      assert.ok((await a.c.rateStore.purgeExpired(new Date(clock.now().getTime() + 120_000))) >= 1);
    } finally { a.server.close(); a.server.closeAllConnections(); b.server.close(); b.server.closeAllConnections(); }
  });

  it('the composed RetentionService is wired to real stores and runs cleanly (behavior is covered in db/services retention tests)', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const clock = new FakeClock(new Date('2026-10-18T10:00:00Z'));
    const { c, server } = await boot({ clock, http: fakeMeta('y').http });
    try {
      const rep = await c.retention.run();
      assert.deepEqual(Object.keys(rep).sort(), ['usersDeferred', 'usersDeleted', 'videosDeleted', 'videosScrubbed']);
    } finally { server.close(); server.closeAllConnections(); }
  });
});
