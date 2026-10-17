import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock, ScryptPasswordHasher, hashToken } from '@reelqueue/core';
import { AuthStore } from '@reelqueue/db';
import { AppError } from '@reelqueue/shared';
import { AuthService, DEFAULT_AUTH_CONFIG, type Mailer } from '../src';
import { freshDatabase } from '../../db/test/helpers/fixtures';
import type { PsqlPool } from '../../db/test/helpers/psql-executor';

const T0 = new Date('2026-10-17T10:00:00Z');
const PW = 'correct-horse-battery-staple';
let pool: PsqlPool | null; let clock: FakeClock; let svc: AuthService;
const sent: { kind: 'verify' | 'reset'; to: string; token: string }[] = [];
const mailer: Mailer = {
  async sendVerificationEmail(to, token) { sent.push({ kind: 'verify', to, token }); },
  async sendPasswordResetEmail(to, token) { sent.push({ kind: 'reset', to, token }); },
};
const code = (p: Promise<unknown>) => p.then(() => 'OK', (e) => (e instanceof AppError ? e.code : `THROWN:${(e as Error).message}`));
const lastToken = (kind: 'verify' | 'reset', to: string) => [...sent].reverse().find((m) => m.kind === kind && m.to === to)!.token;

before(async () => {
  pool = await freshDatabase();
  if (!pool) return;
  clock = new FakeClock(T0);
  svc = new AuthService(new AuthStore(pool.executor()), new ScryptPasswordHasher({ N: 1024, r: 8, p: 1, keyLen: 32, saltLen: 16 }), mailer, clock, { ...DEFAULT_AUTH_CONFIG, jwtSecret: 'j'.repeat(48) });
});
after(() => pool?.close());

async function verifiedUser(email: string) {
  await svc.signup(email, PW);
  await svc.verifyEmail(lastToken('verify', email));
}

describe('AuthService (real PostgreSQL, fake clock + mailer)', () => {
  it('validates input with field-level details; stores only a hash', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    assert.equal(await code(svc.signup('not-an-email', PW)), 'VALIDATION_FAILED');
    assert.equal(await code(svc.signup('weak@example.test', 'short')), 'VALIDATION_FAILED');
    await svc.signup('ok@example.test', PW);
    const row = (await pool.executor().query(`SELECT password_hash FROM users WHERE email = 'ok@example.test'`))[0]!;
    assert.match(String(row.password_hash), /^scrypt\$/);
    assert.ok(!String(row.password_hash).includes(PW));
  });

  it('signup of a taken email is silent (no enumeration, no second mail)', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    await svc.signup('dup@example.test', PW);
    const before = sent.length;
    assert.equal(await code(svc.signup('DUP@example.test', PW)), 'OK');
    assert.equal(sent.length, before);
  });

  it('login requires a verified email; verification is single-use', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    await svc.signup('v@example.test', PW);
    assert.equal(await code(svc.login('v@example.test', PW)), 'EMAIL_NOT_VERIFIED');
    const tok = lastToken('verify', 'v@example.test');
    await svc.verifyEmail(tok);
    assert.equal(await code(svc.verifyEmail(tok)), 'TOKEN_INVALID');
    assert.equal(await code(svc.verifyEmail('garbage')), 'TOKEN_INVALID');
    assert.equal(await code(svc.login('v@example.test', PW)), 'OK');
  });

  it('wrong password and unknown email give the same error; lockout after 5 failures, then expires', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    await verifiedUser('lock@example.test');
    assert.equal(await code(svc.login('nobody@example.test', PW)), 'INVALID_CREDENTIALS');
    for (let i = 0; i < 5; i++) assert.equal(await code(svc.login('lock@example.test', 'wrong-password-123')), 'INVALID_CREDENTIALS');
    assert.equal(await code(svc.login('lock@example.test', PW)), 'ACCOUNT_LOCKED', 'even the right password is refused while locked');
    clock.advanceMs(15 * 60_000 + 1);
    assert.equal(await code(svc.login('lock@example.test', PW)), 'OK');
  });

  it('login -> authenticate -> refresh rotation -> logout', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    await verifiedUser('s@example.test');
    const s1 = await svc.login('S@example.test', PW, { userAgent: 'test', ipHash: 'h' });
    assert.deepEqual(await svc.authenticate(s1.accessToken), { userId: s1.user.id, role: 'USER' });
    clock.advanceMs(60_000);
    const s2 = await svc.refresh(s1.refreshToken);
    assert.notEqual(s2.refreshToken, s1.refreshToken);
    assert.equal((await svc.authenticate(s2.accessToken)).userId, s1.user.id);
    clock.advanceMs(60_000); // beyond the 10s grace: replaying the OLD token is theft
    assert.equal(await code(svc.refresh(s1.refreshToken)), 'UNAUTHENTICATED');
    assert.equal(await code(svc.refresh(s2.refreshToken)), 'UNAUTHENTICATED', 'family revoked by the reuse');
    const s3 = await svc.login('s@example.test', PW);
    await svc.logout(s3.refreshToken);
    assert.equal(await code(svc.refresh(s3.refreshToken)), 'UNAUTHENTICATED');
    await svc.logout(undefined);
  });

  it('access tokens expire, and suspension kicks in immediately', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    await verifiedUser('x@example.test');
    const s = await svc.login('x@example.test', PW);
    assert.equal(await code(svc.authenticate(undefined)), 'UNAUTHENTICATED');
    assert.equal(await code(svc.authenticate('a.b.c')), 'UNAUTHENTICATED');
    await pool.executor().exec(`UPDATE users SET status = 'SUSPENDED' WHERE id = $1`, [s.user.id]);
    assert.equal(await code(svc.authenticate(s.accessToken)), 'UNAUTHENTICATED');
    assert.equal(await code(svc.refresh(s.refreshToken)), 'UNAUTHENTICATED');
    assert.equal(await code(svc.login('x@example.test', PW)), 'ACCOUNT_SUSPENDED');
    await pool.executor().exec(`UPDATE users SET status = 'ACTIVE' WHERE id = $1`, [s.user.id]);
    clock.advanceMs(16 * 60_000);
    assert.equal(await code(svc.authenticate(s.accessToken)), 'UNAUTHENTICATED', 'expired after 15 minutes');
  });

  it('password reset: enumeration-safe request, single-use token, signs out every session', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    await verifiedUser('r@example.test');
    const s = await svc.login('r@example.test', PW);
    const before = sent.length;
    assert.equal(await code(svc.requestPasswordReset('ghost@example.test')), 'OK');
    assert.equal(sent.length, before, 'no mail for unknown address');
    await svc.requestPasswordReset('r@example.test');
    const tok = lastToken('reset', 'r@example.test');
    assert.equal(await code(svc.resetPassword(tok, 'short')), 'VALIDATION_FAILED');
    await svc.resetPassword(tok, 'an-entirely-new-passphrase-9');
    assert.equal(await code(svc.resetPassword(tok, 'yet-another-passphrase-99')), 'TOKEN_INVALID');
    assert.equal(await code(svc.refresh(s.refreshToken)), 'UNAUTHENTICATED');
    assert.equal(await code(svc.login('r@example.test', PW)), 'INVALID_CREDENTIALS');
    assert.equal(await code(svc.login('r@example.test', 'an-entirely-new-passphrase-9')), 'OK');
    const raw = (await pool.executor().query(`SELECT token_hash FROM auth_tokens WHERE purpose='PASSWORD_RESET' AND user_id=$1`, [s.user.id]))[0]!;
    assert.equal(raw.token_hash, hashToken(tok), 'only the hash is stored');
  });

  it('change password needs the current one and signs out other sessions', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    await verifiedUser('cp@example.test');
    const s = await svc.login('cp@example.test', PW);
    assert.equal(await code(svc.changePassword(s.user.id, 'wrong-current-pass', 'another-long-passphrase-1')), 'INVALID_CREDENTIALS');
    await svc.changePassword(s.user.id, PW, 'another-long-passphrase-1');
    assert.equal(await code(svc.refresh(s.refreshToken)), 'UNAUTHENTICATED');
    assert.equal(await code(svc.login('cp@example.test', 'another-long-passphrase-1')), 'OK');
  });

  it('an old low-cost hash is upgraded transparently on login', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const weak = await new ScryptPasswordHasher({ N: 512, r: 8, p: 1, keyLen: 32, saltLen: 16 }).hash(PW);
    const db = pool.executor();
    await db.exec(`INSERT INTO users (email, password_hash, email_verified_at) VALUES ('old@example.test', $1, now())`, [weak]);
    await svc.login('old@example.test', PW);
    const h = String((await db.query(`SELECT password_hash FROM users WHERE email='old@example.test'`))[0]!.password_hash);
    assert.ok(h.startsWith('scrypt$1024$'), h);
  });
});
