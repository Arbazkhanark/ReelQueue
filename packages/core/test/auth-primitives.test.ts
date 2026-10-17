import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { ScryptPasswordHasher, checkPassword, signJwt, verifyJwt, serializeCookie, parseCookies, clearCookie, MemoryRateLimitStore, RateLimiter } from '../src';

const FAST = { N: 1024, r: 8, p: 1, keyLen: 32, saltLen: 16 };
const SECRET = 'x'.repeat(40);

describe('password hashing', () => {
  it('hashes with unique salts, verifies, rejects wrong/garbage', async () => {
    const h = new ScryptPasswordHasher(FAST);
    const a = await h.hash('correct horse battery'), b = await h.hash('correct horse battery');
    assert.notEqual(a, b);
    assert.ok(a.startsWith('scrypt$1024$8$1$'));
    assert.equal(await h.verify('correct horse battery', a), true);
    assert.equal(await h.verify('correct horse batterz', a), false);
    for (const bad of ['', 'x', 'scrypt$1$8$1$AAAA$AAAA', 'argon2$1$2$3$4$5', `scrypt$${2 ** 30}$8$1$${'A'.repeat(16)}$${'A'.repeat(32)}`, 'scrypt$1024$8$1$AA$AA'])
      assert.equal(await h.verify('x', bad), false, bad);
  });
  it('NFKC-normalises so equivalent unicode passwords match', async () => {
    const h = new ScryptPasswordHasher(FAST);
    assert.equal(await h.verify('passéword-long', await h.hash('passéword-long')), true);
  });
  it('needsRehash flags weaker stored params and garbage', async () => {
    const weak = await new ScryptPasswordHasher({ ...FAST, N: 512 }).hash('some long password');
    const h = new ScryptPasswordHasher(FAST);
    assert.equal(h.needsRehash(weak), true);
    assert.equal(h.needsRehash(await h.hash('some long password')), false);
    assert.equal(h.needsRehash('nonsense'), true);
  });
  it('policy is length-first and catches obvious weakness', () => {
    assert.deepEqual(checkPassword('Tr0ub4dor&3-horse-staple'), []);
    assert.ok(checkPassword('short').includes('TOO_SHORT'));
    assert.ok(checkPassword('a'.repeat(129)).includes('TOO_LONG'));
    assert.ok(checkPassword('password1234').includes('TOO_COMMON'));
    assert.ok(checkPassword('arbazkhan-is-great!', { email: 'arbazkhan@x.com' }).includes('CONTAINS_EMAIL'));
    assert.ok(checkPassword('aaaaaaaaaaaaaaaa').includes('LOW_VARIETY'));
  });
});

describe('JWT HS256', () => {
  const now = new Date('2026-10-17T10:00:00Z'); const t = now.getTime() / 1000;
  const claims = { sub: 'u1', iat: t, exp: t + 900, iss: 'rq', aud: 'web' };
  it('round-trips and enforces exp/iss/aud/signature', () => {
    const tok = signJwt(claims, SECRET);
    assert.deepEqual(verifyJwt(tok, SECRET, now, { issuer: 'rq', audience: 'web' }), { ok: true, claims });
    assert.deepEqual(verifyJwt(tok, SECRET, new Date(now.getTime() + 900_000)), { ok: false, error: 'EXPIRED' });
    assert.deepEqual(verifyJwt(tok, SECRET, new Date(now.getTime() - 60_000)), { ok: false, error: 'NOT_YET_VALID' });
    assert.deepEqual(verifyJwt(tok, SECRET, now, { issuer: 'other' }), { ok: false, error: 'BAD_ISSUER' });
    assert.deepEqual(verifyJwt(tok, SECRET, now, { audience: 'other' }), { ok: false, error: 'BAD_AUDIENCE' });
    assert.deepEqual(verifyJwt(tok, 'y'.repeat(40), now), { ok: false, error: 'BAD_SIGNATURE' });
  });
  it('rejects alg=none, tampered payloads and junk; refuses short secrets', () => {
    const tok = signJwt(claims, SECRET);
    const [h, p, s] = tok.split('.');
    const none = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
    assert.equal(verifyJwt(`${none}.${p}.`, SECRET, now).ok, false);
    const evil = Buffer.from(JSON.stringify({ ...claims, sub: 'admin' })).toString('base64url');
    assert.deepEqual(verifyJwt(`${h}.${evil}.${s}`, SECRET, now), { ok: false, error: 'BAD_SIGNATURE' });
    // correctly signed but missing claims
    const body = `${h}.${Buffer.from('{"x":1}').toString('base64url')}`;
    assert.deepEqual(verifyJwt(`${body}.${createHmac('sha256', SECRET).update(body).digest('base64url')}`, SECRET, now), { ok: false, error: 'MALFORMED' });
    for (const j of ['', 'a.b', 'a.b.c.d']) assert.equal(verifyJwt(j, SECRET, now).ok, false);
    assert.throws(() => signJwt(claims, 'short'));
  });
});

describe('cookies', () => {
  it('serialises hardened session cookies', () => {
    assert.equal(serializeCookie('rq_at', 'abc', { secure: true, maxAgeSeconds: 900 }), 'rq_at=abc; Path=/; Max-Age=900; HttpOnly; Secure; SameSite=Lax');
    assert.equal(clearCookie('rq_rt', { path: '/v1/auth' }), 'rq_rt=; Path=/v1/auth; Max-Age=0; HttpOnly; SameSite=Lax');
  });
  it('refuses header-injection and unsafe combos', () => {
    assert.throws(() => serializeCookie('a b', 'x'));
    assert.throws(() => serializeCookie('a', 'x;y'));
    assert.throws(() => serializeCookie('a', 'x\r\nSet-Cookie: z=1'));
    assert.throws(() => serializeCookie('a', 'x', { sameSite: 'None' }));
    assert.throws(() => serializeCookie('a', 'x', { path: '/;Domain=evil' }));
  });
  it('parses defensively, first value wins', () => {
    assert.deepEqual(parseCookies('rq_at=abc; rq_rt=def; rq_at=evil; junk; =x; bad name=1'), { rq_at: 'abc', rq_rt: 'def' });
    assert.deepEqual(parseCookies(undefined), {});
    assert.deepEqual(parseCookies('a=' + 'b'.repeat(9000)), {});
  });
});

describe('rate limiter', () => {
  it('limits per key per window and resets', async () => {
    let now = new Date('2026-10-17T10:00:00Z');
    const rl = new RateLimiter(new MemoryRateLimitStore(), () => now);
    for (let i = 0; i < 3; i++) assert.equal((await rl.check('ip1', 3, 60_000)).allowed, true);
    const d = await rl.check('ip1', 3, 60_000);
    assert.equal(d.allowed, false); assert.equal(d.remaining, 0); assert.equal(d.retryAfterSeconds, 60);
    assert.equal((await rl.check('ip2', 3, 60_000)).allowed, true);
    now = new Date(now.getTime() + 60_001);
    assert.equal((await rl.check('ip1', 3, 60_000)).allowed, true);
  });
  it('bounds memory under a key flood', async () => {
    const store = new MemoryRateLimitStore(100);
    const rl = new RateLimiter(store, () => new Date('2026-10-17T10:00:00Z'));
    for (let i = 0; i < 1000; i++) await rl.check(`k${i}`, 5, 60_000);
    assert.ok((store as unknown as { m: Map<string, unknown> }).m.size <= 100);
  });
});
