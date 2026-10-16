import test from 'node:test';
import assert from 'node:assert/strict';
import {
  countBy, failedVideoIds, initialUploadState, isSettled, itemProgress, nextToStart, overallProgress, uploadReducer, uploadedVideoIds,
} from './upload-queue';
import type { UploadAction, UploadState } from './upload-queue';

const files = (n: number, size = 100) => Array.from({ length: n }, (_, i) => ({ index: i, filename: `f${i}.mp4`, sizeBytes: size }));
const init = (n: number, extra: Partial<Extract<UploadAction, { type: 'INIT' }>> = {}): UploadState =>
  uploadReducer(initialUploadState, {
    type: 'INIT',
    files: files(n),
    targets: Array.from({ length: n }, (_, i) => ({ index: i, videoId: `v${i}` })),
    rejected: [],
    ...extra,
  });

test('INIT builds queued items, rejected items and failed-without-target items', () => {
  const s = uploadReducer(initialUploadState, {
    type: 'INIT',
    files: files(3),
    targets: [{ index: 0, videoId: 'v0' }],
    rejected: [{ index: 1, code: 'UNSUPPORTED_MEDIA', message: 'not a video' }],
  });
  assert.deepEqual(s.items.map((i) => i.status), ['queued', 'rejected', 'failed']);
  assert.equal(s.items[1]!.error, 'not a video');
  assert.equal(s.items[1]!.rejectionCode, 'UNSUPPORTED_MEDIA');
  assert.equal(s.items[2]!.videoId, null);
});
test('nextToStart honours the concurrency limit (default 4) and file order', () => {
  let s = init(10);
  assert.deepEqual(nextToStart(s), [0, 1, 2, 3]);
  for (const i of nextToStart(s)) s = uploadReducer(s, { type: 'START', index: i });
  assert.equal(countBy(s, 'uploading'), 4);
  assert.deepEqual(nextToStart(s), []);
  s = uploadReducer(s, { type: 'SUCCESS', index: 1 });
  assert.deepEqual(nextToStart(s), [4]);
});
test('custom concurrency, minimum 1', () => {
  assert.deepEqual(nextToStart(init(5, { concurrency: 2 })), [0, 1]);
  assert.deepEqual(nextToStart(init(5, { concurrency: 0 })), [0]);
});
test('invalid transitions are ignored (same state reference)', () => {
  const s = init(2);
  assert.equal(uploadReducer(s, { type: 'SUCCESS', index: 0 }), s);
  assert.equal(uploadReducer(s, { type: 'PROGRESS', index: 0, loaded: 5 }), s);
  assert.equal(uploadReducer(s, { type: 'RETRY', index: 0 }), s);
  const started = uploadReducer(s, { type: 'START', index: 0 });
  assert.equal(uploadReducer(started, { type: 'START', index: 0 }), started);
});
test('progress is clamped; attempts increment; success sets loaded=size', () => {
  let s = init(1);
  s = uploadReducer(s, { type: 'START', index: 0 });
  s = uploadReducer(s, { type: 'PROGRESS', index: 0, loaded: 9999 });
  assert.equal(s.items[0]!.loaded, 100);
  s = uploadReducer(s, { type: 'FAILURE', index: 0, error: 'boom' });
  assert.equal(s.items[0]!.status, 'failed');
  assert.equal(s.items[0]!.loaded, 0);
  s = uploadReducer(s, { type: 'RETRY', index: 0 });
  s = uploadReducer(s, { type: 'START', index: 0 });
  assert.equal(s.items[0]!.attempts, 2);
  s = uploadReducer(s, { type: 'SUCCESS', index: 0 });
  assert.equal(s.items[0]!.status, 'uploaded');
  assert.equal(itemProgress(s.items[0]!), 1);
});
test('retry only applies to failed items that have a videoId', () => {
  let s = uploadReducer(initialUploadState, { type: 'INIT', files: files(1), targets: [], rejected: [] });
  assert.equal(s.items[0]!.status, 'failed');
  assert.equal(uploadReducer(s, { type: 'RETRY', index: 0 }), s);
  s = uploadReducer(s, { type: 'RETRY_ALL' });
  assert.equal(s.items[0]!.status, 'failed');
});
test('overallProgress excludes rejected files', () => {
  let s = uploadReducer(initialUploadState, {
    type: 'INIT', files: files(3), targets: [{ index: 0, videoId: 'a' }, { index: 1, videoId: 'b' }], rejected: [{ index: 2, code: 'EMPTY_FILE', message: 'empty' }],
  });
  assert.equal(overallProgress(s), 0);
  s = uploadReducer(s, { type: 'START', index: 0 });
  s = uploadReducer(s, { type: 'SUCCESS', index: 0 });
  assert.equal(overallProgress(s), 0.5);
  s = uploadReducer(s, { type: 'START', index: 1 });
  s = uploadReducer(s, { type: 'PROGRESS', index: 1, loaded: 50 });
  assert.equal(overallProgress(s), 0.75);
});
test('settled, uploaded and failed id reporting for completeUpload', () => {
  let s = init(3);
  assert.equal(isSettled(s), false);
  for (const i of [0, 1, 2]) s = uploadReducer(s, { type: 'START', index: i });
  s = uploadReducer(s, { type: 'SUCCESS', index: 0 });
  s = uploadReducer(s, { type: 'FAILURE', index: 1, error: 'x' });
  assert.equal(isSettled(s), false);
  s = uploadReducer(s, { type: 'SUCCESS', index: 2 });
  assert.equal(isSettled(s), true);
  assert.deepEqual(uploadedVideoIds(s), ['v0', 'v2']);
  assert.deepEqual(failedVideoIds(s), ['v1']);
});
test('CANCEL_QUEUED fails queued items only', () => {
  let s = init(3, { concurrency: 1 });
  s = uploadReducer(s, { type: 'START', index: 0 });
  s = uploadReducer(s, { type: 'CANCEL_QUEUED' });
  assert.deepEqual(s.items.map((i) => i.status), ['uploading', 'failed', 'failed']);
  assert.equal(s.items[1]!.error, 'Cancelled');
});
