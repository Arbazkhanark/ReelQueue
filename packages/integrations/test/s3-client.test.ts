import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FakeClock } from '@reelqueue/core';
import { S3StorageProvider, type FetchFn } from '../src/s3/client';

const cfg = { endpoint: 'https://abc123.r2.cloudflarestorage.com', region: 'auto', bucket: 'reels', credentials: { accessKeyId: 'AK', secretAccessKey: 'SK' }, forcePathStyle: true };
const clock = new FakeClock(new Date('2026-10-14T10:00:00Z'));

describe('S3StorageProvider', () => {
  it('presigns an upload bound to the content type, path-style', async () => {
    const s = new S3StorageProvider(cfg, { clock });
    const p = await s.presignUpload('u/1/v/2/abc.mp4', { contentType: 'video/mp4', expiresSeconds: 900 });
    const url = new URL(p.url);
    assert.equal(url.origin + url.pathname, 'https://abc123.r2.cloudflarestorage.com/reels/u/1/v/2/abc.mp4');
    assert.equal(url.searchParams.get('X-Amz-SignedHeaders'), 'content-type;host');
    assert.equal(url.searchParams.get('X-Amz-Expires'), '900');
    assert.equal(url.searchParams.get('X-Amz-Date'), '20261014T100000Z');
    assert.match(url.searchParams.get('X-Amz-Signature')!, /^[0-9a-f]{64}$/);
    assert.deepEqual(p.headers, { 'Content-Type': 'video/mp4' });
    assert.ok(!p.url.includes('SK'), 'secret must never appear in a URL');
  });
  it('virtual-hosted style puts the bucket in the host', async () => {
    const s = new S3StorageProvider({ ...cfg, forcePathStyle: false }, { clock });
    assert.equal(new URL(await s.presignDownload('k.mp4', { expiresSeconds: 60 })).host, 'reels.abc123.r2.cloudflarestorage.com');
  });
  it('signature changes with key, time and expiry', async () => {
    const s = new S3StorageProvider(cfg, { clock });
    const sig = async (k: string, e: number) => new URL(await s.presignDownload(k, { expiresSeconds: e })).searchParams.get('X-Amz-Signature');
    assert.notEqual(await sig('a', 60), await sig('b', 60));
    assert.notEqual(await sig('a', 60), await sig('a', 61));
  });
  it('HEAD / DELETE are signed requests; 404 is handled; errors leak nothing', async () => {
    const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
    let status = 200;
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, ...init });
      return { status, headers: { get: (n) => ({ 'content-length': '1234', 'content-type': 'video/mp4' } as Record<string, string>)[n] ?? null } };
    };
    const s = new S3StorageProvider(cfg, { clock, fetch: fetchFn });
    assert.deepEqual(await s.head('k.mp4'), { exists: true, sizeBytes: 1234, contentType: 'video/mp4' });
    assert.match(calls[0]!.headers.authorization!, /^AWS4-HMAC-SHA256 Credential=AK\/20261014\/auto\/s3\/aws4_request, SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/);
    status = 404;
    assert.deepEqual(await s.head('missing.mp4'), { exists: false });
    await s.delete('missing.mp4');
    status = 500;
    await assert.rejects(s.head('k.mp4'), (e: Error) => e.message === 'Storage HEAD failed with status 500');
    await assert.rejects(s.delete('k.mp4'), /Storage DELETE failed with status 500/);
  });
});
