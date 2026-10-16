import test from 'node:test';
import assert from 'node:assert/strict';
import { moveItem, sameOrder } from './reorder';
import { nextThemePref, parseThemePref, resolveDark } from './theme';
import { guessContentType } from './files';
import { createQueryCache } from './query-cache';
import { JOB_STATUS_INFO, jobStatusInfo } from './job-status';
import { JOB_STATUSES } from '../../../../packages/core/src/domain/jobs';

test('moveItem', () => {
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(['a', 'b', 'c', 'd'], 3, 0), ['d', 'a', 'b', 'c']);
  assert.deepEqual(moveItem(['a', 'b'], 1, 5), ['a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 0, -3), ['a', 'b']);
  assert.deepEqual(moveItem(['a', 'b'], 9, 0), ['a', 'b']);
  const src = ['a', 'b'];
  moveItem(src, 0, 1);
  assert.deepEqual(src, ['a', 'b'], 'input is not mutated');
  assert.equal(sameOrder(['a', 'b'], ['a', 'b']), true);
  assert.equal(sameOrder(['a', 'b'], ['b', 'a']), false);
});
test('theme helpers', () => {
  assert.equal(parseThemePref('dark'), 'dark');
  assert.equal(parseThemePref('weird'), 'system');
  assert.equal(parseThemePref(null), 'system');
  assert.equal(resolveDark('system', true), true);
  assert.equal(resolveDark('light', true), false);
  assert.equal(resolveDark('dark', false), true);
  assert.deepEqual(['system', 'light', 'dark'].map((p) => nextThemePref(p as 'system')), ['light', 'dark', 'system']);
});
test('guessContentType', () => {
  assert.equal(guessContentType('a.MOV', ''), 'video/quicktime');
  assert.equal(guessContentType('a.mp4', 'video/mp4'), 'video/mp4');
  assert.equal(guessContentType('a.xyz', ''), 'application/octet-stream');
});
test('job status table covers every core JobStatus and keeps SIMULATED apart from real publication', () => {
  for (const s of JOB_STATUSES) assert.ok(JOB_STATUS_INFO[s], `missing ${s}`);
  assert.equal(Object.keys(JOB_STATUS_INFO).length, JOB_STATUSES.length);
  assert.equal(JOB_STATUS_INFO.SIMULATED.realPublication, false);
  assert.equal(JOB_STATUS_INFO.SCHEDULED.realPublication, false);
  assert.equal(JOB_STATUS_INFO.ACCEPTED.realPublication, true);
  assert.equal(JOB_STATUS_INFO.CONFIRMED.realPublication, true);
  const labels = new Set(['SCHEDULED', 'ACCEPTED', 'CONFIRMED', 'SIMULATED'].map((s) => jobStatusInfo(s).label));
  assert.equal(labels.size, 4, 'the four truths have distinct labels');
  assert.equal(jobStatusInfo('SIMULATED').label.toLowerCase().includes('mock'), true);
  assert.equal(jobStatusInfo('NOPE').label, 'NOPE');
});
test('query cache: dedupes, keeps data on error, invalidates by prefix', async () => {
  const c = createQueryCache(() => 1);
  let calls = 0;
  const f = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 5));
    return 'x';
  };
  const [a, b] = await Promise.all([c.fetch('k|1', f), c.fetch('k|1', f)]);
  assert.deepEqual([a, b, calls], ['x', 'x', 1]);
  assert.equal(c.get<string>('k|1')?.data, 'x');
  await c.fetch('k|1', async () => {
    throw new Error('down');
  });
  const e = c.get<string>('k|1')!;
  assert.equal(e.data, 'x', 'stale data kept');
  assert.ok(e.error instanceof Error);
  let notified = 0;
  const un = c.subscribe('k|1', () => notified++);
  c.invalidate('k|');
  assert.equal(c.get('k|1')?.stale, true);
  assert.equal(notified, 1);
  un();
  c.invalidate('k|');
  assert.equal(notified, 1);
  c.set('z', 5);
  assert.equal(c.get<number>('z')?.data, 5);
});
