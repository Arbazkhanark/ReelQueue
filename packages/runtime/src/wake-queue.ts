import type { WakeQueue } from '@reelqueue/services';

/** The subset of bullmq's Queue we use (structural, so it is testable without bullmq). */
export interface BullQueueLike {
  add(name: string, data: Record<string, unknown>, opts: { jobId: string; delay: number; removeOnComplete: boolean | number; removeOnFail: boolean | number; attempts: number }): Promise<unknown>;
}
export interface WorkerLogger { info(o: Record<string, unknown>, m: string): void; warn(o: Record<string, unknown>, m: string): void }

export const QUEUE_NAME = 'reelqueue-wake';

/**
 * Wake-ups only. The database is the source of truth: if Redis loses a wake (or add() fails) the sweeper re-wakes it, so
 * errors here are LOGGED AND SWALLOWED rather than failing the transaction that already committed.
 * jobId = kind__id__runAtMs: the same wake dedupes (BullMQ ignores a duplicate jobId), a different time is a new wake.
 * (BullMQ forbids ':' in custom ids, hence '__'.)
 */
export class BullWakeQueue implements WakeQueue {
  constructor(private readonly q: BullQueueLike, private readonly now: () => Date, private readonly log: WorkerLogger) {}

  wakeCycle(cycleId: string, runAt: Date) { return this.add('cycle', cycleId, runAt); }
  wakeJob(jobId: string, runAt: Date) { return this.add('job', jobId, runAt); }

  private async add(kind: 'cycle' | 'job', id: string, runAt: Date): Promise<void> {
    const delay = Math.max(0, runAt.getTime() - this.now().getTime());
    try {
      await this.q.add(kind, { id }, { jobId: `${kind}__${id}__${runAt.getTime()}`, delay, removeOnComplete: true, removeOnFail: 1000, attempts: 1 });
    } catch (err) {
      this.log.warn({ kind, id, err: err instanceof Error ? err.message : String(err) }, 'wake enqueue failed; sweeper will recover');
    }
  }
}
