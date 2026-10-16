import test from 'node:test';
import assert from 'node:assert/strict';
import { cycleControls, effectiveCycleStatus, isLiveCycle } from './cycle-ui';
import type { ControlContext } from './cycle-ui';
import type { CycleDto } from '@reelqueue/shared';

const NOW = Date.parse('2026-10-16T12:00:00Z');
const cycle = (over: Partial<CycleDto> = {}): CycleDto => ({
  id: 'c1', instagramAccountId: 'a1', provider: 'MOCK', isMock: true, status: 'ACTIVE', pauseReason: null, batchSize: 1, intervalMinutes: 20,
  loopEnabled: false, startedAt: '2026-10-16T10:00:00Z', endsAt: '2026-10-17T10:00:00Z', nextBatchAt: null, endedAt: null, endReason: null,
  iteration: 0, counts: { queued: 0, pending: 0, published: 0, simulated: 0, failed: 0, cancelled: 0, expired: 0 }, warnings: [], ...over,
});
const ctx = (over: Partial<ControlContext> = {}): ControlContext => ({
  cycle: null, nowMs: NOW, account: { status: 'CONNECTED' }, readyVideos: 10, settingsValid: true, busy: false, ...over,
});

test('effective status mirrors core: live cycle past endsAt is EXPIRED', () => {
  assert.equal(effectiveCycleStatus(cycle(), NOW), 'ACTIVE');
  assert.equal(effectiveCycleStatus(cycle({ endsAt: '2026-10-16T11:59:59Z' }), NOW), 'EXPIRED');
  assert.equal(effectiveCycleStatus(cycle({ status: 'STOPPED', endsAt: '2026-10-16T11:59:59Z' }), NOW), 'STOPPED');
  assert.equal(isLiveCycle(cycle({ status: 'STOPPED' }), NOW), false);
  assert.equal(isLiveCycle(cycle({ status: 'PAUSED' }), NOW), true);
  assert.equal(isLiveCycle(null, NOW), false);
});
test('no cycle: only Start is possible, with reasons otherwise', () => {
  const c = cycleControls(ctx());
  assert.equal(c.start.enabled, true);
  assert.equal(c.pause.enabled, false);
  assert.ok(c.pause.reason);
  assert.equal(c.stop.enabled, false);
});
test('start disabled reasons', () => {
  assert.match(cycleControls(ctx({ account: null })).start.reason ?? '', /Select/);
  assert.match(cycleControls(ctx({ account: { status: 'REAUTH_REQUIRED' } })).start.reason ?? '', /reconnected/);
  assert.match(cycleControls(ctx({ readyVideos: 0 })).start.reason ?? '', /Upload/);
  assert.match(cycleControls(ctx({ settingsValid: false })).start.reason ?? '', /settings/);
  assert.equal(cycleControls(ctx({ busy: true })).start.enabled, false);
});
test('active cycle: pause+stop enabled, resume+start disabled', () => {
  const c = cycleControls(ctx({ cycle: cycle() }));
  assert.deepEqual([c.start.enabled, c.pause.enabled, c.resume.enabled, c.stop.enabled], [false, true, false, true]);
  assert.ok(c.resume.reason && c.start.reason);
});
test('paused cycle: resume+stop enabled', () => {
  const c = cycleControls(ctx({ cycle: cycle({ status: 'PAUSED' }) }));
  assert.deepEqual([c.start.enabled, c.pause.enabled, c.resume.enabled, c.stop.enabled], [false, false, true, true]);
});
test('elapsed window: nothing is controllable and the reason says so', () => {
  const c = cycleControls(ctx({ cycle: cycle({ endsAt: '2026-10-16T11:00:00Z' }) }));
  assert.deepEqual([c.pause.enabled, c.resume.enabled, c.stop.enabled], [false, false, false]);
  assert.match(c.pause.reason ?? '', /elapsed/);
  assert.equal(c.start.enabled, true, 'a new cycle can start once the old one is effectively expired');
});
test('terminal cycle behaves like no cycle', () => {
  assert.equal(cycleControls(ctx({ cycle: cycle({ status: 'STOPPED' }) })).start.enabled, true);
});
