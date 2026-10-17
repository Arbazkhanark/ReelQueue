import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock, ProviderError } from '@reelqueue/core';
import { MetaInstagramProvider, classifyMetaError, type HttpFn } from '../src/meta/provider';

const SECRET = 'EAAB-super-secret-token';
const clock = new FakeClock(new Date('2026-10-14T10:00:00Z'));
type Reply = { status: number; body?: unknown; headers?: Record<string, string> } | 'throw';

function make(replies: Reply[], timeoutMs = 50) {
  const seen: { url: string; method: string; body?: string }[] = [];
  const http: HttpFn = async (url, init) => {
    seen.push({ url, method: init.method, ...(init.body ? { body: init.body } : {}) });
    const r = replies.shift();
    if (!r || r === 'throw') throw new Error(`socket hang up ${url}`);
    return { status: r.status, headers: { get: (n) => r.headers?.[n.toLowerCase()] ?? null }, text: async () => (r.body === undefined ? '' : JSON.stringify(r.body)) };
  };
  const p = new MetaInstagramProvider({ baseUrl: 'https://graph.example', graphVersion: 'vX', requestTimeoutMs: timeoutMs },
    { tokens: { resolve: async () => ({ accessToken: SECRET, igUserId: 'IG1' }) }, clock, http });
  return { p, seen };
}
const err = (code: number, status = 400, sub?: number) => ({ status, body: { error: { message: `leaky ${SECRET} http://x`, code, ...(sub ? { error_subcode: sub } : {}) } } });

describe('MetaInstagramProvider (fake HTTP only; endpoint shapes UNVERIFIED)', () => {
  it('is never a mock', () => { const { p } = make([]); assert.equal(p.kind, 'META'); assert.equal(p.isMock, false); });

  it('happy path: container -> status -> publish -> confirm', async () => {
    const { p, seen } = make([
      { status: 200, body: { id: 'C1' } }, { status: 200, body: { status_code: 'FINISHED' } },
      { status: 200, body: { id: 'M1' } }, { status: 200, body: { id: 'M1', permalink: 'https://instagram.com/reel/x' } },
    ]);
    assert.deepEqual(await p.createReelContainer('a', { videoUrl: 'https://cdn/v.mp4', caption: 'hi', idempotencyKey: 'k' }), { containerId: 'C1' });
    assert.equal((await p.getContainerStatus('a', 'C1')).status, 'FINISHED');
    assert.deepEqual(await p.publishContainer('a', 'C1'), { mediaId: 'M1' });
    assert.deepEqual(await p.confirmMedia('a', { mediaId: 'M1', containerId: 'C1' }), { state: 'CONFIRMED', permalink: 'https://instagram.com/reel/x' });
    const create = new URLSearchParams(seen[0]!.body);
    assert.equal(seen[0]!.url, 'https://graph.example/vX/IG1/media');
    assert.equal(create.get('media_type'), 'REELS');
    assert.equal(create.get('video_url'), 'https://cdn/v.mp4');
    assert.equal(seen[2]!.url, 'https://graph.example/vX/IG1/media_publish');
    assert.equal(new URLSearchParams(seen[2]!.body).get('creation_id'), 'C1');
  });

  it('quota is read from the API and malformed quota fails closed', async () => {
    const { p } = make([{ status: 200, body: { data: [{ quota_usage: 3, config: { quota_total: 50, quota_duration: 86400 } }] } }, { status: 200, body: { data: [] } }]);
    assert.deepEqual(await p.getPublishingQuota('a'), { used: 3, total: 50, windowSeconds: 86400, fetchedAt: clock.now() });
    await assert.rejects(p.getPublishingQuota('a'), (e: ProviderError) => e.kind === 'UNKNOWN');
  });

  it('eligibility maps account type and auth errors', async () => {
    const { p } = make([{ status: 200, body: { account_type: 'BUSINESS' } }, { status: 200, body: { account_type: 'PERSONAL' } }, err(190, 401)]);
    assert.deepEqual(await p.checkEligibility('a'), { eligible: true });
    assert.equal((await p.checkEligibility('a') as { reason: string }).reason, 'NOT_PROFESSIONAL_ACCOUNT');
    assert.equal((await p.checkEligibility('a') as { reason: string }).reason, 'TOKEN_EXPIRED');
  });

  it('classifies errors into the taxonomy', () => {
    const k = (c: number, s = 400, sub?: number) => classifyMetaError(s, err(c, s, sub).body).kind;
    assert.equal(k(190, 401), 'AUTH_EXPIRED');
    assert.equal(k(10), 'PERMISSION_REVOKED');
    assert.equal(k(200), 'PERMISSION_REVOKED');
    assert.equal(k(4), 'RATE_LIMITED');
    assert.equal(k(368), 'ACCOUNT_RESTRICTED');
    assert.equal(k(2, 500), 'TRANSIENT');
    assert.equal(k(1, 400, 2207026), 'MEDIA_REJECTED');
    assert.equal(k(100), 'VALIDATION');
    assert.equal(k(999, 418), 'UNKNOWN');
    assert.equal(classifyMetaError(429, null, 7000).retryAfterMs, 7000);
  });

  it('errors never leak the token, URL or Meta free text', async () => {
    const { p } = make([err(190, 401), 'throw', { status: 200, body: 'weird' }]);
    for (const run of [() => p.publishContainer('a', 'C1'), () => p.publishContainer('a', 'C1'), () => p.getPublishingQuota('a')]) {
      await assert.rejects(run(), (e: ProviderError) => {
        assert.ok(!e.message.includes(SECRET) && !e.message.includes('http'), e.message);
        assert.ok(!JSON.stringify(e).includes(SECRET));
        return true;
      });
    }
  });

  it('network failure / abort is TIMEOUT (outcome uncertain); Retry-After is honoured', async () => {
    const { p } = make(['throw', { status: 429, body: { error: { code: 4 } }, headers: { 'retry-after': '12' } }]);
    await assert.rejects(p.publishContainer('a', 'C1'), (e: ProviderError) => e.kind === 'TIMEOUT');
    await assert.rejects(p.publishContainer('a', 'C1'), (e: ProviderError) => e.kind === 'RATE_LIMITED' && e.retryAfterMs === 12000);
  });

  it('a hung request is aborted by the timeout', async () => {
    const http: HttpFn = (_u, init) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('aborted'))));
    const p = new MetaInstagramProvider({ baseUrl: 'https://g.example', graphVersion: 'v', requestTimeoutMs: 20 },
      { tokens: { resolve: async () => ({ accessToken: SECRET, igUserId: 'IG1' }) }, clock, http });
    await assert.rejects(p.publishContainer('a', 'C1'), (e: ProviderError) => e.kind === 'TIMEOUT');
  });

  it('container ERROR keeps only a short code; unknown status is rejected; confirm without media id is INDETERMINATE', async () => {
    const { p } = make([{ status: 200, body: { status_code: 'ERROR', status: 'Some long free text with spaces' } }, { status: 200, body: { status_code: 'WAT' } }]);
    assert.deepEqual(await p.getContainerStatus('a', 'C'), { status: 'ERROR', errorCode: 'ERROR' });
    await assert.rejects(p.getContainerStatus('a', 'C'), (e: ProviderError) => e.kind === 'UNKNOWN');
    assert.deepEqual(await p.confirmMedia('a', { mediaId: null, containerId: 'C' }), { state: 'INDETERMINATE' });
  });
});
