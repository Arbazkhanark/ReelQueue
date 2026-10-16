import {
  PublishExecutor,
  ProviderError,
  type Clock,
  type ExecuteOutcome,
  type ProviderResolver,
  type PublishQuota,
} from '@reelqueue/core';
import { SchedulerStore, type TickConfig, type TickResult } from '@reelqueue/db';

/** Wake-up queue port. Production: BullMQ delayed jobs with a deterministic jobId (dedupe). Tests: a virtual queue. */
export interface WakeQueue {
  wakeCycle(cycleId: string, runAt: Date): Promise<void>;
  wakeJob(jobId: string, runAt: Date): Promise<void>;
}

export interface RunnerLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
}
const NOOP_LOG: RunnerLogger = { info: () => {}, warn: () => {} };

export interface RunnerDeps {
  store: SchedulerStore;
  executor: PublishExecutor;
  providers: ProviderResolver;
  queue: WakeQueue;
  clock: Clock;
  tickConfig: TickConfig;
  logger?: RunnerLogger;
}

/**
 * The worker's behaviour, independent of BullMQ. Each method is one idempotent unit of work:
 *   runCycleTick - decide + materialise the next batch (transactional, under a cycle row lock)
 *   runJob       - execute one bounded slice of a publish job (lease + reconcile semantics live in the executor)
 *   sweep        - re-wake anything due that the queue lost (Redis flush / restart), so queue loss only delays work
 */
export class SchedulerRunner {
  private readonly log: RunnerLogger;
  constructor(private readonly d: RunnerDeps) {
    this.log = d.logger ?? NOOP_LOG;
  }

  async runCycleTick(cycleId: string): Promise<TickResult> {
    const now = this.d.clock.now();
    const cycle = await this.d.store.getCycleById(cycleId);
    if (!cycle) return { decision: 'GONE', cycleStatus: null, newJobs: [], nextTickAt: null, quotaLimited: false, deferredByQuota: 0 };

    let quota: PublishQuota | null = null;
    if (cycle.status === 'ACTIVE') {
      try {
        quota = await this.d.providers.resolve(cycle.provider).getPublishingQuota(cycle.accountId);
      } catch (err) {
        // Unknown quota fails closed: the engine defers instead of publishing.
        const kind = err instanceof ProviderError ? err.kind : 'UNEXPECTED';
        this.log.warn({ cycleId, kind }, 'quota lookup failed; deferring batch');
      }
    }
    const result = await this.d.store.tick(cycleId, now, quota, this.d.tickConfig);
    if (quota) await this.d.store.recordQuota(cycle.accountId, quota);
    for (const j of result.newJobs) await this.d.queue.wakeJob(j.id, j.runAt);
    if (result.nextTickAt) await this.d.queue.wakeCycle(cycleId, result.nextTickAt);
    this.log.info({ cycleId, decision: result.decision, created: result.newJobs.length }, 'tick');
    return result;
  }

  async runJob(jobId: string, workerId: string): Promise<ExecuteOutcome> {
    const outcome = await this.d.executor.execute(jobId, workerId);
    switch (outcome.kind) {
      case 'WAIT':
        await this.d.queue.wakeJob(jobId, outcome.runAt);
        break;
      case 'NOT_CLAIMED':
        // OUT_OF_ORDER has no retry time: the earlier job wakes its successor when it finishes.
        if (outcome.retryAt) await this.d.queue.wakeJob(jobId, outcome.retryAt);
        break;
      case 'COMPLETED':
      case 'FAILED':
      case 'CANCELLED':
      case 'EXPIRED':
        await this.wakeNextForAccountOf(jobId);
        break;
      case 'CYCLE_PAUSED':
      case 'LEASE_LOST':
        break; // resume / sweeper / lease expiry re-wake it
    }
    return outcome;
  }

  /** Re-wakes due work from the database. Safe to run on a timer in every worker. */
  async sweep(limit = 200): Promise<{ jobs: number; cycles: number }> {
    const now = this.d.clock.now();
    const jobs = await this.d.store.findDueJobs(now, limit);
    for (const j of jobs) await this.d.queue.wakeJob(j.id, now);
    const cycles = await this.d.store.findDueCycles(now, limit);
    for (const c of cycles) await this.d.queue.wakeCycle(c.id, now);
    return { jobs: jobs.length, cycles: cycles.length };
  }

  /** Wake the next due job of the account that `jobId` belongs to (keeps per-account order flowing without polling). */
  private async wakeNextForAccountOf(jobId: string): Promise<void> {
    const now = this.d.clock.now();
    const acct = await this.d.store.getJobAccount(jobId);
    if (!acct) return;
    const [next] = await this.d.store.findDueJobs(now, 1, acct);
    if (next) await this.d.queue.wakeJob(next.id, now);
  }
}
