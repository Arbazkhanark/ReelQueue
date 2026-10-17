import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildStorageKey, extensionFor, parseFfprobe, planUpload, storageLevel, validateMedia, type UploadLimits } from '../src';

const limits: UploadLimits = { allowedContentTypes: ['video/mp4', 'video/quicktime'], maxFileBytes: 1000, quotaBytes: 10_000, maxVideos: 5, maxBatchFiles: 4 };
const f = (name: string, size = 100, type = 'video/mp4') => ({ filename: name, contentType: type, sizeBytes: size });
const usage = { videoCount: 0, bytesUsed: 0, bytesReserved: 0 };

describe('planUpload', () => {
  it('accepts valid files and reports per-file rejections with stable codes', () => {
    const r = planUpload([f('a.mp4'), f('b.avi', 100, 'video/x-msvideo'), f('c.mp4', 0), f('d.mp4', 5000), f('e/../x.mp4'), f('ok.mov', 10, 'VIDEO/QUICKTIME')], { ...limits, maxBatchFiles: 10 }, usage);
    assert.ok(r.ok);
    assert.deepEqual(r.accepted.map((x) => x.index), [0, 5]);
    assert.deepEqual(r.rejected.map((x) => [x.index, x.code]), [[1, 'UNSUPPORTED_MEDIA'], [2, 'EMPTY_FILE'], [3, 'FILE_TOO_LARGE'], [4, 'INVALID_NAME']]);
    assert.equal(r.totalBytes, 110);
  });
  it('enforces batch size, library size and storage quota (including bytes reserved by open batches)', () => {
    assert.deepEqual(planUpload([], limits, usage), { ok: false, code: 'UPLOAD_LIMIT_EXCEEDED', message: 'No files were provided' });
    assert.equal((planUpload(Array.from({ length: 5 }, (_, i) => f(`${i}.mp4`)), limits, usage) as { code: string }).code, 'UPLOAD_LIMIT_EXCEEDED');
    assert.equal((planUpload([f('a.mp4'), f('b.mp4')], limits, { ...usage, videoCount: 4 }) as { code: string }).code, 'UPLOAD_LIMIT_EXCEEDED');
    assert.equal((planUpload([f('a.mp4', 600)], limits, { videoCount: 0, bytesUsed: 9000, bytesReserved: 500 }) as { code: string }).code, 'STORAGE_QUOTA_EXCEEDED');
    assert.ok(planUpload([f('a.mp4', 500)], limits, { videoCount: 0, bytesUsed: 9000, bytesReserved: 500 }).ok);
  });
});

describe('storage keys and levels', () => {
  it('keys are user-scoped, unique, and ignore the filename', () => {
    const a = buildStorageKey('u1', 'v1', 'video/mp4');
    const b = buildStorageKey('u1', 'v1', 'video/mp4');
    assert.match(a, /^u\/u1\/v\/v1\/[0-9a-f]{16}\.mp4$/);
    assert.notEqual(a, b);
    assert.equal(extensionFor('video/quicktime'), 'mov');
  });
  it('levels: OK < 80, WARNING >= 80, FULL at 100', () => {
    assert.deepEqual(storageLevel(79, 100), { percentUsed: 79, level: 'OK' });
    assert.equal(storageLevel(80, 100).level, 'WARNING');
    assert.equal(storageLevel(100, 100).level, 'FULL');
    assert.equal(storageLevel(1, 0).level, 'FULL');
  });
});

describe('media', () => {
  const sample = { streams: [{ codec_type: 'video', codec_name: 'h264', width: 1080, height: 1920 }, { codec_type: 'audio', codec_name: 'aac' }], format: { duration: '12.480000', format_name: 'mov,mp4,m4a,3gp,3g2,mj2' } };
  it('parses ffprobe output, ignores cover art, handles missing video', () => {
    assert.deepEqual(parseFfprobe(sample), { durationMs: 12480, width: 1080, height: 1920, videoCodec: 'h264', audioCodec: 'aac', container: 'mov,mp4,m4a,3gp,3g2,mj2' });
    assert.equal(parseFfprobe({ streams: [{ codec_type: 'video', width: 10, height: 10, disposition: { attached_pic: 1 } }] }), null);
    assert.equal(parseFfprobe({}), null);
  });
  it('validates duration bounds', () => {
    const m = parseFfprobe(sample)!;
    assert.ok(validateMedia(m, { minDurationSeconds: 3, maxDurationSeconds: 900 }).ok);
    assert.equal((validateMedia(m, { minDurationSeconds: 20, maxDurationSeconds: 900 }) as { code: string }).code, 'TOO_SHORT');
    assert.equal((validateMedia(m, { minDurationSeconds: 1, maxDurationSeconds: 10 }) as { code: string }).code, 'TOO_LONG');
    assert.equal((validateMedia(null, { minDurationSeconds: 1, maxDurationSeconds: 10 }) as { code: string }).code, 'NO_VIDEO_STREAM');
  });
});
