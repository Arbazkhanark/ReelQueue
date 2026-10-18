import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ProviderError } from '@reelqueue/core';
import type { OAuthPort } from '@reelqueue/services';
import { Client, startStack, signedInUser, WEB_ORIGIN } from './helpers/stack';

class FakeOAuth implements OAuthPort {
  fail = false; used = new Set<string>(); pid = 'IG_HTTP_1';
  buildAuthorizationUrl(state: string) { return `https://www.instagram.com/oauth/authorize?client_id=APP&state=${encodeURIComponent(state)}`; }
  async exchangeCode(code: string) { if (this.fail || this.used.has(code)) throw new ProviderError('VALIDATION', 'x'); this.used.add(code); return { accessToken: 'S', userId: 's', permissions: ['instagram_business_basic', 'instagram_business_content_publish'] }; }
  async exchangeForLongLived() { return { accessToken: 'L', issuedAt: new Date(), expiresAt: new Date(Date.now() + 60 * 86_400_000) }; }
  async refreshLongLived() { return { accessToken: 'L2', issuedAt: new Date(), expiresAt: new Date(Date.now() + 60 * 86_400_000) }; }
  async fetchProfile() { return { userId: this.pid, username: 'http_brand', accountType: 'Business' }; }
}
const raw = (url: string, path: string, cookie: string) => fetch(url + path, { redirect: 'manual', headers: { cookie, 'x-forwarded-for': '10.7.7.7' } });
const jar = (c: { jar: Map<string, string> }) => [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ');

describe('Instagram connect over HTTP (fake Meta)', () => {
  it('connect -> Meta redirect -> callback stores the account and redirects to the web app; state/nonce/session failures never create anything', async (t) => {
    const oauth = new FakeOAuth();
    const st = await startStack({ mockMode: false, oauth });
    if (!st) return t.skip('no PostgreSQL');
    try {
      const u = await signedInUser(st);
      const conn = await u.c.post('/v1/instagram/connect');
      assert.equal(conn.status, 200);
      const state = new URL(conn.body.authorizationUrl).searchParams.get('state')!;
      const setCookie = conn.setCookies.find((c) => c.startsWith('rq_oauth='))!;
      assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Path=\/v1\/instagram/); assert.match(setCookie, /SameSite=Lax/); assert.match(setCookie, /Secure/);
      assert.ok(!conn.body.authorizationUrl.includes('client_secret'));
      const accounts = async () => (await u.c.get('/v1/instagram/accounts')).body as { provider: string; username: string; status: string }[];

      // CSRF-style attacks: no cookie / wrong cookie / other user's session
      const cookieHeader = jar(u.c);
      let r = await raw(st.url, `/v1/instagram/callback?code=C1&state=${encodeURIComponent(state)}`, cookieHeader.replace(/; ?rq_oauth=[^;]*/, '')); // nonce cookie missing
      assert.equal(r.status, 302); assert.equal(r.headers.get('location'), `${WEB_ORIGIN}/accounts?error=STATE_INVALID`);
      const other = await signedInUser(st);
      r = await raw(st.url, `/v1/instagram/callback?code=C1&state=${encodeURIComponent(state)}`, `${jar(other.c)}; rq_oauth=${conn.setCookies.find((c) => c.startsWith('rq_oauth='))!.split(';')[0]!.split('=')[1]}`);
      assert.equal(r.headers.get('location'), `${WEB_ORIGIN}/accounts?error=STATE_INVALID`, 'another logged-in user cannot complete my flow');
      r = await raw(st.url, `/v1/instagram/callback?code=C1&state=${encodeURIComponent(state)}`, `rq_oauth=whatever`); // no session
      assert.equal(r.headers.get('location'), `${WEB_ORIGIN}/accounts?error=SESSION`);
      r = await raw(st.url, `/v1/instagram/callback?error=access_denied&error_reason=user_denied&error_description=secret+text`, cookieHeader);
      assert.equal(r.headers.get('location'), `${WEB_ORIGIN}/accounts?error=ACCESS_DENIED`, 'Meta text is never echoed');
      assert.equal((await accounts()).filter((a) => a.provider === 'META').length, 0);

      // the real thing
      r = await raw(st.url, `/v1/instagram/callback?code=C1&state=${encodeURIComponent(state)}`, cookieHeader);
      assert.equal(r.status, 302); assert.equal(r.headers.get('location'), `${WEB_ORIGIN}/accounts?connected=1`);
      assert.ok(r.headers.getSetCookie().some((c) => /^rq_oauth=;/.test(c) && /Max-Age=0/i.test(c)), 'nonce cookie is cleared');
      const list = await accounts();
      assert.deepEqual(list.map((a) => [a.provider, a.username, a.status]), [['META', 'http_brand', 'CONNECTED']]);
      assert.ok(!JSON.stringify(list).match(/access_token|LONG|"L"|v1:k1/), 'no token or ciphertext in the API');
      // replaying the same callback fails (nonce is cleared in a real browser; here we resend it): the code is single-use
      r = await raw(st.url, `/v1/instagram/callback?code=C1&state=${encodeURIComponent(state)}`, cookieHeader);
      assert.match(r.headers.get('location')!, /error=PROVIDER_ERROR/);
      // another user cannot take the same Instagram account
      const c2 = await other.c.post('/v1/instagram/connect');
      const st2 = new URL(c2.body.authorizationUrl).searchParams.get('state')!;
      r = await raw(st.url, `/v1/instagram/callback?code=C2&state=${encodeURIComponent(st2)}`, jar(other.c));
      assert.match(r.headers.get('location')!, /error=ACCOUNT_IN_USE/);
      assert.equal((await other.c.get('/v1/instagram/accounts')).body.filter((a: { provider: string }) => a.provider === 'META').length, 0);
    } finally { await st.close(); }
  });
  it('without a configured Meta provider the connect route is a 404 and the callback redirects "not enabled"', async (t) => {
    const st = await startStack({ mockMode: true });
    if (!st) return t.skip('no PostgreSQL');
    try {
      const u = await signedInUser(st);
      assert.equal((await u.c.post('/v1/instagram/connect')).status, 404);
      assert.equal((await raw(st.url, '/v1/instagram/callback?code=a&state=b', jar(u.c))).headers.get('location'), `${WEB_ORIGIN}/accounts?error=NOT_ENABLED`);
      assert.equal((await new Client(st.url).post('/v1/instagram/connect')).status, 401, 'connect requires a session');
    } finally { await st.close(); }
  });
});
