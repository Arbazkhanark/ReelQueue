import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { TokenCipher, MockInstagramProvider } from '@reelqueue/core';
import { StorageMediaUrlProvider, DbTokenResolver, CompositeProviderResolver, tokenAad } from '../src';

const cipher = new TokenCipher({ keys: { k1: Buffer.alloc(32, 1) }, activeKeyId: 'k1' });
const acct = (o: Record<string, unknown> = {}) => ({ userId: 'u1', provider: 'META' as const, providerAccountId: 'ig1', accessTokenEnc: cipher.encrypt('SECRET', tokenAad('u1', 'ig1')), status: 'CONNECTED', ...o });

describe('production wiring adapters', () => {
  it('media url: presigns the stored key; refuses unavailable videos', async () => {
    const calls: unknown[] = [];
    const m = new StorageMediaUrlProvider({ getStorageKeyForPublishing: async (id) => (id === 'v1' ? 'k/v1.mp4' : null) }, { presignDownload: async (k, o) => { calls.push([k, o]); return `https://x/${k}`; } });
    assert.equal(await m.getFetchUrl('v1', 600), 'https://x/k/v1.mp4');
    assert.deepEqual(calls, [['k/v1.mp4', { expiresSeconds: 600 }]]);
    await assert.rejects(m.getFetchUrl('gone', 60), (e: Error) => e.name === 'MediaUnavailableError' && /not available/.test(e.message));
  });
  it('token resolver: decrypts for META/ACTIVE; fails closed otherwise; error text never contains the token', async () => {
    const r = (a: unknown) => new DbTokenResolver({ getCredentials: async () => a as never }, cipher).resolve('x');
    assert.deepEqual(await r(acct()), { accessToken: 'SECRET', igUserId: 'ig1' });
    const kind = (p: Promise<unknown>, k: string, re: RegExp) => assert.rejects(p, (e: Error & { kind?: string }) => e.name === 'ProviderError' && e.kind === k && re.test(e.message));
    await kind(r(null), 'VALIDATION', /not found/);
    await kind(r(acct({ provider: 'MOCK' })), 'VALIDATION', /Not a real/);
    await kind(r(acct({ status: 'REAUTH_REQUIRED' })), 'AUTH_EXPIRED', /REAUTH_REQUIRED/);
    await kind(r(acct({ status: 'PERMISSION_REVOKED' })), 'PERMISSION_REVOKED', /revoked/);
    await kind(r(acct({ accessTokenEnc: null })), 'AUTH_EXPIRED', /no stored token/);
    // ciphertext copied to a different owner must not decrypt (AAD binding)
    await assert.rejects(r(acct({ userId: 'attacker' })), (e: Error & { kind?: string }) => e.kind === 'AUTH_EXPIRED' && /could not be decrypted/.test(e.message) && !e.message.includes('SECRET'));
  });
  it('provider resolver: MOCK always; META only when configured (never falls back to mock)', () => {
    const mock = new MockInstagramProvider(); const meta = new MockInstagramProvider();
    assert.equal(new CompositeProviderResolver({ mock }).resolve('MOCK'), mock);
    assert.throws(() => new CompositeProviderResolver({ mock }).resolve('META'), /not enabled/);
    assert.equal(new CompositeProviderResolver({ mock, meta }).resolve('META'), meta);
  });
});
