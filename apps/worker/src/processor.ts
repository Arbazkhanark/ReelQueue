// apps/worker/processor.ts
import type { SchedulerRunner } from '@reelqueue/services';
import type { WorkerLogger } from '@reelqueue/runtime';

export interface WakeJob { name: string; data: { id?: unknown } }

/** One BullMQ job -> one idempotent runner call. Unknown/malformed jobs are dropped (logged), never retried forever. */
export function makeProcessor(runner: Pick<SchedulerRunner, 'runCycleTick' | 'runJob'>, workerId: string, log: WorkerLogger) {
  return async (job: WakeJob): Promise<void> => {
    const id = job.data?.id;
    if (typeof id !== 'string' || id.length === 0) { log.warn({ name: job.name }, 'wake job without id; dropped'); return; }
    switch (job.name) {
      case 'cycle': await runner.runCycleTick(id); return;
      case 'job': await runner.runJob(id, workerId); return;
      default: log.warn({ name: job.name }, 'unknown wake job; dropped');
    }
  };
}
