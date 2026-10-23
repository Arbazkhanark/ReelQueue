import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyDraft, moveTo, reverseIds, shuffleIds, sortDrive, sortIds, type OrderItem } from './video-order';

const v = (id: string, filename: string, sizeBytes: number, durationMs: number | null, createdAt: string): OrderItem => ({ id, filename, sizeBytes, durationMs, createdAt });
const items = [
  v('a', 'clip10.mp4', 300, 5000, '2026-10-23T10:00:00Z'),
  v('b', 'clip2.mp4', 100, null, '2026-10-23T12:00:00Z'),
  v('c', 'Clip1.mp4', 200, 9000, '2026-10-23T11:00:00Z'),
];
test('name is natural and case-insensitive', () => assert.deepEqual(sortIds(items, 'name', 'asc'), ['c', 'b', 'a']));
test('name desc', () => assert.deepEqual(sortIds(items, 'name', 'desc'), ['a', 'b', 'c']));
test('size asc / desc', () => { assert.deepEqual(sortIds(items, 'size', 'asc'), ['b', 'c', 'a']); assert.deepEqual(sortIds(items, 'size', 'desc'), ['a', 'c', 'b']); });
test('upload time asc / desc', () => { assert.deepEqual(sortIds(items, 'uploaded', 'asc'), ['a', 'c', 'b']); assert.deepEqual(sortIds(items, 'uploaded', 'desc'), ['b', 'c', 'a']); });
test('unknown duration is last in both directions', () => { assert.deepEqual(sortIds(items, 'duration', 'asc'), ['a', 'c', 'b']); assert.deepEqual(sortIds(items, 'duration', 'desc'), ['c', 'a', 'b']); });
test('ties are stable (name, then id)', () => assert.deepEqual(sortIds([v('z', 'x.mp4', 1, 1, '2026-01-01T00:00:00Z'), v('y', 'x.mp4', 1, 1, '2026-01-01T00:00:00Z')], 'size', 'asc'), ['y', 'z']));
test('shuffle keeps the same ids and is deterministic with a seeded rng', () => {
  let s = 1; const rng = () => ((s = (s * 16807) % 2147483647) / 2147483647);
  const ids = ['1', '2', '3', '4', '5', '6'];
  const out = shuffleIds(ids, rng);
  assert.deepEqual([...out].sort(), ids);
  s = 1; assert.deepEqual(shuffleIds(ids, rng), out);
  assert.deepEqual(ids, ['1', '2', '3', '4', '5', '6']);
});
test('reverse', () => assert.deepEqual(reverseIds(['1', '2', '3']), ['3', '2', '1']));
test('moveTo clamps and moves', () => {
  assert.deepEqual(moveTo(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.deepEqual(moveTo(['a', 'b', 'c'], 0, 99), ['b', 'c', 'a']);
  assert.deepEqual(moveTo(['a', 'b', 'c'], 5, 0), ['a', 'b', 'c']);
});
test('applyDraft drops vanished ids and appends new ones', () => {
  const ready = [{ id: 'a' }, { id: 'b' }, { id: 'd' }];
  assert.deepEqual(applyDraft(ready, ['c', 'b', 'a']).map((x) => x.id), ['b', 'a', 'd']);
  assert.deepEqual(applyDraft(ready, null).map((x) => x.id), ['a', 'b', 'd']);
});
test('drive sort by size, modified, name', () => {
  const f = [{ id: '1', name: 'b', sizeBytes: 5, modifiedTime: '2026-01-02T00:00:00Z' }, { id: '2', name: 'a', sizeBytes: null, modifiedTime: '2026-01-03T00:00:00Z' }];
  assert.deepEqual(sortDrive(f, 'size', 'desc').map((x) => x.id), ['1', '2']);
  assert.deepEqual(sortDrive(f, 'modified', 'desc').map((x) => x.id), ['2', '1']);
  assert.deepEqual(sortDrive(f, 'name', 'asc').map((x) => x.id), ['2', '1']);
});