import { FakeClock, MockInstagramProvider, PublishExecutor, seededRng, type ExecuteOutcome, type ProviderResolver } from '@reelqueue/core';
import { PgJobStore, SchedulerStore, DEFAULT_TICK_CONFIG } from '@reelqueue/db';
import { SchedulerRunner, type WakeQueue } from '../../src';
import type { SqlExecutor } from '../../../db/src/sql';

export const T0 = new Date('2026-10-14T10:00:00.000Z');
export const MIN = 60_000;

interface Wake { kind: 'cycle' | 'job'; id: string; runAt: Date; seq: number }

/** Deterministic stand-in for BullMQ: delayed wake-ups, duplicates allowed (handlers are idempotent), can be wiped. */
export class VirtualQueue implements WakeQueue {
  wakes: Wake[] = [];
  private seq = 0;
  async wakeCycle(id: string, runAt: Date) { this.wakes.push({ kind: 'cycle', id, runAt, seq: this.seq++ }); }
  async wakeJob(id: string, runAt: Date) { this.wakes.push({ kind: 'job', id, runAt, seq: this.seq++ }); }
  clear() { this.wakes = []; }
  next(until: number): Wake | undefined {
    const due = this.wakes.filter((w) => w.runAt.getTime() <= until).sort((a, b) => a.runAt.getTime() - b.runAt.getTime() || a.seq - b.seq);
    const w = due[0];
    if (w) this.wakes.splice(this.wakes.indexOf(w), 1);
    return w;
  }
}

export function makeSim(db: SqlExecutor) {
  const clock = new FakeClock(T0);
  const provider = new MockInstagramProvider(() => clock.now());
  const providers: ProviderResolver = { resolve: () => provider };
  const jobStore = new PgJobStore(db);
  const store = new SchedulerStore(db);
  const executor = new PublishExecutor({
    store: jobStore, providers, clock, rng: seededRng(7),
    media: { getFetchUrl: async (id, ttl) => `https://signed.example.test/${id}.mp4?ttl=${ttl}` },
  });
  const queue = new VirtualQueue();
  const runner = new SchedulerRunner({ store, executor, providers, queue, clock, tickConfig: DEFAULT_TICK_CONFIG });
  const publishedAt: Date[] = [];
  const orig = provider.publishContainer.bind(provider);
  provider.publishContainer = async (a, c) => {
    const r = await orig(a, c);
    publishedAt.push(clock.now());
    return r;
  };
  const errors: unknown[] = [];

  /** Runs wake-ups in virtual time up to `until`; optionally sweeps like the production timer. */
  async function advance(untilMinutes: number, opts: { sweepEveryMs?: number } = {}): Promise<void> {
    const until = T0.getTime() + untilMinutes * MIN;
    let nextSweep = opts.sweepEveryMs ? clock.now().getTime() + opts.sweepEveryMs : Infinity;
    for (let guard = 0; guard < 20_000; guard++) {
      const w = queue.next(until);
      const sweepDue = nextSweep <= until && (!w || nextSweep < w.runAt.getTime());
      if (sweepDue) {
        clock.set(Math.max(clock.now().getTime(), nextSweep));
        await runner.sweep();
        nextSweep += opts.sweepEveryMs!;
        if (w) queue.wakes.push(w);
        continue;
      }
      if (!w) break;
      if (w.runAt.getTime() > clock.now().getTime()) clock.set(w.runAt);
      try {
        if (w.kind === 'cycle') await runner.runCycleTick(w.id);
        else await runner.runJob(w.id, 'worker-1');
      } catch (err) {
        errors.push(err); // infrastructure failure: lease stays, sweeper/redelivery recovers
      }
    }
    clock.set(Math.max(clock.now().getTime(), until));
  }
  const run = (jobId: string, worker = 'worker-1'): Promise<ExecuteOutcome> => runner.runJob(jobId, worker);
  return { clock, provider, store, jobStore, runner, queue, advance, publishedAt, errors, run };
}
