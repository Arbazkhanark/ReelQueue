import type { WorkerLogger } from '@reelqueue/runtime';

export interface MaintenanceDeps {
  tokenRefresh?: { run(): Promise<unknown> };
  retention: { run(): Promise<unknown> };
  uploads: { cleanup(): Promise<unknown> };
  rateStore: { purgeExpired(now: Date): Promise<number> };
  now: () => Date;
}

/**
 * Housekeeping run by every worker replica (all steps are idempotent and row-locked, so replicas never double-process).
 * Each step is isolated: one failing step is logged (message only, never tokens) and does not stop the others.
 */
export async function runMaintenance(d: MaintenanceDeps, log: WorkerLogger): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  const step = async (name: string, fn: () => Promise<unknown>) => {
    try { out[name] = await fn(); } catch (err) { out[name] = 'FAILED'; log.warn({ step: name, err: err instanceof Error ? err.message : String(err) }, 'maintenance step failed'); }
  };
  if (d.tokenRefresh) await step('tokenRefresh', () => d.tokenRefresh!.run());
  await step('retention', () => d.retention.run());
  await step('uploadCleanup', () => d.uploads.cleanup());
  await step('rateLimitPurge', () => d.rateStore.purgeExpired(d.now()));
  return out;
}

/** Same loop discipline as Sweeper (errors never kill it; stop() waits for an in-flight run), generalised to any task. */
export class PeriodicTask {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> = Promise.resolve();
  private stopped = false;
  constructor(private readonly fn: () => Promise<unknown>, private readonly o: { intervalMs: number; jitterMs: number; random?: () => number }, private readonly log: WorkerLogger, private readonly name = 'task') {}
  async runOnce(): Promise<void> { try { await this.fn(); } catch (err) { this.log.warn({ task: this.name, err: err instanceof Error ? err.message : String(err) }, 'periodic task failed'); } }
  start(): void {
    const next = () => {
      if (this.stopped) return;
      const jitter = Math.floor((this.o.random ?? Math.random)() * this.o.jitterMs);
      this.timer = setTimeout(() => { this.running = this.runOnce().finally(next); }, this.o.intervalMs + jitter);
    };
    next();
  }
  async stop(): Promise<void> { this.stopped = true; if (this.timer) clearTimeout(this.timer); await this.running; }
}
