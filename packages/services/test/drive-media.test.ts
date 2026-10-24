import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DriveMediaSigner } from './drive-media';

const T0 = new Date('2026-10-24T10:00:00Z');
const mk = (secret = 'jwt-secret-for-tests', now = () => T0) => new DriveMediaSigner(secret, 'https://api.example.com/', now);
const parts = (url: string) => { const u = new URL(url); return { path: u.pathname, exp: u.searchParams.get('exp')!, sig: u.searchParams.get('sig')! }; };
const ID = '8e157f50-1998-4ffb-8abd-95e58278f6f5';

test('a signed URL verifies for the same video until it expires', () => {
  const s = mk(); const { url, expiresAt } = s.sign(ID, 3600); const p = parts(url);
  assert.equal(p.path, `/v1/media/drive/${ID}`);
  assert.equal(expiresAt.getTime(), T0.getTime() + 3600_000);
  assert.equal(s.verify(ID, p.exp, p.sig), true);
  const later = mk('jwt-secret-for-tests', () => new Date(T0.getTime() + 3600_000));
  assert.equal(later.verify(ID, p.exp, p.sig), false);
  const justBefore = mk('jwt-secret-for-tests', () => new Date(T0.getTime() + 3599_000));
  assert.equal(justBefore.verify(ID, p.exp, p.sig), true);
});
test('a signature is bound to the video id, the expiry and the secret', () => {
  const s = mk(); const p = parts(s.sign(ID, 3600).url);
  assert.equal(s.verify('00000000-0000-4000-8000-000000000000', p.exp, p.sig), false);
  assert.equal(s.verify(ID, String(Number(p.exp) + 1), p.sig), false);
  assert.equal(mk('another-secret').verify(ID, p.exp, p.sig), false);
});
test('malformed input is refused without throwing', () => {
  const s = mk();
  for (const [e, g] of [['', ''], ['abc', 'x'.repeat(43)], ['1792800000', 'short'], ['1792800000', '!!!!!!!!!!!!!!!!!!!!!!!!!!!!'], ['99999999999999', 'a'.repeat(43)]] as const) assert.equal(s.verify(ID, e, g), false);
});
test('ttl is clamped to 60 s .. 24 h', () => {
  const s = mk();
  assert.equal(s.sign(ID, 1).expiresAt.getTime(), T0.getTime() + 60_000);
  assert.equal(s.sign(ID, 10 ** 9).expiresAt.getTime(), T0.getTime() + 86_400_000);
});