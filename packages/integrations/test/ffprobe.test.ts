import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateMedia } from '@reelqueue/core';
import { probeVideo } from '../src/media/ffprobe';

const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

describe('probeVideo (real ffprobe)', () => {
  it('reads real metadata from a generated 2s 320x568 clip', { skip: !haveFfmpeg && 'ffmpeg not installed' }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rq-probe-'));
    const file = join(dir, 'clip.mp4');
    execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x568:rate=30', '-f', 'lavfi', '-i', 'sine=duration=2', '-pix_fmt', 'yuv420p', '-shortest', file]);
    const meta = await probeVideo(file);
    assert.ok(meta);
    assert.equal(meta.width, 320);
    assert.equal(meta.height, 568);
    assert.equal(meta.videoCodec, 'h264');
    assert.ok(Math.abs(meta.durationMs - 2000) < 200, `duration ${meta.durationMs}`);
    assert.ok(validateMedia(meta, { minDurationSeconds: 1, maxDurationSeconds: 60 }).ok);
    assert.equal(validateMedia(meta, { minDurationSeconds: 3, maxDurationSeconds: 60 }).ok, false);
  });
  it('rejects garbage files and unsafe inputs', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rq-probe-'));
    const bad = join(dir, 'bad.mp4');
    writeFileSync(bad, 'not a video');
    // await assert.rejects(probeVideo(bad), /ffprobe failed/);
    // await assert.rejects(probeVideo('relative/path.mp4'), /https URL, localhost HTTP URL, or an absolute path/);

    await assert.rejects(probeVideo(bad), /ffprobe failed/);
    await assert.rejects(
      probeVideo('relative/path.mp4'),
      /https URL, localhost HTTP URL, or an absolute path/
    );
    await assert.rejects(
      probeVideo('http://insecure.example/x.mp4'),
      /https URL, localhost HTTP URL, or an absolute path/
    );
  });
});
