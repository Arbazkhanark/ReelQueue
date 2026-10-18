import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock, ProviderError } from '@reelqueue/core';
import { MetaOAuthClient } from '../src/meta/oauth';
import type { HttpFn } from '../src/meta/provider';

const cfg = { appId: 'APP', appSecret: 'SUPER_SECRET', redirectUri: 'https://api.example.test/v1/instagram/callback', scopes: ['instagram_business_basic', 'instagram_business_content_publish'], graphVersion: 'v25.0', requestTimeoutMs: 50 };
const T0 = new Date('2026-10-18T10:00:00Z');
type Reply = { status?: number; body?: unknown; raw?: string };
function make(replies: Reply[]) {
  const calls: { url: string; method: string; body?: string; headers: Record<string, string> }[] = [];
  const http: HttpFn = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
    const r = replies.shift() ?? { status: 500 };
    return { status: r.status ?? 200, headers: { get: () => null }, text: async () => r.raw ?? JSON.stringify(r.body ?? {}) };
  };
  return { oauth: new MetaOAuthClient(cfg, { clock: new FakeClock(T0), http }), calls };
}

describe('MetaOAuthClient (fake HTTP only; endpoints from Meta docs read 2026-10-18)', () => {
  it('builds the authorization URL with the documented parameters', () => {
    const u = new URL(make([]).oauth.buildAuthorizationUrl('STATE123'));
    assert.equal(u.origin + u.pathname, 'https://www.instagram.com/oauth/authorize');
    assert.deepEqual(Object.fromEntries(u.searchParams), { client_id: 'APP', redirect_uri: cfg.redirectUri, response_type: 'code', scope: 'instagram_business_basic,instagram_business_content_publish', state: 'STATE123' });
    assert.ok(!u.toString().includes('SUPER_SECRET'), 'the app secret never goes into the browser URL');
  });
  it('exchanges the code with a POST form body (secret in the body, not the URL); accepts data[] and flat shapes', async () => {
    const a = make([{ body: { data: [{ access_token: 'SHORT', user_id: 178414, permissions: ['instagram_business_basic', 'instagram_business_content_publish'] }] } }]);
    assert.deepEqual(await a.oauth.exchangeCode('CODE1'), { accessToken: 'SHORT', userId: '178414', permissions: ['instagram_business_basic', 'instagram_business_content_publish'] });
    const c = a.calls[0]!;
    assert.equal(c.method, 'POST'); assert.equal(c.url, 'https://api.instagram.com/oauth/access_token');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(c.body)), { client_id: 'APP', client_secret: 'SUPER_SECRET', grant_type: 'authorization_code', redirect_uri: cfg.redirectUri, code: 'CODE1' });
    assert.ok(!c.url.includes('CODE1') && !c.url.includes('SUPER_SECRET'));
    const flat = make([{ body: { access_token: 'S2', user_id: 'u2', permissions: 'a,b' } }]);
    assert.deepEqual(await flat.oauth.exchangeCode('c'), { accessToken: 'S2', userId: 'u2', permissions: ['a', 'b'] });
  });
  it('long-lived exchange and refresh use the documented grant types and compute expiry from expires_in', async () => {
    const a = make([{ body: { access_token: 'LONG', token_type: 'bearer', expires_in: 5_184_000 } }, { body: { access_token: 'LONG2', token_type: 'bearer', expires_in: 5_184_000 } }]);
    const l = await a.oauth.exchangeForLongLived('SHORT');
    assert.equal(l.accessToken, 'LONG'); assert.equal(l.expiresAt.getTime() - T0.getTime(), 60 * 86_400_000); assert.equal(l.issuedAt.getTime(), T0.getTime());
    const u1 = new URL(a.calls[0]!.url); assert.equal(u1.origin + u1.pathname, 'https://graph.instagram.com/access_token');
    assert.deepEqual(Object.fromEntries(u1.searchParams), { grant_type: 'ig_exchange_token', client_secret: 'SUPER_SECRET', access_token: 'SHORT' });
    await a.oauth.refreshLongLived('LONG');
    const u2 = new URL(a.calls[1]!.url); assert.equal(u2.origin + u2.pathname, 'https://graph.instagram.com/refresh_access_token');
    assert.deepEqual(Object.fromEntries(u2.searchParams), { grant_type: 'ig_refresh_token', access_token: 'LONG' });
  });
  it('fetches the profile from /<version>/me with user_id, username, account_type', async () => {
    const a = make([{ body: { data: [{ user_id: 'IG1', username: 'brand', account_type: 'Business' }] } }, { body: { user_id: 'IG2' } }]);
    assert.deepEqual(await a.oauth.fetchProfile('T'), { userId: 'IG1', username: 'brand', accountType: 'Business' });
    const u = new URL(a.calls[0]!.url); assert.equal(u.pathname, '/v25.0/me'); assert.equal(u.searchParams.get('fields'), 'user_id,username,account_type');
    assert.deepEqual(await a.oauth.fetchProfile('T'), { userId: 'IG2', username: null, accountType: null });
  });
  it('malformed success bodies fail closed', async () => {
    for (const body of [{}, { data: [] }, { access_token: '' , user_id: 1 }, { access_token: 'x' }]) await assert.rejects(make([{ body }]).oauth.exchangeCode('c'), (e) => e instanceof ProviderError);
    await assert.rejects(make([{ body: { access_token: 'x', expires_in: 'soon' } }]).oauth.refreshLongLived('t'), (e) => e instanceof ProviderError);
    await assert.rejects(make([{ raw: 'not json' }]).oauth.fetchProfile('t'), (e) => e instanceof ProviderError && e.kind === 'UNKNOWN');
  });
  it('errors are classified and sanitised: nothing secret or user-supplied ever appears in the message', async () => {
    const cases: [Reply, string][] = [
      [{ status: 400, body: { error_type: 'OAuthException', code: 400, error_message: 'Invalid authorization code CODE_LEAK' } }, 'VALIDATION'],
      [{ status: 400, body: { error: { code: 190, message: 'token TOK_LEAK expired' } } }, 'AUTH_EXPIRED'],
      [{ status: 429, body: {} }, 'RATE_LIMITED'], [{ status: 503, body: {} }, 'TRANSIENT'],
    ];
    for (const [reply, kind] of cases) {
      const a = make([reply]);
      await assert.rejects(a.oauth.exchangeCode('CODE_LEAK'), (e) => { assert.ok(e instanceof ProviderError); assert.equal(e.kind, kind); assert.ok(!/LEAK|SECRET|APP/.test(e.message), e.message); return true; });
    }
  });
  it('network failure and timeout surface as TIMEOUT (no underlying message)', async () => {
    const down = new MetaOAuthClient(cfg, { clock: new FakeClock(T0), http: async () => { throw new Error('connect ECONNREFUSED https://graph.instagram.com/access_token?client_secret=SUPER_SECRET'); } });
    await assert.rejects(down.refreshLongLived('t'), (e) => e instanceof ProviderError && e.kind === 'TIMEOUT' && !e.message.includes('SUPER_SECRET'));
    const hang = new MetaOAuthClient(cfg, { clock: new FakeClock(T0), http: (_u, i) => new Promise((_r, rej) => i.signal!.addEventListener('abort', () => rej(new Error('aborted')))) });
    await assert.rejects(hang.exchangeCode('c'), (e) => e instanceof ProviderError && e.kind === 'TIMEOUT');
  });
});
