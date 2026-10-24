// packages/services/src/app-services.ts
import {
  SCHEDULER_LIMITS, effectiveStatus, validateSchedulerSettings, ProviderError,
  type Clock, type ProviderResolver, type PublishQuota,
} from '@reelqueue/core';
import {
  AccountStore, QueryStore, SchedulerStore, SettingsStore, VideoStore,
  type AccountRow, type CycleRow, type JobView, type VideoRow,
} from '@reelqueue/db';
import {
  AppError, type CompleteUploadResponse, type CycleDto, type CycleWarningDto, type DashboardDto, type InstagramAccountDto, type JobDto,
  type Page, type QuotaDto, type SettingsDto, type StartCycleRequest, type StorageUsageDto, type UpdateSettingsRequest, type VideoDto,
} from '@reelqueue/shared';
import type { UserRow } from '@reelqueue/db';
import type { WakeQueue } from './scheduler-runner';
import { AuthService } from './auth-service';
import { UploadService } from './upload-service';

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const clampPage = (page?: number, pageSize?: number) => {
  const size = Math.min(100, Math.max(1, Math.trunc(pageSize ?? 20)));
  const p = Math.max(1, Math.trunc(page ?? 1));
  return { page: p, pageSize: size, offset: (p - 1) * size };
};

/** Provider failures never leak details to the client. */
export function mapProviderError(e: unknown): AppError {
  if (e instanceof ProviderError && (e.kind === 'AUTH_EXPIRED' || e.kind === 'PERMISSION_REVOKED')) {
    return new AppError('INSTAGRAM_REAUTH_REQUIRED', 'Reconnect your Instagram account to continue.');
  }
  return new AppError('INTERNAL', 'Instagram is temporarily unavailable. Please try again later.');
}

/* ------------------------------------------------------------------------- read models -> DTOs */
export interface ReadDeps {
  cycles: SchedulerStore; query: QueryStore; accounts: AccountStore; settings: SettingsStore; uploads: UploadService; videos: VideoStore;
  clock: Clock; /** true when INSTAGRAM_PROVIDER=mock: the UI must show a persistent "simulation" banner. */ mockMode: boolean;
}

export class ReadService {
  constructor(private readonly d: ReadDeps) {}

  accountDto(a: AccountRow): InstagramAccountDto {
    const quota: QuotaDto | null = a.quota ? { used: a.quota.used, total: a.quota.total, windowSeconds: a.quota.windowSeconds, remaining: Math.max(0, a.quota.total - a.quota.used), fetchedAt: a.quota.fetchedAt.toISOString() } : null;
    return { id: a.id, provider: a.provider, isMock: a.provider === 'MOCK', username: a.username, accountType: a.accountType, status: a.status, tokenExpiresAt: iso(a.tokenExpiresAt), quota, lastErrorCode: a.lastErrorCode, createdAt: a.createdAt.toISOString() };
  }

  async cycleDto(c: CycleRow): Promise<CycleDto> {
    const now = this.d.clock.now();
    const status = effectiveStatus({ status: c.status, startedAt: c.startedAt, endsAt: c.endsAt }, now);
    const counts = await this.d.query.cycleCounts(c.userId, c.id, c.cursor.lastPosition);
    const acc = await this.d.accounts.get(c.userId, c.accountId);
    const warnings: CycleWarningDto[] = [];
    if (c.provider === 'MOCK') warnings.push({ code: 'MOCK_MODE', message: 'Simulation only: nothing is published to Instagram.' });
    if (status === 'PAUSED' && c.pauseReason && c.pauseReason !== 'USER') {
      warnings.push({ code: 'AUTO_PAUSED', message: 'The cycle was paused automatically.' });
      if (c.pauseReason === 'ACCOUNT_REAUTH_REQUIRED' || c.pauseReason === 'PERMISSION_REVOKED') warnings.push({ code: 'REAUTH_REQUIRED', message: 'Reconnect the Instagram account, then resume.' });
    }
    if (status === 'ACTIVE') {
      if (!acc?.quota) warnings.push({ code: 'QUOTA_UNKNOWN', message: 'The publishing quota is not known yet; nothing is published until it is.' });
      else {
        const remaining = Math.max(0, acc.quota.total - acc.quota.used);
        if (remaining === 0) warnings.push({ code: 'QUOTA_EXHAUSTED', message: 'The daily publishing quota is used up; publishing resumes when it frees.' });
        else if (remaining < c.batchSize) warnings.push({ code: 'QUOTA_LIMITED', message: `Only ${remaining} publication(s) remain in the current quota window.` });
      }
    }
    const live = status === 'ACTIVE' || status === 'PAUSED';
    return {
      id: c.id, instagramAccountId: c.accountId, provider: c.provider, isMock: c.provider === 'MOCK', status, pauseReason: c.pauseReason,
      batchSize: c.batchSize, intervalMinutes: c.intervalMinutes, loopEnabled: c.loopEnabled, startedAt: c.startedAt.toISOString(), endsAt: c.endsAt.toISOString(),
      nextBatchAt: live ? c.nextBatchAt.toISOString() : null, endedAt: iso(c.endedAt), endReason: c.endReason, iteration: c.cursor.iteration, counts, warnings,
    };
  }

  jobDto(j: JobView): JobDto {
    return {
      id: j.id, cycleId: j.cycleId, videoId: j.videoId, videoFilename: j.videoFilename, sequenceNo: j.sequenceNo, iteration: j.iteration, status: j.status as JobDto['status'],
      isMock: j.provider === 'MOCK', nextAttemptAt: j.nextAttemptAt.toISOString(), attemptCount: j.attemptCount, deferredReason: j.deferredReason, failureReason: j.failureReason,
      lastErrorCode: j.lastErrorCode, retryable: j.retryable, permalink: j.permalink, createdAt: j.createdAt.toISOString(), updatedAt: j.updatedAt.toISOString(),
    };
  }

  async videoDtos(userId: string, rows: readonly VideoRow[]): Promise<VideoDto[]> {
    const flags = await this.d.query.videoFlags(userId, rows.map((r) => r.id));
    return rows.map((v) => ({
      id: v.id, filename: v.filename, contentType: v.contentType, sizeBytes: v.sizeBytes, durationMs: v.durationMs, width: v.width, height: v.height, status: v.status,
      rejectionReason: v.rejectionReason, caption: v.caption, position: v.position, createdAt: v.createdAt.toISOString(),
      inUse: flags.get(v.id)?.inUse ?? false, publishedCount: flags.get(v.id)?.publishedCount ?? 0,
    }));
  }

  async storage(userId: string): Promise<StorageUsageDto> {
    const u = await this.d.uploads.usage(userId);
    return { bytesUsed: u.usedBytes, bytesReserved: u.reservedBytes, quotaBytes: u.quotaBytes, videoCount: u.videoCount, maxVideos: u.maxVideos, percentUsed: u.percentUsed, level: u.level };
  }

  async settings(userId: string): Promise<SettingsDto> {
    const s = await this.d.settings.get(userId);
    return {
      timezone: s.timezone, batchSize: s.batchSize, intervalMinutes: s.intervalMinutes, cycleDurationHours: s.cycleDurationHours, loopEnabled: s.loopEnabled,
      defaultInstagramAccountId: s.defaultInstagramAccountId,
      limits: { storageQuotaBytes: s.storageQuotaBytes, maxVideos: s.maxVideos, maxUploadBatch: s.maxUploadBatch,
        batchSize: { min: SCHEDULER_LIMITS.batchSize.min, max: SCHEDULER_LIMITS.batchSize.max },
        intervalMinutes: { min: SCHEDULER_LIMITS.intervalMinutes.min, max: SCHEDULER_LIMITS.intervalMinutes.max },
        cycleDurationHours: { min: SCHEDULER_LIMITS.cycleDurationHours.min, max: SCHEDULER_LIMITS.cycleDurationHours.max } },
    };
  }

  async listVideos(userId: string, q: { status?: VideoDto['status']; page?: number; pageSize?: number }): Promise<Page<VideoDto>> {
    const pg = clampPage(q.page, q.pageSize);
    const r = await this.d.uploads.listVideos(userId, { ...(q.status ? { status: q.status } : {}), limit: pg.pageSize, offset: pg.offset });
    return { items: await this.videoDtos(userId, r.items), page: pg.page, pageSize: pg.pageSize, total: r.total };
  }

  async listCycles(userId: string, q: { page?: number; pageSize?: number }): Promise<Page<CycleDto>> {
    const pg = clampPage(q.page, q.pageSize);
    const { ids, total } = await this.d.query.listCycleIds(userId, pg.pageSize, pg.offset);
    const items: CycleDto[] = [];
    for (const id of ids) { const c = await this.d.cycles.getCycle(userId, id); if (c) items.push(await this.cycleDto(c)); }
    return { items, page: pg.page, pageSize: pg.pageSize, total };
  }

  async currentCycle(userId: string): Promise<CycleDto | null> {
    const c = await this.d.cycles.getLiveCycle(userId);
    if (!c) return null;
    const dto = await this.cycleDto(c);
    return dto.status === 'ACTIVE' || dto.status === 'PAUSED' ? dto : null; // lazily-expired cycles are not "current"
  }

  async listJobs(userId: string, q: { status?: string; cycleId?: string; from?: string; to?: string; page?: number; pageSize?: number }): Promise<Page<JobDto>> {
    const pg = clampPage(q.page, q.pageSize);
    const date = (v?: string, field = ''): Date | undefined => {
      if (v === undefined) return undefined;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new AppError('VALIDATION_FAILED', 'Invalid input.', [{ field, message: 'Must be an ISO date.' }]);
      return d;
    };
    const from = date(q.from, 'from'), to = date(q.to, 'to');
    const r = await this.d.query.listJobs(userId, { ...(q.status ? { status: q.status } : {}), ...(q.cycleId ? { cycleId: q.cycleId } : {}), ...(from ? { from } : {}), ...(to ? { to } : {}), limit: pg.pageSize, offset: pg.offset });
    return { items: r.items.map((j) => this.jobDto(j)), page: pg.page, pageSize: pg.pageSize, total: r.total };
  }

  async job(userId: string, jobId: string): Promise<JobDto | null> {
    const j = await this.d.query.getJob(userId, jobId);
    return j ? this.jobDto(j) : null;
  }

  async upcomingJobs(userId: string): Promise<JobDto[]> { return (await this.d.query.upcomingJobs(userId, 50)).map((j) => this.jobDto(j)); }

  async dashboard(userId: string): Promise<DashboardDto> {
    const [currentCycle, storage, accounts, totals] = await Promise.all([this.currentCycle(userId), this.storage(userId), this.d.accounts.list(userId), this.d.query.totals(userId)]);
    return { currentCycle, storage, accounts: accounts.map((a) => this.accountDto(a)), totals, mockMode: this.d.mockMode };
  }
}

/* ------------------------------------------------------------------------- settings */
export class SettingsService {
  constructor(private readonly settings: SettingsStore, private readonly accounts: AccountStore, private readonly read: ReadService) {}
  async get(userId: string): Promise<SettingsDto> { return this.read.settings(userId); }
  async update(userId: string, req: UpdateSettingsRequest): Promise<SettingsDto> {
    const cur = await this.settings.get(userId);
    const merged = {
      batchSize: req.batchSize ?? cur.batchSize, intervalMinutes: req.intervalMinutes ?? cur.intervalMinutes,
      cycleDurationHours: req.cycleDurationHours ?? cur.cycleDurationHours, loopEnabled: req.loopEnabled ?? cur.loopEnabled,
    };
    const v = validateSchedulerSettings(merged);
    if (!v.ok) throw new AppError('VALIDATION_FAILED', 'Invalid input.', v.errors.map((e) => ({ field: e.field, message: e.message })));
    if (req.timezone !== undefined) {
      try { new Intl.DateTimeFormat('en-US', { timeZone: req.timezone }); } catch { throw new AppError('VALIDATION_FAILED', 'Invalid input.', [{ field: 'timezone', message: 'Unknown time zone.' }]); }
    }
    if (req.defaultInstagramAccountId) {
      const a = await this.accounts.get(userId, req.defaultInstagramAccountId);
      if (!a || a.status === 'DISCONNECTED') throw new AppError('NOT_FOUND', 'Instagram account not found.');
    }
    await this.settings.update(userId, {
      ...(req.timezone !== undefined ? { timezone: req.timezone } : {}), ...(req.batchSize !== undefined ? { batchSize: v.value.batchSize } : {}),
      ...(req.intervalMinutes !== undefined ? { intervalMinutes: v.value.intervalMinutes } : {}), ...(req.cycleDurationHours !== undefined ? { cycleDurationHours: v.value.cycleDurationHours } : {}),
      ...(req.loopEnabled !== undefined ? { loopEnabled: v.value.loopEnabled } : {}),
      ...(req.defaultInstagramAccountId !== undefined ? { defaultInstagramAccountId: req.defaultInstagramAccountId } : {}),
    });
    return this.read.settings(userId);
  }
}

/* ------------------------------------------------------------------------- instagram accounts */
export class AccountService {
  constructor(private readonly accounts: AccountStore, private readonly cycles: SchedulerStore, private readonly providers: ProviderResolver,
    private readonly read: ReadService, private readonly clock: Clock, private readonly opts: { mockMode: boolean }) {}

  async list(userId: string): Promise<InstagramAccountDto[]> { return (await this.accounts.list(userId)).map((a) => this.read.accountDto(a)); }

  /** Only available when INSTAGRAM_PROVIDER=mock. Creates a clearly-marked simulated account; no real Instagram access exists behind it. */
  async mockConnect(userId: string, username: string): Promise<InstagramAccountDto> {
    if (!this.opts.mockMode) throw new AppError('MOCK_ONLY', 'Not found.');
    if (!/^[A-Za-z0-9._]{1,30}$/.test(username)) throw new AppError('VALIDATION_FAILED', 'Invalid input.', [{ field: 'username', message: '1-30 letters, digits, dots or underscores.' }]);
    return this.read.accountDto(await this.accounts.createMock(userId, username, 'mock:no-token'));
  }

  async disconnect(userId: string, id: string): Promise<InstagramAccountDto> {
    const r = await this.accounts.disconnect(userId, id, this.clock.now());
    if (!r.ok) throw r.code === 'NOT_FOUND' ? new AppError('NOT_FOUND', 'Instagram account not found.') : new AppError('CONFLICT', 'Stop the active publishing cycle before disconnecting this account.');
    return this.read.accountDto(r.account);
  }

  async refreshQuota(userId: string, id: string): Promise<QuotaDto> {
    const acc = await this.accounts.get(userId, id);
    if (!acc) throw new AppError('NOT_FOUND', 'Instagram account not found.');
    if (acc.status === 'DISCONNECTED') throw new AppError('INSTAGRAM_NOT_CONNECTED', 'This account is disconnected.');
    if (acc.status !== 'CONNECTED') throw new AppError('INSTAGRAM_REAUTH_REQUIRED', 'Reconnect your Instagram account to continue.');
    let q: PublishQuota;
    try { q = await this.providers.resolve(acc.provider).getPublishingQuota(acc.id); } catch (e) { throw mapProviderError(e); }
    await this.cycles.recordQuota(acc.id, q);
    const fresh = (await this.accounts.get(userId, id))!;
    return this.read.accountDto(fresh).quota!;
  }
}

/* ------------------------------------------------------------------------- cycles + jobs */
export class CycleService {
  constructor(private readonly store: SchedulerStore, private readonly accounts: AccountStore, private readonly settings: SettingsStore,
    private readonly providers: ProviderResolver, private readonly queue: WakeQueue, private readonly read: ReadService, private readonly clock: Clock) {}

  async start(userId: string, req: StartCycleRequest): Promise<CycleDto> {
    const s = await this.settings.get(userId);
    const v = validateSchedulerSettings({ batchSize: req.batchSize ?? s.batchSize, intervalMinutes: req.intervalMinutes ?? s.intervalMinutes, cycleDurationHours: req.durationHours ?? s.cycleDurationHours });
    if (!v.ok) throw new AppError('VALIDATION_FAILED', 'Invalid input.', v.errors.map((e) => ({ field: e.field === 'cycleDurationHours' ? 'durationHours' : e.field, message: e.message })));
    if (req.loopEnabled !== undefined && typeof req.loopEnabled !== 'boolean') throw new AppError('VALIDATION_FAILED', 'Invalid input.', [{ field: 'loopEnabled', message: 'Must be true or false.' }]);
    const acc = await this.accounts.get(userId, req.instagramAccountId);
    if (!acc) throw new AppError('NOT_FOUND', 'Instagram account not found.');
    if (acc.status === 'DISCONNECTED') throw new AppError('INSTAGRAM_NOT_CONNECTED', 'This account is disconnected.');
    if (acc.status !== 'CONNECTED') throw new AppError('INSTAGRAM_REAUTH_REQUIRED', 'Reconnect your Instagram account to continue.');
    const provider = this.providers.resolve(acc.provider);
    try {
      const el = await provider.checkEligibility(acc.id);
      if (!el.eligible) throw el.reason === 'TOKEN_EXPIRED' || el.reason === 'PERMISSION_MISSING' ? new AppError('INSTAGRAM_REAUTH_REQUIRED', el.message) : new AppError('INSTAGRAM_ACCOUNT_INELIGIBLE', el.message);
    } catch (e) { if (e instanceof AppError) throw e; throw mapProviderError(e); }
    if ((await this.store.countReadyVideos(userId)) === 0) throw new AppError('QUEUE_EMPTY', 'Upload at least one ready video before starting a cycle.');
    const r = await this.store.createCycle({ userId, accountId: acc.id, provider: acc.provider, batchSize: v.value.batchSize, intervalMinutes: v.value.intervalMinutes, loopEnabled: req.loopEnabled ?? s.loopEnabled, durationHours: v.value.cycleDurationHours, now: this.clock.now() });
    if (!r.ok) throw new AppError('CYCLE_ALREADY_ACTIVE', 'This account already has an active or paused cycle.');
    await this.queue.wakeCycle(r.cycle.id, r.cycle.nextBatchAt); // if Redis is down the sweeper still finds the cycle
    return this.read.cycleDto(r.cycle);
  }

  private async command(userId: string, id: string, cmd: 'PAUSE' | 'RESUME' | 'STOP'): Promise<CycleDto> {
    const now = this.clock.now();
    const r = await this.store.command(userId, id, cmd, now);
    if (!r.ok) {
      if (r.code === 'NOT_FOUND') throw new AppError('NOT_FOUND', 'Cycle not found.');
      throw new AppError(r.code === 'CYCLE_EXPIRED' ? 'CYCLE_EXPIRED' : 'CYCLE_NOT_ACTIVE', r.message);
    }
    if (cmd === 'RESUME') await this.queue.wakeCycle(r.cycle.id, r.cycle.nextBatchAt.getTime() > now.getTime() ? r.cycle.nextBatchAt : now);
    return this.read.cycleDto(r.cycle);
  }
  pause(userId: string, id: string) { return this.command(userId, id, 'PAUSE'); }
  resume(userId: string, id: string) { return this.command(userId, id, 'RESUME'); }
  stop(userId: string, id: string) { return this.command(userId, id, 'STOP'); }

  async setLoop(userId: string, id: string, loopEnabled: unknown): Promise<CycleDto> {
    if (typeof loopEnabled !== 'boolean') throw new AppError('VALIDATION_FAILED', 'Invalid input.', [{ field: 'loopEnabled', message: 'Must be true or false.' }]);
    const c = await this.store.getCycle(userId, id);
    if (!c) throw new AppError('NOT_FOUND', 'Cycle not found.');
    const updated = await this.store.setLoop(userId, id, loopEnabled);
    if (!updated) throw new AppError('CYCLE_NOT_ACTIVE', 'Only an active or paused cycle can be changed.');
    return this.read.cycleDto(updated);
  }

  async retryJob(userId: string, jobId: string): Promise<JobDto> {
    const r = await this.store.retryJob(userId, jobId, this.clock.now());
    if (!r.ok) throw new AppError(r.code === 'NOT_FOUND' ? 'NOT_FOUND' : r.code === 'CYCLE_NOT_ACTIVE' ? 'CYCLE_NOT_ACTIVE' : 'JOB_NOT_RETRYABLE', r.code === 'NOT_FOUND' ? 'Job not found.' : 'This job cannot be retried.');
    await this.queue.wakeJob(jobId, this.clock.now());
    return (await this.read.job(userId, jobId))!;
  }
}

/* ------------------------------------------------------------------------- upload flow (HTTP-contract shaped) */
export class UploadFlow {
  constructor(private readonly uploads: UploadService, private readonly query: QueryStore, private readonly videos: VideoStore, private readonly read: ReadService) {}

  async completeBatch(userId: string, batchId: string, req: { uploaded: readonly string[]; failed?: readonly string[] }): Promise<CompleteUploadResponse> {
    const batch = await this.query.getBatch(userId, batchId);
    if (!batch) throw new AppError('NOT_FOUND', 'Upload batch not found.');
    const inBatch = new Set(await this.query.batchVideoIds(userId, batchId));
    const failed = req.failed ?? [];
    for (const id of [...req.uploaded, ...failed]) if (!inBatch.has(id)) throw new AppError('VALIDATION_FAILED', 'Invalid input.', [{ field: 'uploaded', message: 'Unknown video id for this batch.' }]);
    for (const id of failed) await this.uploads.failClientUpload(userId, id);
    for (const id of req.uploaded) {
      try { await this.uploads.complete(userId, id); }
      catch (e) { if (!(e instanceof AppError && e.code === 'INVALID_STATE')) throw e; /* not uploaded yet / probe retry: stays pending, client may retry */ }
    }
    const rows: VideoRow[] = [];
    for (const id of inBatch) { const v = await this.videos.getVideo(userId, id); if (v) rows.push(v); }
    const fresh = (await this.query.getBatch(userId, batchId))!;
    return {
      batch: { id: fresh.id, status: fresh.status, declaredFiles: fresh.declaredFiles, completedFiles: fresh.completedFiles, failedFiles: fresh.failedFiles, expiresAt: fresh.expiresAt.toISOString() },
      videos: await this.read.videoDtos(userId, rows),
    };
  }
}

/* ------------------------------------------------------------------------- account lifecycle */
export class MeService {
  constructor(private readonly auth: AuthService, private readonly store: SchedulerStore, private readonly cycles: CycleService) {}

  /** Requires the password. Stops every live cycle first (so nothing publishes during the grace period), then starts the deletion clock. */
  async deleteAccount(userId: string, password: string): Promise<UserRow> {
    await this.auth.verifyPassword(userId, password);
    for (let i = 0; i < 20; i++) { // an account can hold several live cycles (one per Instagram account)
      const live = await this.store.getLiveCycle(userId);
      if (!live) break;
      await this.cycles.stop(userId, live.id);
    }
    return this.auth.requestDeletion(userId);
  }
}
