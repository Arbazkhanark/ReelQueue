import { addMinutes, computeNextBatchAt } from './interval';
import { effectiveStatus, type CycleStatus } from './cycle';
import { selectBatch, type BatchItem, type CursorState, type QueueVideo } from './cursor';
import { planBatchAgainstQuota, type PublishQuota, type QuotaLimitReason } from './quota';
import type { SchedulerSettings } from './settings';

export interface TickInput {
  now: Date;
  cycle: {
    status: CycleStatus;
    startedAt: Date;
    endsAt: Date;
    /** Scheduled start time of THIS batch (not "now"): keeps the cadence fixed-rate. */
    nextBatchAt: Date;
    cursor: CursorState;
  };
  settings: Pick<SchedulerSettings, 'batchSize' | 'intervalMinutes' | 'loopEnabled'>;
  /** Eligible (READY, not deleted) videos; order is irrelevant, position decides. */
  videos: readonly QueueVideo[];
  /** Jobs of this cycle that are not yet resolved (running, waiting, deferred). */
  unresolvedJobs: number;
  quota: PublishQuota | null;
  quotaReserve: number;
  quotaRecheckMinutes: number;
  backpressureRecheckSeconds: number;
}

export type TickDecision =
  | { type: 'EXPIRE' }
  | { type: 'IDLE'; reason: 'PAUSED' | 'ENDED' }
  | { type: 'NOT_DUE'; runAt: Date }
  | { type: 'BACKPRESSURE'; runAt: Date }
  | { type: 'COMPLETE'; reason: 'QUEUE_DRAINED' | 'EMPTY_QUEUE' }
  | { type: 'QUOTA_DEFER'; reason: Exclude<QuotaLimitReason, 'NONE' | 'QUOTA_PARTIAL'>; runAt: Date }
  | {
      type: 'SCHEDULE_BATCH';
      items: BatchItem[];
      cursorAfter: CursorState;
      /** Next batch start, or null if it would fall at/after the cycle end. */
      nextBatchAt: Date | null;
      quotaLimited: boolean;
      deferredByQuota: number;
    };

/**
 * Pure decision function for one scheduler tick. It performs no I/O; the caller
 * (a worker holding a row lock on the cycle) loads the inputs, applies the
 * returned decision inside one transaction and enqueues the next tick.
 *
 * Interval semantics: batch STARTS are spaced by `intervalMinutes` (fixed-rate),
 * a new batch is never released while jobs of the previous batch are unresolved
 * (backpressure), so the effective spacing is max(interval, batch duration).
 */
export function planTick(input: TickInput): TickDecision {
  const { now, cycle, settings } = input;

  const status = effectiveStatus(
    { status: cycle.status, startedAt: cycle.startedAt, endsAt: cycle.endsAt },
    now,
  );
  if (status === 'EXPIRED') {
    return cycle.status === 'EXPIRED' ? { type: 'IDLE', reason: 'ENDED' } : { type: 'EXPIRE' };
  }
  if (status === 'STOPPED' || status === 'COMPLETED') return { type: 'IDLE', reason: 'ENDED' };
  if (status === 'PAUSED') return { type: 'IDLE', reason: 'PAUSED' };

  if (now.getTime() < cycle.nextBatchAt.getTime()) {
    return { type: 'NOT_DUE', runAt: cycle.nextBatchAt };
  }

  if (input.unresolvedJobs > 0) {
    return {
      type: 'BACKPRESSURE',
      runAt: new Date(now.getTime() + input.backpressureRecheckSeconds * 1000),
    };
  }

  if (input.videos.length === 0) return { type: 'COMPLETE', reason: 'EMPTY_QUEUE' };

  const requested = Math.min(settings.batchSize, input.videos.length);
  const plan = planBatchAgainstQuota({
    requested,
    quota: input.quota,
    reserve: input.quotaReserve,
    now,
    recheckMinutes: input.quotaRecheckMinutes,
  });

  if (plan.allowed === 0) {
    return {
      type: 'QUOTA_DEFER',
      reason: plan.reason === 'QUOTA_UNKNOWN' ? 'QUOTA_UNKNOWN' : 'QUOTA_EXHAUSTED',
      runAt: plan.recheckAt ?? addMinutes(now, input.quotaRecheckMinutes),
    };
  }

  const selection = selectBatch({
    videos: input.videos,
    state: cycle.cursor,
    size: plan.allowed,
    loopEnabled: settings.loopEnabled,
  });

  if (selection.items.length === 0) return { type: 'COMPLETE', reason: 'QUEUE_DRAINED' };

  return {
    type: 'SCHEDULE_BATCH',
    items: selection.items,
    cursorAfter: selection.next,
    nextBatchAt: computeNextBatchAt({
      previousScheduledFor: cycle.nextBatchAt,
      intervalMinutes: settings.intervalMinutes,
      now,
      endsAt: cycle.endsAt,
    }),
    quotaLimited: plan.deferred > 0,
    deferredByQuota: plan.deferred,
  };
}
