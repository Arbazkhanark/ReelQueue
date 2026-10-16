import test from 'node:test';
import assert from 'node:assert/strict';
import { createUploadSession } from './upload-runner';
import type { UploadFn } from './upload-runner';
import { failedVideoIds, uploadedVideoIds } from './upload-queue';

const mk = (n: number) => ({
  type: 'INIT' as const,
  files: Array.from({ length: n }, (_, i) => ({ index: i, filename: `f${i}.mp4`, sizeBytes: 1000 })),
  targets: Array.from({ length: n }, (_, i) => ({ index: i, videoId: `v${i}` })),
  rejected: [],
});
const tick = (ms = 1) => new Promise((r) => setTimeout(r, ms));

test('never exceeds 4 concurrent uploads and uploads all 200 files', async () => {
  let active = 0;
  let max = 0;
  let done = 0;
  const upload: UploadFn = async (_it, _sig, onProgress) => {
    active++;
    max = Math.max(max, active);
    onProgress(500);
    await tick(1);
    active--;
    done++;
  };
  const s = createUploadSession(upload);
  s.init(mk(200));
  await s.start();
  assert.equal(max, 4);
  assert.equal(done, 200);
  assert.equal(uploadedVideoIds(s.getState()).length, 200);
  assert.deepEqual(failedVideoIds(s.getState()), []);
});
test('failed files stay failed (no hidden retry) and can be retried individually', async () => {
  const attempts = new Map<number, number>();
  const upload: UploadFn = async ({ index }) => {
    const n = (attempts.get(index) ?? 0) + 1;
    attempts.set(index, n);
    if ((index === 1 || index === 3) && n === 1) throw new Error(`net ${index}`);
  };
  const s = createUploadSession(upload);
  s.init(mk(5));
  await s.start();
  assert.deepEqual(failedVideoIds(s.getState()), ['v1', 'v3']);
  assert.equal(s.getState().items[1]!.error, 'net 1');
  assert.equal(attempts.get(1), 1);
  await s.retry(1);
  assert.deepEqual(failedVideoIds(s.getState()), ['v3']);
  assert.equal(attempts.get(1), 2);
  assert.equal(attempts.get(3), 1, 'other failed file untouched');
  await s.retryAll();
  assert.deepEqual(failedVideoIds(s.getState()), []);
  assert.equal(uploadedVideoIds(s.getState()).length, 5);
});
test('progress flows into state and onChange fires', async () => {
  const seen: number[] = [];
  const upload: UploadFn = async (_i, _s, p) => {
    p(250);
    p(750);
  };
  const s = createUploadSession(upload, (st) => seen.push(st.items[0]!.loaded));
  s.init(mk(1));
  await s.start();
  assert.ok(seen.includes(250) && seen.includes(750));
  assert.equal(s.getState().items[0]!.loaded, 1000);
});
test('cancel aborts the signal and fails queued items; retry afterwards works', async () => {
  let aborted = 0;
  const upload: UploadFn = (_i, signal) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => {
        aborted++;
        reject(new Error('Cancelled'));
      });
      if (!signal.aborted) setTimeout(resolve, 20);
    });
  const s = createUploadSession(upload);
  s.init(mk(8));
  const p = s.start();
  await tick(2);
  s.cancel();
  await p;
  assert.equal(aborted, 4);
  assert.equal(failedVideoIds(s.getState()).length, 8);
  const quick = createUploadSession(async () => undefined);
  quick.init(mk(2));
  await quick.start();
  assert.equal(uploadedVideoIds(quick.getState()).length, 2);
});
test('start() on an empty/all-rejected queue resolves immediately', async () => {
  const s = createUploadSession(async () => undefined);
  s.init({ type: 'INIT', files: [{ index: 0, filename: 'x', sizeBytes: 1 }], targets: [], rejected: [{ index: 0, code: 'EMPTY_FILE', message: 'e' }] });
  await s.start();
  assert.equal(s.getState().items[0]!.status, 'rejected');
});
