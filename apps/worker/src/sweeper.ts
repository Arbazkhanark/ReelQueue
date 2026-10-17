import type { SchedulerRunner } from '@reelqueue/services';
import type { WorkerLogger } from '@reelqueue/runtime';

/** Periodic safety net. Errors never kill the loop. Safe to run in every worker replica (wakes are idempotent). */
export class Sweeper {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> = Promise.resolve();
  private stopped = false;
  constructor(private readonly runner: Pick<SchedulerRunner, 'sweep'>, private readonly o: { intervalMs: number; jitterMs: number; random?: () => number }, private readonly log: WorkerLogger) {}

  async runOnce(): Promise<{ jobs: number; cycles: number } | null> {
    try { return await this.runner.sweep(); } catch (err) { this.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'sweep failed'); return null; }
  }
  start(): void {
    const next = () => {
      if (this.stopped) return;
      const jitter = Math.floor((this.o.random ?? Math.random)() * this.o.jitterMs);
      this.timer = setTimeout(() => { this.running = this.runOnce().then(() => undefined).finally(next); }, this.o.intervalMs + jitter);
    };
    next();
  }
  /** Stops scheduling and waits for an in-flight sweep. */
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearTimeout(this.timer); await this.running; }
}
