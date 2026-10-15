import {
  FakeClock,
  MockInstagramProvider,
  PublishExecutor,
  assertTransition,
  blocksLaterJobs,
  LeaseLostError,
  makeIdempotencyKey,
  seededRng,
  TERMINAL_JOB_STATUSES,
  type AttemptEvent,
  type ClaimResult,
  type CycleState,
  type ExecutorConfig,
  type InstagramProvider,
  type JobContext,
  type JobPatch,
  type JobStore,
  type PauseReason,
  type ProviderKind,
  type PublishJobRecord,
  type ProviderResolver,
  type MediaUrlProvider,
} from '../../src';

/**
 * TEST DOUBLE ONLY. Mirrors the atomicity contract documented on JobStore.
 * Production uses a Postgres-backed store; this never ships in a runtime path.
 * JS is single-threaded, so each method body below is atomic like a DB transaction.
 */
export class InMemoryJobStore implements JobStore {
  readonly jobs = new Map<string, PublishJobRecord>();
  readonly cycles = new Map<string, CycleState>();
  readonly contexts = new Map<string, JobContext>();
  readonly attempts: AttemptEvent[] = [];
  readonly pauses: { cycleId: string; reason: PauseReason }[] = [];

  constructor(private readonly nowFn: () => Date) {}

  addCycle(id: string, state: CycleState): void {
    this.cycles.set(id, { ...state });
  }

  setCycleStatus(id: string, status: CycleState['status']): void {
    const c = this.cycles.get(id);
    if (!c) throw new Error('no cycle');
    c.status = status;
  }

  addJob(o: Partial<PublishJobRecord> & { id: string; cycleId: string; accountId: string; videoId: string }): PublishJobRecord {
    const now = this.nowFn();
    const job: PublishJobRecord = {
      sequenceNo: 1,
      iteration: 1,
      idempotencyKey: makeIdempotencyKey(o.cycleId, o.videoId, o.iteration ?? 1),
      provider: 'MOCK' as ProviderKind,
      status: 'SCHEDULED',
      attemptCount: 0,
      nextAttemptAt: now,
      containerId: null,
      containerCreatedAt: null,
      publishRequestedAt: null,
      mediaId: null,
      permalink: null,
      confirmAttempts: 0,
      leaseOwner: null,
      leaseExpiresAt: null,
      lastErrorKind: null,
      lastErrorCode: null,
      failureReason: null,
      retryable: false,
      deferredReason: null,
      version: 1,
      createdAt: now,
      updatedAt: now,
      ...o,
    };
    this.jobs.set(job.id, job);
    this.contexts.set(job.id, { accountId: job.accountId, videoId: job.videoId, caption: null });
    return job;
  }

  get(id: string): PublishJobRecord {
    const j = this.jobs.get(id);
    if (!j) throw new Error(`no job ${id}`);
    return { ...j };
  }

  async claim(jobId: string, args: { workerId: string; now: Date; leaseMs: number }): Promise<ClaimResult> {
    const job = this.jobs.get(jobId);
    if (!job) return { claimed: false, reason: 'NOT_FOUND', retryAt: null };
    if (TERMINAL_JOB_STATUSES.has(job.status)) return { claimed: false, reason: 'TERMINAL', retryAt: null };
    const now = args.now.getTime();
    if (job.nextAttemptAt.getTime() > now) {
      return { claimed: false, reason: 'NOT_DUE', retryAt: job.nextAttemptAt };
    }
    if (job.leaseOwner && job.leaseExpiresAt && job.leaseExpiresAt.getTime() > now) {
      return { claimed: false, reason: 'LEASED', retryAt: job.leaseExpiresAt };
    }
    for (const other of this.jobs.values()) {
      if (other.id === job.id || other.accountId !== job.accountId) continue;
      if (other.leaseOwner && other.leaseExpiresAt && other.leaseExpiresAt.getTime() > now) {
        return { claimed: false, reason: 'ACCOUNT_BUSY', retryAt: other.leaseExpiresAt };
      }
      if (blocksLaterJobs(other.status) && other.sequenceNo < job.sequenceNo) {
        return { claimed: false, reason: 'OUT_OF_ORDER', retryAt: null };
      }
    }
    job.leaseOwner = args.workerId;
    job.leaseExpiresAt = new Date(now + args.leaseMs);
    job.version += 1;
    return { claimed: true, job: { ...job } };
  }

  async update(jobId: string, workerId: string, patch: JobPatch, now: Date): Promise<PublishJobRecord> {
    const job = this.jobs.get(jobId);
    if (!job) throw new Error(`no job ${jobId}`);
    if (job.leaseOwner !== workerId || !job.leaseExpiresAt || job.leaseExpiresAt.getTime() <= now.getTime()) {
      throw new LeaseLostError(jobId);
    }
    if (patch.status) assertTransition(job.status, patch.status);
    const { releaseLease, ...fields } = patch;
    Object.assign(job, fields);
    if (releaseLease) {
      job.leaseOwner = null;
      job.leaseExpiresAt = null;
    }
    job.version += 1;
    job.updatedAt = now;
    return { ...job };
  }

  async getCycleGuard(cycleId: string): Promise<CycleState | null> {
    const c = this.cycles.get(cycleId);
    return c ? { ...c } : null;
  }

  async getJobContext(jobId: string): Promise<JobContext> {
    const c = this.contexts.get(jobId);
    if (!c) throw new Error('no context');
    return c;
  }

  async recordAttempt(event: AttemptEvent): Promise<void> {
    this.attempts.push(event);
  }

  async pauseCycle(cycleId: string, reason: PauseReason): Promise<void> {
    this.pauses.push({ cycleId, reason });
    this.setCycleStatus(cycleId, 'PAUSED');
  }
}

/** Wraps a mock so it reports itself as a REAL provider (isMock=false) for confirm-path tests. */
export class FakeRealProvider implements InstagramProvider {
  readonly kind = 'META' as const;
  readonly isMock = false as const;
  constructor(readonly inner: MockInstagramProvider) {}
  getPublishingQuota = (a: string) => this.inner.getPublishingQuota(a);
  checkEligibility = (a: string) => this.inner.checkEligibility(a);
  createReelContainer: InstagramProvider['createReelContainer'] = (a, i) => this.inner.createReelContainer(a, i);
  getContainerStatus = (a: string, c: string) => this.inner.getContainerStatus(a, c);
  publishContainer = (a: string, c: string) => this.inner.publishContainer(a, c);
  confirmMedia: InstagramProvider['confirmMedia'] = (a, r) => this.inner.confirmMedia(a, r);
}

export const T0 = new Date('2026-10-14T10:00:00.000Z');

export interface Harness {
  clock: FakeClock;
  store: InMemoryJobStore;
  provider: MockInstagramProvider;
  executor: PublishExecutor;
  media: MediaUrlProvider;
  /** Registers a cycle (ACTIVE, 24h window from T0) and returns its id. */
  addCycle(id?: string, over?: Partial<CycleState>): string;
  /** Registers a job on account "acct-1" for the given cycle. */
  addJob(id: string, over?: Partial<PublishJobRecord>): PublishJobRecord;
}

export function makeHarness(opts: { config?: Partial<ExecutorConfig>; real?: boolean } = {}): Harness {
  const clock = new FakeClock(T0);
  const store = new InMemoryJobStore(() => clock.now());
  const provider = new MockInstagramProvider(() => clock.now());
  const resolver: ProviderResolver = {
    resolve: (kind) => (opts.real && kind === 'META' ? new FakeRealProvider(provider) : provider),
  };
  const media: MediaUrlProvider = {
    getFetchUrl: async (videoId, ttl) => `https://signed.example.test/${videoId}.mp4?ttl=${ttl}&sig=test`,
  };
  const executor = new PublishExecutor({
    store,
    providers: resolver,
    media,
    clock,
    rng: seededRng(42),
    ...(opts.config ? { config: opts.config } : {}),
  });
  return {
    clock,
    store,
    provider,
    executor,
    media,
    addCycle(id = 'cycle-1', over = {}) {
      store.addCycle(id, {
        status: 'ACTIVE',
        startedAt: T0,
        endsAt: new Date(T0.getTime() + 24 * 3_600_000),
        ...over,
      });
      return id;
    },
    addJob(id, over = {}) {
      return store.addJob({
        id,
        cycleId: 'cycle-1',
        accountId: 'acct-1',
        videoId: `video-${id}`,
        provider: opts.real ? 'META' : 'MOCK',
        ...over,
      });
    },
  };
}
