import {
  buildStorageKey, storageLevel, validateMedia,
  type Clock, type MediaLimits, type MediaMetadata, type RejectedFile, type StorageProvider, type UploadFileSpec, type UploadLimits,
} from '@reelqueue/core';
import { VideoStore, type DeadObject, type VideoRow, type VideoStatus } from '@reelqueue/db';
import { AppError } from '@reelqueue/shared';

/** Media analysis port. Resolves null when the file has no video stream; REJECTS when the file cannot be read at all. */
export interface MediaProbe { probe(url: string): Promise<MediaMetadata | null> }
export interface ServiceLogger { warn(obj: Record<string, unknown>, msg: string): void }
const NOOP_LOG: ServiceLogger = { warn: () => undefined };

export interface UploadConfig {
  limits: UploadLimits;
  media: MediaLimits;
  /** Lifetime of presigned PUT URLs AND of the quota reservation. */
  ttlSeconds: number;
  probeUrlTtlSeconds: number;
  /** Probe failures tolerated (could be transient) before the file is rejected as unreadable. */
  maxProbeAttempts: number;
}
export const DEFAULT_UPLOAD_CONFIG: UploadConfig = {
  limits: { allowedContentTypes: ['video/mp4', 'video/quicktime'], maxFileBytes: 1024 ** 3, quotaBytes: 20 * 1024 ** 3, maxVideos: 500, maxBatchFiles: 200 },
  media: { minDurationSeconds: 3, maxDurationSeconds: 15 * 60 },
  ttlSeconds: 3600, probeUrlTtlSeconds: 300, maxProbeAttempts: 3,
};

export interface UploadTarget { index: number; videoId: string; filename: string; method: 'PUT'; url: string; headers: Record<string, string>; expiresAt: Date }
export interface CreateBatchResult { batchId: string | null; expiresAt: Date | null; uploads: UploadTarget[]; rejected: RejectedFile[] }
export interface CompleteResult { status: VideoStatus; reason: string | null; video: VideoRow }

const baseType = (ct: string | undefined): string | undefined => ct?.split(';')[0]?.trim().toLowerCase();

/**
 * Bulk-upload use-cases. Safety properties (all covered by tests on real PostgreSQL):
 *  - the quota reservation is made in the same transaction as the plan, so concurrent batches cannot oversubscribe;
 *  - `complete` is idempotent: every state change is a compare-and-set, so duplicates and races account once;
 *  - a video becomes READY only after: object exists, size == declared, content-type matches, media is readable and valid;
 *  - dead objects are deleted best-effort and retried by `cleanup` until confirmed.
 */
export class UploadService {
  constructor(
    private readonly store: VideoStore, private readonly storage: StorageProvider, private readonly media: MediaProbe,
    private readonly clock: Clock, private readonly cfg: UploadConfig = DEFAULT_UPLOAD_CONFIG, private readonly log: ServiceLogger = NOOP_LOG,
    /** Per-user limit overrides (e.g. from user_settings). Absent = the global config applies to everyone. */
    private readonly limitsFor?: (userId: string) => Promise<Partial<UploadLimits>>,
  ) {}

  private async limits(userId: string): Promise<UploadLimits> {
    return this.limitsFor ? { ...this.cfg.limits, ...(await this.limitsFor(userId)) } : this.cfg.limits;
  }

  async createBatch(userId: string, files: readonly UploadFileSpec[]): Promise<CreateBatchResult> {
    const now = this.clock.now();
    const r = await this.store.reserveBatch({ userId, files, limits: await this.limits(userId), now, ttlMs: this.cfg.ttlSeconds * 1000, newKey: buildStorageKey });
    if (!r.ok) throw new AppError(r.code, r.message);
    if (!r.batch) return { batchId: null, expiresAt: null, uploads: [], rejected: r.rejected };
    const uploads: UploadTarget[] = [];
    try {
      for (const it of r.items) {
        const p = await this.storage.presignUpload(it.storageKey, { contentType: it.contentType, expiresSeconds: this.cfg.ttlSeconds });
        uploads.push({ index: it.index, videoId: it.videoId, filename: it.filename, method: 'PUT', url: p.url, headers: p.headers, expiresAt: r.batch.expiresAt });
      }
    } catch (e) {
      // Do not leave a reservation behind for URLs the client will never receive.
      for (const it of r.items) await this.store.markDead(userId, it.videoId, 'PRESIGN_FAILED', 'FAILED');
      this.log.warn({ userId, err: (e as Error).message }, 'presign failed; batch released');
      throw new AppError('INTERNAL', 'Could not prepare the upload. Please try again.');
    }
    return { batchId: r.batch.id, expiresAt: r.batch.expiresAt, uploads, rejected: r.rejected };
  }

  async complete(userId: string, videoId: string): Promise<CompleteResult> {
    const v = await this.store.getVideo(userId, videoId); // tenant-scoped: another tenant's id is simply NOT_FOUND
    if (!v) throw new AppError('NOT_FOUND', 'Video not found.');
    if (v.status === 'READY' || v.status === 'REJECTED' || v.status === 'FAILED') return this.result(v); // idempotent, never resurrects

    const head = await this.storage.head(v.storageKey); // infrastructure errors propagate: state unchanged, safe to retry
    if (!head.exists) throw new AppError('INVALID_STATE', 'The file has not finished uploading. Retry once the upload completes.');
    if (head.sizeBytes !== v.sizeBytes) return this.reject(v, 'SIZE_MISMATCH');
    const ct = baseType(head.contentType);
    if (ct !== undefined && ct !== v.contentType) return this.reject(v, 'CONTENT_TYPE_MISMATCH');

    await this.store.markValidating(userId, videoId);
    let meta: MediaMetadata | null;
    try {
      meta = await this.media.probe(await this.storage.presignDownload(v.storageKey, { expiresSeconds: this.cfg.probeUrlTtlSeconds }));
    } catch {
      const attempts = await this.store.recordProbeFailure(userId, videoId);
      if (attempts >= this.cfg.maxProbeAttempts) return this.reject(v, 'UNREADABLE_MEDIA');
      throw new AppError('INVALID_STATE', 'The video could not be analysed yet. Please retry.');
    }
    const verdict = validateMedia(meta, this.cfg.media);
    if (!verdict.ok) return this.reject(v, verdict.code);

    const won = await this.store.finalizeReady(userId, videoId, { durationMs: meta!.durationMs, width: meta!.width, height: meta!.height });
    void won; // either we or a concurrent request made it READY; both report the stored truth
    const fresh = await this.store.getVideo(userId, videoId);
    if (!fresh) throw new AppError('NOT_FOUND', 'Video not found.');
    return this.result(fresh);
  }

  async deleteVideo(userId: string, videoId: string): Promise<void> {
    const r = await this.store.softDelete(userId, videoId, this.clock.now());
    if (!r.ok) throw new AppError(r.code === 'NOT_FOUND' ? 'NOT_FOUND' : 'VIDEO_IN_USE', r.code === 'NOT_FOUND' ? 'Video not found.' : 'This video is part of a scheduled or running publishing job.');
    await this.cleanup(); // removes the object now; failures are retried by later sweeps
  }

  async listVideos(userId: string, o: { status?: VideoStatus; limit?: number; offset?: number } = {}) {
    return this.store.listVideos(userId, { ...(o.status ? { status: o.status } : {}), limit: Math.min(200, Math.max(1, o.limit ?? 50)), offset: Math.max(0, o.offset ?? 0) });
  }

  async usage(userId: string) {
    const u = await this.store.getUsage(userId);
    const lim = await this.limits(userId);
    const { percentUsed, level } = storageLevel(u.bytesTotalHeld, lim.quotaBytes);
    return { usedBytes: u.bytesUsed, reservedBytes: u.bytesReserved, quotaBytes: lim.quotaBytes, videoCount: u.videoCount, maxVideos: lim.maxVideos, percentUsed, level };
  }

  async reorder(userId: string, orderedIds: readonly string[]): Promise<void> {
    const r = await this.store.reorder(userId, orderedIds);
    if (r.ok) return;
    if (r.code === 'CYCLE_ACTIVE') throw new AppError('INVALID_STATE', 'The order cannot be changed while a publishing cycle is active.');
    throw new AppError('VALIDATION_FAILED', 'The list must contain every ready video exactly once.');
  }

  /** Sweep: abandon expired batches and delete objects of dead videos. Safe to run concurrently and repeatedly. */
  async cleanup(): Promise<{ abandoned: number; purged: number; purgeFailures: number }> {
    const abandoned = await this.store.abandonExpired(this.clock.now());
    const dead = await this.store.listUnpurged();
    let purged = 0, purgeFailures = 0;
    for (const o of dead) (await this.purge(o)) ? purged++ : purgeFailures++;
    return { abandoned: abandoned.length, purged, purgeFailures };
  }

  private async reject(v: VideoRow, reason: string): Promise<CompleteResult> {
    await this.store.markDead(v.userId, v.id, reason, 'REJECTED'); // authoritative first; the object is removed best-effort afterwards
    await this.purge({ id: v.id, userId: v.userId, storageKey: v.storageKey });
    const fresh = await this.store.getVideo(v.userId, v.id);
    return this.result(fresh ?? { ...v, status: 'REJECTED', rejectionReason: reason });
  }

  private async purge(o: DeadObject): Promise<boolean> {
    try {
      await this.storage.delete(o.storageKey);
      await this.store.markPurged(o.id, this.clock.now());
      return true;
    } catch (e) {
      this.log.warn({ videoId: o.id, err: (e as Error).message }, 'object deletion failed; will be retried by cleanup');
      return false;
    }
  }

  private result(v: VideoRow): CompleteResult { return { status: v.status, reason: v.rejectionReason, video: v }; }
}
