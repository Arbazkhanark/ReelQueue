import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock, ProviderError, TokenCipher, createOAuthState, generateNonce } from '@reelqueue/core';
import { AccountStore } from '@reelqueue/db';
import { InstagramConnectService, TokenRefreshService, tokenAad, type OAuthPort } from '../src';
import { freshDatabase, seedTenant } from '../../db/test/helpers/fixtures';
import type { PsqlPool } from '../../db/test/helpers/psql-executor';

const T0 = new Date('2026-10-18T10:00:00Z'); const DAY = 86_400_000, MIN = 60_000;
const cipher = new TokenCipher({ keys: { k1: Buffer.alloc(32, 3) }, activeKeyId: 'k1' });
const SECRET = 's'.repeat(40);
const SCOPES = ['instagram_business_basic', 'instagram_business_content_publish'];
let pool: PsqlPool | null; let db: ReturnType<PsqlPool['executor']>; let accounts: AccountStore; let clock: FakeClock;
before(async () => { pool = await freshDatabase(); if (pool) { db = pool.executor(); accounts = new AccountStore(db); } });
after(() => pool?.close());
beforeEachClock();
function beforeEachClock() { clock = new FakeClock(T0); }

class FakeOAuth implements OAuthPort {
  calls: string[] = []; perms = SCOPES; profile = { userId: 'IG_9001', username: 'brand', accountType: 'Business' as string | null }; fail: ProviderError | null = null; usedCodes = new Set<string>();
  refreshFail: ProviderError | null = null; refreshCount = 0;
  buildAuthorizationUrl(state: string) { return `https://www.instagram.com/oauth/authorize?state=${encodeURIComponent(state)}`; }
  async exchangeCode(code: string) {
    this.calls.push('code'); if (this.fail) throw this.fail;
    if (this.usedCodes.has(code)) throw new ProviderError('VALIDATION', 'used code'); this.usedCodes.add(code);
    return { accessToken: 'SHORT_TOKEN', userId: 'scoped_1', permissions: this.perms };
  }
  async exchangeForLongLived(t: string) { this.calls.push('long:' + t); return { accessToken: 'LONG_TOKEN_1', issuedAt: clock.now(), expiresAt: new Date(clock.now().getTime() + 60 * DAY) }; }
  async refreshLongLived(t: string) { this.calls.push('refresh:' + t); this.refreshCount++; if (this.refreshFail) throw this.refreshFail; return { accessToken: 'LONG_TOKEN_' + (this.refreshCount + 1), issuedAt: clock.now(), expiresAt: new Date(clock.now().getTime() + 60 * DAY) }; }
  async fetchProfile() { this.calls.push('profile'); return this.profile; }
}
const svc = (o: FakeOAuth, warns: Record<string, unknown>[] = []) => new InstagramConnectService(accounts, o, cipher, clock, { stateSecret: SECRET, stateMaxAgeMs: 10 * MIN, requiredScopes: SCOPES }, { warn: (x) => { warns.push(x); } });
const stateOf = (url: string) => new URL(url).searchParams.get('state')!;
const skip = (t: { skip(m: string): void }) => { if (!pool) { t.skip('no PostgreSQL'); return true; } return false; };

describe('Instagram connect (OAuth callback logic; fake Meta, real PostgreSQL)', () => {
  it('happy path: stores an ENCRYPTED long-lived token bound to the owner; never the short token; status CONNECTED', async (t) => {
    if (skip(t)) return;
    clock = new FakeClock(T0);
    const o = new FakeOAuth(); const s = svc(o); const user = (await seedTenant(db, 0)).userId;
    const { authorizationUrl, nonce } = s.start(user);
    const r = await s.complete({ userId: user, code: 'CODE_A', state: stateOf(authorizationUrl), nonce });
    assert.ok(r.ok, JSON.stringify(r));
    assert.deepEqual([r.account.provider, r.account.status, r.account.username, r.account.providerAccountId], ['META', 'CONNECTED', 'brand', 'IG_9001']);
    const row = (await db.query(`SELECT access_token_enc e, granted_scopes g, token_expires_at x FROM instagram_accounts WHERE id = $1`, [r.account.id]))[0]!;
    assert.ok(!String(row.e).includes('LONG_TOKEN') && !String(row.e).includes('SHORT'), 'ciphertext only');
    assert.equal(cipher.decrypt(String(row.e), tokenAad(user, 'IG_9001')), 'LONG_TOKEN_1');
    assert.throws(() => cipher.decrypt(String(row.e), tokenAad('someone-else', 'IG_9001')), 'bound to the owner');
    assert.deepEqual(o.calls, ['code', 'long:SHORT_TOKEN', 'profile']);
    assert.equal(new Date(String(row.x)).getTime() - T0.getTime(), 60 * DAY);
  });
  it('state is bound to the session user, the nonce cookie, freshness and the signature', async (t) => {
    if (skip(t)) return;
    clock = new FakeClock(T0);
    const o = new FakeOAuth(); const warns: Record<string, unknown>[] = []; const s = svc(o, warns);
    const a = (await seedTenant(db, 0)).userId, b = (await seedTenant(db, 0)).userId;
    const { authorizationUrl, nonce } = s.start(a); const state = stateOf(authorizationUrl);
    assert.deepEqual(await s.complete({ userId: b, code: 'c', state, nonce }), { ok: false, reason: 'STATE_INVALID' }, 'another user cannot complete my flow');
    assert.deepEqual(await s.complete({ userId: a, code: 'c', state, nonce: generateNonce() }), { ok: false, reason: 'STATE_INVALID' }, 'leaked state without my cookie is useless');
    assert.deepEqual(await s.complete({ userId: a, code: 'c', state: state.slice(0, -2) + 'xx', nonce }), { ok: false, reason: 'STATE_INVALID' });
    const forged = createOAuthState({ userId: a, nonce, issuedAt: T0.getTime() }, 'f'.repeat(40));
    assert.deepEqual(await s.complete({ userId: a, code: 'c', state: forged, nonce }), { ok: false, reason: 'STATE_INVALID' }, 'wrong signing key');
    clock.advanceMs(11 * MIN);
    assert.deepEqual(await s.complete({ userId: a, code: 'c', state, nonce }), { ok: false, reason: 'STATE_INVALID' }, 'expired');
    assert.deepEqual(o.calls, [], 'Meta is never called before the state is valid');
    assert.ok(warns.every((w) => !JSON.stringify(w).includes(state)), 'state is not logged');
  });
  it('replayed code, missing permission, non-professional account, provider failures: refused without storing anything', async (t) => {
    if (skip(t)) return;
    clock = new FakeClock(T0);
    const user = (await seedTenant(db, 0)).userId; const count = async () => Number((await db.query(`SELECT count(*) n FROM instagram_accounts WHERE user_id = $1 AND provider = 'META'`, [user]))[0]!.n);
    const go = async (o: FakeOAuth, code = 'C' + Math.random()) => { const s = svc(o); const { authorizationUrl, nonce } = s.start(user); return s.complete({ userId: user, code, state: stateOf(authorizationUrl), nonce }); };
    const o1 = new FakeOAuth(); o1.profile.userId = 'IG_REPLAY'; assert.ok((await go(o1, 'ONCE')).ok);
    assert.deepEqual(await go(o1, 'ONCE'), { ok: false, reason: 'PROVIDER_ERROR' }, 'single-use code replay fails at Meta');
    const o2 = new FakeOAuth(); o2.profile.userId = 'IG_2'; o2.perms = ['instagram_business_basic'];
    assert.deepEqual(await go(o2), { ok: false, reason: 'MISSING_PERMISSION' });
    const o3 = new FakeOAuth(); o3.profile = { userId: 'IG_3', username: 'p', accountType: 'Personal' };
    assert.deepEqual(await go(o3), { ok: false, reason: 'NOT_PROFESSIONAL_ACCOUNT' });
    const o4 = new FakeOAuth(); o4.profile.userId = 'IG_4'; o4.fail = new ProviderError('TRANSIENT', 'boom');
    assert.deepEqual(await go(o4), { ok: false, reason: 'PROVIDER_ERROR' });
    assert.equal(await count(), 1, 'only the first successful connect stored an account');
  });
  it('an Instagram account already connected by another user is refused; reconnecting your own refreshes the token in place', async (t) => {
    if (skip(t)) return;
    clock = new FakeClock(T0);
    const a = (await seedTenant(db, 0)).userId, b = (await seedTenant(db, 0)).userId;
    const o = new FakeOAuth(); o.profile.userId = 'IG_SHARED';
    const go = async (u: string) => { const s = svc(o); const { authorizationUrl, nonce } = s.start(u); return s.complete({ userId: u, code: 'C' + Math.random(), state: stateOf(authorizationUrl), nonce }); };
    const first = await go(a); assert.ok(first.ok);
    assert.deepEqual(await go(b), { ok: false, reason: 'ACCOUNT_IN_USE' });
    const again = await go(a); assert.ok(again.ok && first.ok && again.account.id === first.account.id);
  });
});

describe('token refresh service', () => {
  async function connected(expiresInDays: number, issuedDaysAgo: number) {
    clock = new FakeClock(T0);
    const user = (await seedTenant(db, 0)).userId; const pid = 'IG_R' + Math.random().toString(36).slice(2, 8);
    const r = await accounts.upsertMeta({ userId: user, providerAccountId: pid, username: 'u', accountType: 'Business', scopes: SCOPES, tokenEnc: cipher.encrypt('OLD_TOKEN', tokenAad(user, pid)), issuedAt: new Date(T0.getTime() - issuedDaysAgo * DAY), expiresAt: new Date(T0.getTime() + expiresInDays * DAY) });
    assert.ok(r.ok); return { user, pid, id: r.ok ? r.account.id : '' };
  }
  const refresher = (o: FakeOAuth, warns: Record<string, unknown>[] = []) => new TokenRefreshService(accounts, o, cipher, clock, { leadMs: 10 * DAY, claimLeaseMs: 5 * MIN, batch: 500 }, { warn: (x) => { warns.push(x); } });
  const state = async (id: string) => (await db.query(`SELECT status, last_error_code c, access_token_enc e, token_expires_at x FROM instagram_accounts WHERE id = $1`, [id]))[0]!;

  it('refreshes tokens inside the lead window (decrypting the old one, encrypting the new one, extending expiry); leaves healthy ones alone', async (t) => {
    if (skip(t)) return;
    const due = await connected(5, 55), healthy = await connected(40, 20);
    const o = new FakeOAuth(); const rep = await refresher(o).run();
    assert.ok(rep.refreshed >= 1);
    assert.ok(o.calls.includes('refresh:OLD_TOKEN'));
    const d = await state(due.id); assert.equal(cipher.decrypt(String(d.e), tokenAad(due.user, due.pid)).startsWith('LONG_TOKEN_'), true);
    assert.equal(new Date(String(d.x)).getTime() - T0.getTime(), 60 * DAY);
    assert.equal(cipher.decrypt(String((await state(healthy.id)).e), tokenAad(healthy.user, healthy.pid)), 'OLD_TOKEN');
  });
  it('a token younger than 24 h is not refreshed yet (Meta rule); an expired one flags REAUTH_REQUIRED', async (t) => {
    if (skip(t)) return;
    await db.exec(`UPDATE instagram_accounts SET status = 'DISCONNECTED', access_token_enc = NULL WHERE status = 'CONNECTED' AND provider = 'META'`);
    const young = await connected(5, 0.5), dead = await connected(-1, 61);
    const o = new FakeOAuth(); await refresher(o).run();
    assert.equal(o.refreshCount, 0, 'no refresh call was made for a too-young token');
    assert.equal(cipher.decrypt(String((await state(young.id)).e), tokenAad(young.user, young.pid)), 'OLD_TOKEN', 'too young: untouched');
    const dd = await state(dead.id); assert.deepEqual([dd.status, dd.c], ['REAUTH_REQUIRED', 'TOKEN_EXPIRED']);
  });
  it('error handling: AUTH_EXPIRED/PERMISSION_REVOKED flag the account; transient errors keep it CONNECTED and retry next run; logs hold no secrets', async (t) => {
    if (skip(t)) return;
    const warns: Record<string, unknown>[] = [];
    const isolate = () => db.exec(`UPDATE instagram_accounts SET status = 'DISCONNECTED', access_token_enc = NULL WHERE status = 'CONNECTED' AND provider = 'META'`);
    const failing = (err: ProviderError) => { const o = new FakeOAuth(); o.refreshFail = err; return refresher(o, warns); };
    await isolate(); const a = await connected(3, 57); await failing(new ProviderError('AUTH_EXPIRED', 'x')).run();
    assert.equal((await state(a.id)).status, 'REAUTH_REQUIRED');
    await isolate(); const b = await connected(3, 57); await failing(new ProviderError('PERMISSION_REVOKED', 'x')).run();
    assert.equal((await state(b.id)).status, 'PERMISSION_REVOKED');
    await isolate(); const c = await connected(3, 57); const rep = await failing(new ProviderError('TIMEOUT', 'x')).run();
    const cs = await state(c.id); assert.deepEqual([cs.status, cs.c], ['CONNECTED', 'REFRESH_TIMEOUT']); assert.equal(rep.transientFailures, 1);
    const retry = new FakeOAuth(); await refresher(retry).run();
    assert.equal(retry.refreshCount, 1, 'released claim: the next sweep retries');
    assert.equal((await state(c.id)).c, null, 'error cleared after a successful refresh');
    assert.ok(warns.every((w) => !/OLD_TOKEN|LONG_TOKEN|SECRET/.test(JSON.stringify(w))));
  });
  it('two workers sweeping at once refresh each token exactly once', async (t) => {
    if (skip(t)) return;
    await db.exec(`UPDATE instagram_accounts SET status = 'DISCONNECTED', access_token_enc = NULL WHERE status = 'CONNECTED' AND provider = 'META'`);
    const x = await connected(3, 57);
    const o1 = new FakeOAuth(), o2 = new FakeOAuth();
    await Promise.all([refresher(o1).run(), refresher(o2).run()]);
    assert.equal(o1.refreshCount + o2.refreshCount, 1);
    assert.equal(cipher.decrypt(String((await state(x.id)).e), tokenAad(x.user, x.pid)).startsWith('LONG_TOKEN_'), true);
  });
  it('a reconnect during a refresh is not overwritten by the stale refresh result', async (t) => {
    if (skip(t)) return;
    await db.exec(`UPDATE instagram_accounts SET status = 'DISCONNECTED', access_token_enc = NULL WHERE status = 'CONNECTED' AND provider = 'META'`);
    const x = await connected(3, 57);
    const o = new FakeOAuth(); const orig = o.refreshLongLived.bind(o);
    o.refreshLongLived = async (tk) => { const r = await orig(tk); // user reconnects while Meta is answering
      await accounts.upsertMeta({ userId: x.user, providerAccountId: x.pid, username: 'u', accountType: 'Business', scopes: SCOPES, tokenEnc: cipher.encrypt('RECONNECT_TOKEN', tokenAad(x.user, x.pid)), issuedAt: clock.now(), expiresAt: new Date(clock.now().getTime() + 60 * DAY) });
      return r; };
    const rep = await refresher(o).run();
    assert.equal(rep.refreshed, 0);
    assert.equal(cipher.decrypt(String((await state(x.id)).e), tokenAad(x.user, x.pid)), 'RECONNECT_TOKEN');
  });
});
