import test from 'node:test';
import assert from 'node:assert/strict';
import { UploadHttpError, xhrPut } from './xhr-upload';
import type { XhrLike } from './xhr-upload';

class FakeXhr implements XhrLike {
  method = '';
  url = '';
  headers: Record<string, string> = {};
  sent: unknown = undefined;
  status = 0;
  timeout = 0;
  withCredentials = true;
  aborted = false;
  upload: XhrLike['upload'] = { onprogress: null };
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onabort: (() => void) | null = null;
  ontimeout: (() => void) | null = null;
  open(m: string, u: string) { this.method = m; this.url = u; }
  setRequestHeader(n: string, v: string) { this.headers[n] = v; }
  send(b: unknown) { this.sent = b; }
  abort() { this.aborted = true; this.onabort?.(); }
}
const blob = new Blob(['abc']);

test('PUTs with the presigned headers (minus forbidden ones), no credentials, reports progress', async () => {
  const x = new FakeXhr();
  const seen: number[] = [];
  const p = xhrPut('https://s3/x', { 'Content-Type': 'video/mp4', 'Content-Length': '3', 'x-amz-meta': 'a' }, blob, (l) => seen.push(l), undefined, () => x);
  x.upload.onprogress?.({ lengthComputable: true, loaded: 2 });
  x.upload.onprogress?.({ lengthComputable: false, loaded: 3 });
  x.status = 200;
  x.onload?.();
  await p;
  assert.equal(x.method, 'PUT');
  assert.equal(x.url, 'https://s3/x');
  assert.deepEqual(x.headers, { 'Content-Type': 'video/mp4', 'x-amz-meta': 'a' });
  assert.equal(x.withCredentials, false);
  assert.deepEqual(seen, [2]);
  assert.equal(x.sent, blob);
});
test('non-2xx rejects with status; 403 explains expiry; network error mentions CORS', async () => {
  let x = new FakeXhr();
  let p = xhrPut('u', {}, blob, () => undefined, undefined, () => x);
  x.status = 500;
  x.onload?.();
  await assert.rejects(p, (e: unknown) => e instanceof UploadHttpError && e.status === 500);
  x = new FakeXhr();
  p = xhrPut('u', {}, blob, () => undefined, undefined, () => x);
  x.status = 403;
  x.onload?.();
  await assert.rejects(p, /expired/);
  x = new FakeXhr();
  p = xhrPut('u', {}, blob, () => undefined, undefined, () => x);
  x.onerror?.();
  await assert.rejects(p, /CORS/);
});
test('abort signal aborts the XHR and rejects Cancelled', async () => {
  const x = new FakeXhr();
  const ac = new AbortController();
  const p = xhrPut('u', {}, blob, () => undefined, ac.signal, () => x);
  ac.abort();
  await assert.rejects(p, /Cancelled/);
  assert.equal(x.aborted, true);
  await assert.rejects(xhrPut('u', {}, blob, () => undefined, ac.signal, () => new FakeXhr()), /Cancelled/);
});
