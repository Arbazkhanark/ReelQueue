import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { runMaintenance, PeriodicTask } from '../src/maintenance';

const log = () => { const w: { o: Record<string, unknown>; m: string }[] = []; return { w, l: { info: () => undefined, warn: (o: Record<string, unknown>, m: string) => { w.push({ o, m }); }, error: () => undefined } }; };
const ok = (v: unknown = 1) => ({ run: async () => v });

describe('worker maintenance', () => {
  it('runs every step and reports each result', async () => {
    const { l } = log(); const order: string[] = [];
    const r = await runMaintenance({ tokenRefresh: { run: async () => { order.push('t'); return { refreshed: 2 }; } }, retention: { run: async () => { order.push('r'); return 'R'; } }, uploads: { cleanup: async () => { order.push('u'); return 'U'; } }, rateStore: { purgeExpired: async () => { order.push('p'); return 4; } }, now: () => new Date(0) }, l);
    assert.deepEqual(order, ['t', 'r', 'u', 'p']); assert.deepEqual(r, { tokenRefresh: { refreshed: 2 }, retention: 'R', uploadCleanup: 'U', rateLimitPurge: 4 });
  });
  it('one failing step is isolated: the others still run and the log carries only the message (no token)', async () => {
    const { l, w } = log();
    const r = await runMaintenance({ tokenRefresh: { run: async () => { throw new Error('db down'); } }, retention: ok('R'), uploads: { cleanup: async () => 'U' }, rateStore: { purgeExpired: async () => { throw new Error('x'); } }, now: () => new Date(0) }, l);
    assert.deepEqual(r, { tokenRefresh: 'FAILED', retention: 'R', uploadCleanup: 'U', rateLimitPurge: 'FAILED' });
    assert.equal(w.length, 2); assert.deepEqual(w[0]!.o, { step: 'tokenRefresh', err: 'db down' });
  });
  it('mock mode has no token refresh step', async () => {
    const r = await runMaintenance({ retention: ok(), uploads: { cleanup: async () => 1 }, rateStore: { purgeExpired: async () => 0 }, now: () => new Date(0) }, log().l);
    assert.ok(!('tokenRefresh' in r));
  });
  it('PeriodicTask: errors never kill the loop; stop() waits for the in-flight run and prevents further runs', async () => {
    const { l, w } = log(); let n = 0; let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const t = new PeriodicTask(async () => { n++; if (n === 1) throw new Error('first fails'); await gate; }, { intervalMs: 5, jitterMs: 0 }, l, 'x');
    t.start(); await new Promise((r) => setTimeout(r, 60));
    assert.ok(n >= 2, `kept looping after an error (ran ${n})`); assert.equal(w[0]!.m, 'periodic task failed');
    let stopped = false; const p = t.stop().then(() => { stopped = true; });
    await new Promise((r) => setTimeout(r, 20)); assert.equal(stopped, false, 'stop() waits for the in-flight run');
    release(); await p; const after = n; await new Promise((r) => setTimeout(r, 30)); assert.equal(n, after, 'no run after stop');
  });
});
