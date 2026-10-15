import type { Clock, Rng } from './clock';
import { effectiveStatus, type CycleState } from './cycle';
import { LeaseLostError, ProviderError } from './errors';
import type { JobStatus, PublishJobRecord } from './jobs';
import { isValidQuota, remainingQuota } from './quota';
import { DEFAULT_BACKOFF, decideOnError, type BackoffConfig, type ExecutionStep, type PauseReason } from './retry';
import type { ConfirmResult, InstagramProvider, ProviderResolver } from '../instagram/provider';

/* ------------------------------------------------------------------ ports */

export type ClaimResult =
  | { claimed: true; job: PublishJobRecord }
  | {
      claimed: false;
      reason: 'NOT_FOUND' | 'TERMINAL' | 'NOT_DUE' | 'LEASED' | 'ACCOUNT_BUSY' | 'OUT_OF_ORDER';
      /** When the caller may try again, if known. */
      retryAt: Date | null;
    };

export interface JobPatch {
  status?: JobStatus;
  nextAttemptAt?: Date;
  containerId?: string | null;
  containerCreatedAt?: Date | null;
  publishRequestedAt?: Date | null;
  mediaId?: string | null;
  permalink?: string | null;
  attemptCount?: number;
  confirmAttempts?: number;
  lastErrorKind?: string | null;
  lastErrorCode?: string | null;
  failureReason?: string | null;
  retryable?: boolean;
  deferredReason?: string | null;
  /** Clears the lease (leaseOwner / leaseExpiresAt). */
  releaseLease?: boolean;
}

export interface JobContext {
  accountId: string;
  videoId: string;
  caption: string | null;
}

export interface AttemptEvent {
  jobId: string;
  step: ExecutionStep;
  at: Date;
  outcome: 'SUCCESS' | 'ERROR';
  errorKind?: string;
  errorCode?: string;
  httpStatus?: number;
}

/**
 * Persistence port. The production implementation is Postgres-backed and must
 * provide these guarantees (the in-memory test double mirrors them):
 *
 *  claim():   ATOMIC. Succeeds only if the job is non-terminal, due
 *             (nextAttemptAt <= now), not under a live lease, no other job of the
 *             same account holds a live lease (ACCOUNT_BUSY) and no EARLIER
 *             blocking job of the same account exists (OUT_OF_ORDER). Sets the lease.
 *  update():  compare-and-set on the lease; throws LeaseLostError if the caller no
 *             longer holds it. Validates the status transition.
 *  getCycleGuard(): a FRESH read (no cache) of the cycle row.
 */
export interface JobStore {
  claim(jobId: string, args: { workerId: string; now: Date; leaseMs: number }): Promise<ClaimResult>;
  update(jobId: string, workerId: string, patch: JobPatch, now: Date): Promise<PublishJobRecord>;
  getCycleGuard(cycleId: string): Promise<CycleState | null>;
  getJobContext(jobId: string): Promise<JobContext>;
  recordAttempt(event: AttemptEvent): Promise<void>;
  pauseCycle(cycleId: string, reason: PauseReason, now: Date): Promise<void>;
}

export interface MediaUrlProvider {
  /** Short-lived, publicly fetchable URL for the stored video. */
  getFetchUrl(videoId: string, ttlSeconds: number): Promise<string>;
}

/* ----------------------------------------------------------------- config */

export interface ExecutorConfig {
  maxAttempts: number;
  leaseMs: number;
  backoff: BackoffConfig;
  quotaRecheckMs: number;
  quotaReserve: number;
  processingPollMs: number;
  /** Give up on a container that is still processing after this long (Meta advises polling for at most a few minutes). */
  processingMaxMs: number;
  /** After an uncertain publish, wait this long before reconciling. */
  settleMs: number;
  confirmPollMs: number;
  confirmMaxAttempts: number;
  mediaUrlTtlSeconds: number;
}

export const DEFAULT_EXECUTOR_CONFIG: ExecutorConfig = {
  maxAttempts: 5,
  leaseMs: 5 * 60_000,
  backoff: DEFAULT_BACKOFF,
  quotaRecheckMs: 15 * 60_000,
  quotaReserve: 0,
  processingPollMs: 15_000,
  processingMaxMs: 5 * 60_000,
  settleMs: 60_000,
  confirmPollMs: 30_000,
  confirmMaxAttempts: 3,
  mediaUrlTtlSeconds: 3600,
};

/* --------------------------------------------------------------- outcomes */

export type ExecuteOutcome =
  | { kind: 'NOT_CLAIMED'; reason: Extract<ClaimResult, { claimed: false }>['reason']; retryAt: Date | null }
  | { kind: 'LEASE_LOST' }
  /** ACCEPTED = published per the API but not (yet) confirmed. SIMULATED = mock provider. */
  | { kind: 'COMPLETED'; status: 'CONFIRMED' | 'ACCEPTED' | 'SIMULATED' }
  | { kind: 'WAIT'; reason: 'POLL_MEDIA' | 'RECONCILE' | 'CONFIRM' | 'RETRY' | 'DEFERRED'; runAt: Date }
  | { kind: 'FAILED'; retryable: boolean; reason: string }
  | { kind: 'CANCELLED' }
  | { kind: 'EXPIRED' }
  | { kind: 'CYCLE_PAUSED'; reason: PauseReason | 'CYCLE_PAUSED' };

/* --------------------------------------------------------------- internals */

class StepFailure extends Error {
  constructor(
    readonly step: ExecutionStep,
    readonly providerError: ProviderError,
    readonly resetContainer = false,
  ) {
    super(providerError.message);
    this.name = 'StepFailure';
  }
}

interface Run {
  job: PublishJobRecord;
  workerId: string;
  ctx: JobContext;
  provider: InstagramProvider;
}

export interface ExecutorDeps {
  store: JobStore;
  providers: ProviderResolver;
  media: MediaUrlProvider;
  clock: Clock;
  rng: Rng;
  config?: Partial<ExecutorConfig>;
}

/**
 * Executes ONE publish job, one bounded slice at a time.
 *
 * Safety model (at-least-once execution, never-blind-retry publishing):
 *  1. Everything is claimed with a lease; duplicate queue deliveries cannot run
 *     the same job concurrently.
 *  2. The container id is persisted right after creation, so a crashed worker
 *     resumes the SAME container instead of creating another.
 *  3. Before the only irreversible call (publish) the job is persisted as
 *     PUBLISH_REQUESTED. If the response is lost, the job is RECONCILED against
 *     the provider (container status) after a settle window; publish is called
 *     again only if the provider shows the container as not published.
 *  4. Cycle state is re-read fresh before every irreversible step; stop/expiry
 *     cancel work that has not reached PUBLISH_REQUESTED.
 *
 * Residual risk (cannot be eliminated by the client): if the provider has not yet
 * reflected a publish whose response we lost, and the settle window is shorter
 * than that delay, a second publish could occur. Exactly-once is NOT claimed.
 */
export class PublishExecutor {
  private readonly cfg: ExecutorConfig;
  private readonly store: JobStore;
  private readonly providers: ProviderResolver;
  private readonly media: MediaUrlProvider;
  private readonly clock: Clock;
  private readonly rng: Rng;

  constructor(deps: ExecutorDeps) {
    this.cfg = { ...DEFAULT_EXECUTOR_CONFIG, ...deps.config };
    this.store = deps.store;
    this.providers = deps.providers;
    this.media = deps.media;
    this.clock = deps.clock;
    this.rng = deps.rng;
  }

  async execute(jobId: string, workerId: string): Promise<ExecuteOutcome> {
    const claim = await this.store.claim(jobId, {
      workerId,
      now: this.clock.now(),
      leaseMs: this.cfg.leaseMs,
    });
    if (!claim.claimed) return { kind: 'NOT_CLAIMED', reason: claim.reason, retryAt: claim.retryAt };

    const run: Run = {
      job: claim.job,
      workerId,
      ctx: await this.store.getJobContext(jobId),
      provider: this.providers.resolve(claim.job.provider),
    };

    try {
      try {
        return await this.drive(run);
      } catch (err) {
        if (err instanceof StepFailure) return await this.onStepFailure(run, err);
        throw err;
      }
    } catch (err) {
      if (err instanceof LeaseLostError) return { kind: 'LEASE_LOST' };
      throw err; // infrastructure error: lease expires, queue redelivers, state is persisted
    }
  }

  /* ------------------------------------------------------------ main flow */

  private async drive(run: Run): Promise<ExecuteOutcome> {
    // A. Already published: only confirmation remains.
    if (run.job.status === 'ACCEPTED' || run.job.mediaId) return this.confirm(run);

    // B. A publish was requested and its outcome is unknown: reconcile first.
    if (run.job.publishRequestedAt) {
      const outcome = await this.reconcile(run);
      if (outcome) return outcome;
    }

    // C. Cancellation / expiry / pause guard.
    const guarded = await this.guard(run);
    if (guarded) return guarded;

    // D. Quota preflight before spending a container.
    if (!run.job.containerId) {
      const gated = await this.quotaGate(run);
      if (gated) return gated;
      const created = await this.createContainer(run);
      if (created) return created;
    }

    // E. Wait for media processing.
    const polled = await this.pollContainer(run);
    if (polled) return polled;

    // F. The irreversible step.
    return this.publish(run);
  }

  private async guard(run: Run): Promise<ExecuteOutcome | null> {
    const now = this.clock.now();
    const cycle = await this.store.getCycleGuard(run.job.cycleId);
    if (!cycle) {
      await this.upd(run, { status: 'CANCELLED', failureReason: 'CYCLE_NOT_FOUND', releaseLease: true });
      return { kind: 'CANCELLED' };
    }
    switch (effectiveStatus(cycle, now)) {
      case 'ACTIVE':
        return null;
      case 'PAUSED':
        await this.upd(run, { status: 'SCHEDULED', nextAttemptAt: now, releaseLease: true });
        return { kind: 'CYCLE_PAUSED', reason: 'CYCLE_PAUSED' };
      case 'STOPPED':
        await this.upd(run, { status: 'CANCELLED', failureReason: 'CYCLE_STOPPED', releaseLease: true });
        return { kind: 'CANCELLED' };
      case 'EXPIRED':
      case 'COMPLETED':
        await this.upd(run, { status: 'EXPIRED', failureReason: 'CYCLE_EXPIRED', releaseLease: true });
        return { kind: 'EXPIRED' };
    }
  }

  private async quotaGate(run: Run): Promise<ExecuteOutcome | null> {
    const quota = await this.call(run, 'QUOTA_CHECK', () =>
      run.provider.getPublishingQuota(run.ctx.accountId),
    );
    const valid = isValidQuota(quota);
    if (valid && remainingQuota(quota, this.cfg.quotaReserve) > 0) return null;

    const runAt = new Date(this.clock.now().getTime() + this.cfg.quotaRecheckMs);
    await this.upd(run, {
      status: 'DEFERRED',
      nextAttemptAt: runAt,
      deferredReason: valid ? 'QUOTA_EXHAUSTED' : 'QUOTA_UNKNOWN',
      releaseLease: true,
    });
    return { kind: 'WAIT', reason: 'DEFERRED', runAt };
  }

  private async createContainer(run: Run): Promise<ExecuteOutcome | null> {
    await this.upd(run, { status: 'CREATING_CONTAINER' });
    const videoUrl = await this.media.getFetchUrl(run.ctx.videoId, this.cfg.mediaUrlTtlSeconds);
    const { containerId } = await this.call(run, 'CREATE_CONTAINER', () =>
      run.provider.createReelContainer(run.ctx.accountId, {
        videoUrl,
        caption: run.ctx.caption,
        idempotencyKey: run.job.idempotencyKey,
      }),
    );
    const now = this.clock.now();
    // Persist the container id immediately: a crash from here on resumes THIS container.
    await this.upd(run, {
      status: 'PROCESSING_MEDIA',
      containerId,
      containerCreatedAt: now,
      nextAttemptAt: now,
    });
    return null;
  }

  private async pollContainer(run: Run): Promise<ExecuteOutcome | null> {
    if (run.job.status !== 'PROCESSING_MEDIA') await this.upd(run, { status: 'PROCESSING_MEDIA' });
    const containerId = this.requireContainer(run);
    const s = await this.call(run, 'POLL_STATUS', () =>
      run.provider.getContainerStatus(run.ctx.accountId, containerId),
    );
    const now = this.clock.now();

    switch (s.status) {
      case 'FINISHED':
        return null;

      case 'IN_PROGRESS': {
        const startedAt = run.job.containerCreatedAt ?? now;
        if (now.getTime() - startedAt.getTime() > this.cfg.processingMaxMs) {
          throw new StepFailure(
            'POLL_STATUS',
            new ProviderError('TRANSIENT', 'Media processing timed out', { code: 'PROCESSING_TIMEOUT' }),
            true,
          );
        }
        const runAt = new Date(now.getTime() + this.cfg.processingPollMs);
        await this.upd(run, { status: 'PROCESSING_MEDIA', nextAttemptAt: runAt, releaseLease: true });
        return { kind: 'WAIT', reason: 'POLL_MEDIA', runAt };
      }

      case 'ERROR':
        throw new StepFailure(
          'POLL_STATUS',
          new ProviderError('MEDIA_REJECTED', 'The provider rejected the media', {
            ...(s.errorCode ? { code: s.errorCode } : {}),
          }),
        );

      case 'EXPIRED':
        throw new StepFailure(
          'POLL_STATUS',
          new ProviderError('TRANSIENT', 'Container expired before publishing', { code: 'CONTAINER_EXPIRED' }),
          true,
        );

      case 'PUBLISHED':
        // Published by an earlier attempt whose bookkeeping was lost.
        return this.markPublished(run, s.mediaId ?? null);
    }
  }

  private async publish(run: Run): Promise<ExecuteOutcome> {
    // Last gates before the irreversible call.
    const guarded = await this.guard(run);
    if (guarded) return guarded;
    const gated = await this.quotaGate(run);
    if (gated) return gated;

    const containerId = this.requireContainer(run);
    const now = this.clock.now();
    // Persist the intent BEFORE calling the provider. nextAttemptAt keeps a
    // crashed-and-redelivered duplicate from acting before the settle window.
    await this.upd(run, {
      status: 'PUBLISH_REQUESTED',
      publishRequestedAt: now,
      nextAttemptAt: new Date(now.getTime() + this.cfg.settleMs),
    });

    const { mediaId } = await this.call(run, 'PUBLISH', () =>
      run.provider.publishContainer(run.ctx.accountId, containerId),
    );
    return this.markPublished(run, mediaId);
  }

  /** Records a publication the provider has taken, honestly labelled by provider kind. */
  private async markPublished(run: Run, mediaId: string | null): Promise<ExecuteOutcome> {
    const now = this.clock.now();
    if (run.provider.isMock) {
      await this.upd(run, { status: 'SIMULATED', mediaId, nextAttemptAt: now, releaseLease: true });
      return { kind: 'COMPLETED', status: 'SIMULATED' };
    }
    await this.upd(run, { status: 'ACCEPTED', mediaId, nextAttemptAt: now });
    return this.confirm(run);
  }

  private async reconcile(run: Run): Promise<ExecuteOutcome | null> {
    const now = this.clock.now();
    const requestedAt = run.job.publishRequestedAt;
    if (!requestedAt) return null;

    const settleUntil = new Date(requestedAt.getTime() + this.cfg.settleMs);
    if (now.getTime() < settleUntil.getTime()) {
      await this.upd(run, { status: 'PUBLISH_REQUESTED', nextAttemptAt: settleUntil, releaseLease: true });
      return { kind: 'WAIT', reason: 'RECONCILE', runAt: settleUntil };
    }

    if (!run.job.containerId) {
      // Cannot verify without a container: never guess.
      await this.upd(run, {
        status: 'FAILED',
        failureReason: 'PUBLISH_OUTCOME_UNKNOWN',
        retryable: false,
        releaseLease: true,
      });
      return { kind: 'FAILED', retryable: false, reason: 'PUBLISH_OUTCOME_UNKNOWN' };
    }

    const containerId = run.job.containerId;
    const s = await this.call(run, 'RECONCILE', () =>
      run.provider.getContainerStatus(run.ctx.accountId, containerId),
    );

    switch (s.status) {
      case 'PUBLISHED':
        return this.markPublished(run, s.mediaId ?? run.job.mediaId ?? null);

      case 'FINISHED':
        // Settled and still unpublished: the earlier publish did not take effect.
        await this.upd(run, { status: 'PROCESSING_MEDIA', publishRequestedAt: null });
        return null;

      case 'ERROR':
      case 'EXPIRED':
        // Unusable and unpublished: start over with a new container.
        await this.upd(run, {
          status: 'CREATING_CONTAINER',
          containerId: null,
          containerCreatedAt: null,
          publishRequestedAt: null,
        });
        return null;

      case 'IN_PROGRESS':
        throw new StepFailure(
          'RECONCILE',
          new ProviderError('TRANSIENT', 'Provider state indeterminate during reconciliation', {
            code: 'RECONCILE_INDETERMINATE',
          }),
        );
    }
  }

  private async confirm(run: Run): Promise<ExecuteOutcome> {
    const containerId = this.requireContainer(run);
    let result: ConfirmResult;
    try {
      result = await this.call(run, 'CONFIRM', () =>
        run.provider.confirmMedia(run.ctx.accountId, { mediaId: run.job.mediaId, containerId }),
      );
    } catch (err) {
      // The post is already accepted; a failed confirmation never undoes that.
      if (!(err instanceof StepFailure)) throw err;
      result = { state: 'INDETERMINATE' };
    }

    const now = this.clock.now();
    if (result.state === 'CONFIRMED') {
      await this.upd(run, { status: 'CONFIRMED', permalink: result.permalink ?? null, releaseLease: true });
      return { kind: 'COMPLETED', status: 'CONFIRMED' };
    }

    const attempts = run.job.confirmAttempts + 1;
    if (attempts >= this.cfg.confirmMaxAttempts) {
      await this.upd(run, {
        status: 'ACCEPTED',
        confirmAttempts: attempts,
        nextAttemptAt: now,
        releaseLease: true,
      });
      return { kind: 'COMPLETED', status: 'ACCEPTED' };
    }
    const runAt = new Date(now.getTime() + this.cfg.confirmPollMs);
    await this.upd(run, {
      status: 'ACCEPTED',
      confirmAttempts: attempts,
      nextAttemptAt: runAt,
      releaseLease: true,
    });
    return { kind: 'WAIT', reason: 'CONFIRM', runAt };
  }

  /* ----------------------------------------------------------- error path */

  private async onStepFailure(run: Run, failure: StepFailure): Promise<ExecuteOutcome> {
    const err = failure.providerError;
    const decision = decideOnError({
      error: err,
      step: failure.step,
      attemptsSoFar: run.job.attemptCount,
      maxAttempts: this.cfg.maxAttempts,
      backoff: this.cfg.backoff,
      rng: this.rng,
      quotaRecheckMs: this.cfg.quotaRecheckMs,
      settleMs: this.cfg.settleMs,
    });
    const now = this.clock.now();
    const attempts = run.job.attemptCount + 1;
    const common: JobPatch = {
      lastErrorKind: err.kind,
      lastErrorCode: err.code ?? null,
      releaseLease: true,
    };
    const clearPublish: JobPatch = decision.clearPublishRequest ? { publishRequestedAt: null } : {};
    const resetContainer: JobPatch = failure.resetContainer
      ? { containerId: null, containerCreatedAt: null }
      : {};

    switch (decision.action) {
      case 'RETRY': {
        const runAt = new Date(now.getTime() + decision.delayMs);
        const keepsContainer = run.job.containerId !== null && !failure.resetContainer;
        await this.upd(run, {
          ...common,
          ...resetContainer,
          status: keepsContainer ? 'PROCESSING_MEDIA' : 'RETRY_WAIT',
          attemptCount: attempts,
          nextAttemptAt: runAt,
        });
        return { kind: 'WAIT', reason: 'RETRY', runAt };
      }

      case 'RECONCILE': {
        const runAt = new Date(now.getTime() + decision.delayMs);
        await this.upd(run, {
          ...common,
          status: 'PUBLISH_REQUESTED',
          attemptCount: attempts,
          nextAttemptAt: runAt,
        });
        return { kind: 'WAIT', reason: 'RECONCILE', runAt };
      }

      case 'DEFER': {
        const runAt = new Date(now.getTime() + decision.delayMs);
        await this.upd(run, {
          ...common,
          ...clearPublish,
          status: 'DEFERRED',
          deferredReason: decision.reason,
          nextAttemptAt: runAt,
        });
        return { kind: 'WAIT', reason: 'DEFERRED', runAt };
      }

      case 'PAUSE_CYCLE':
        await this.store.pauseCycle(run.job.cycleId, decision.reason, now);
        await this.upd(run, { ...common, ...clearPublish, status: 'SCHEDULED', nextAttemptAt: now });
        return { kind: 'CYCLE_PAUSED', reason: decision.reason };

      case 'FAIL':
        await this.upd(run, {
          ...common,
          ...clearPublish,
          status: 'FAILED',
          failureReason: decision.reason,
          retryable: decision.retryable,
          attemptCount: attempts,
        });
        return { kind: 'FAILED', retryable: decision.retryable, reason: decision.reason };
    }
  }

  /* -------------------------------------------------------------- helpers */

  private async upd(run: Run, patch: JobPatch): Promise<void> {
    run.job = await this.store.update(run.job.id, run.workerId, patch, this.clock.now());
  }

  private requireContainer(run: Run): string {
    if (!run.job.containerId) {
      throw new Error(`Invariant violated: job ${run.job.id} has no container id`);
    }
    return run.job.containerId;
  }

  /** Every provider call is recorded as an attempt event and attributed to a step. */
  private async call<T>(run: Run, step: ExecutionStep, fn: () => Promise<T>): Promise<T> {
    const at = this.clock.now();
    try {
      const value = await fn();
      await this.store.recordAttempt({ jobId: run.job.id, step, at, outcome: 'SUCCESS' });
      return value;
    } catch (err) {
      if (err instanceof ProviderError) {
        await this.store.recordAttempt({
          jobId: run.job.id,
          step,
          at,
          outcome: 'ERROR',
          errorKind: err.kind,
          ...(err.code ? { errorCode: err.code } : {}),
          ...(err.httpStatus !== undefined ? { httpStatus: err.httpStatus } : {}),
        });
        throw new StepFailure(step, err);
      }
      throw err;
    }
  }
}
