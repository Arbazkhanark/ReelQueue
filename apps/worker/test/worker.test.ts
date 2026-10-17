import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { BullWakeQueue, type BullQueueLike } from '@reelqueue/runtime';
import { makeProcessor, Sweeper } from '../src';

const log = { info: () => {}, warn: () => {} };
const warns: Record<string, unknown>[] = [];
const wlog = { info: () => {}, warn: (o: Record<string, unknown>) => { warns.push(o); } };

describe('BullWakeQueue', () => {
  it('uses a deterministic ":"-free jobId and a non-negative delay', async () => {
    const added: { name: string; data: unknown; opts: { jobId: string; delay: number } }[] = [];
    const q: BullQueueLike = { add: async (name, data, opts) => { added.push({ name, data, opts }); } };
    const now = new Date('2026-10-14T10:00:00Z');
    const w = new BullWakeQueue(q, () => now, log);
    await w.wakeJob('j1', new Date(now.getTime() + 90_000));
    await w.wakeCycle('c1', new Date(now.getTime() - 5_000)); // past -> run now
    await w.wakeJob('j1', new Date(now.getTime() + 90_000)); // identical wake -> identical id (BullMQ dedupes)
    assert.equal(added[0]!.opts.delay, 90_000);
    assert.equal(added[1]!.opts.delay, 0);
    assert.equal(added[0]!.opts.jobId, added[2]!.opts.jobId);
    assert.ok(added.every((a) => !a.opts.jobId.includes(':')));
    assert.notEqual(added[0]!.opts.jobId, `job__j1__${now.getTime() + 60_000}`);
    assert.deepEqual(added[0]!.data, { id: 'j1' });
  });
  it('swallows and logs queue errors (the sweeper recovers lost wakes)', async () => {
    warns.length = 0;
    const w = new BullWakeQueue({ add: async () => { throw new Error('redis down'); } }, () => new Date(), wlog);
    await w.wakeJob('j1', new Date()); // must not throw
    assert.equal(warns.length, 1);
    assert.match(String(warns[0]!.err), /redis down/);
  });
});

describe('processor', () => {
  it('dispatches cycle and job wakes; drops malformed/unknown jobs without throwing', async () => {
    const calls: unknown[] = [];
    const p = makeProcessor({ runCycleTick: async (id: string) => { calls.push(['cycle', id]); return {} as never; }, runJob: async (id: string, w: string) => { calls.push(['job', id, w]); return {} as never; } }, 'w1', log);
    await p({ name: 'cycle', data: { id: 'c1' } });
    await p({ name: 'job', data: { id: 'j1' } });
    await p({ name: 'job', data: {} });
    await p({ name: 'job', data: { id: 5 } });
    await p({ name: 'weird', data: { id: 'x' } });
    assert.deepEqual(calls, [['cycle', 'c1'], ['job', 'j1', 'w1']]);
  });
  it('propagates runner errors so BullMQ records the failure', async () => {
    const p = makeProcessor({ runCycleTick: async () => { throw new Error('boom'); }, runJob: async () => ({}) as never }, 'w', log);
    await assert.rejects(p({ name: 'cycle', data: { id: 'c' } }), /boom/);
  });
});

describe('Sweeper', () => {
  it('runs on the interval, survives errors, and stop() waits for the in-flight sweep', async () => {
    let n = 0; let finished = 0;
    const s = new Sweeper({ sweep: async () => { n++; if (n === 1) throw new Error('db blip'); await new Promise((r) => setTimeout(r, 30)); finished++; return { jobs: 0, cycles: 0 }; } }, { intervalMs: 10, jitterMs: 0 }, wlog);
    warns.length = 0;
    s.start();
    await new Promise((r) => setTimeout(r, 120));
    await s.stop();
    const after = n;
    assert.ok(n >= 2, `kept running after an error (n=${n})`);
    assert.equal(finished, n - 1, 'no sweep was abandoned mid-flight by stop()');
    assert.ok(warns.some((w) => /db blip/.test(String(w.err))));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(n, after, 'nothing runs after stop()');
  });
});
