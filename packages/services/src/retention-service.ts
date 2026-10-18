import type { Clock, StorageProvider } from '@reelqueue/core';
import type { RetentionStore, VideoStore } from '@reelqueue/db';
import type { ServiceLogger } from './upload-service';

export interface RetentionConfig {
  /** Soft-deleted videos are hard-deleted / scrubbed this long after deletion. */
  videoRetentionDays: number;
  /** A PENDING_DELETION account is hard-deleted this long after the request. */
  accountGraceDays: number;
}
export const DEFAULT_RETENTION_CONFIG: RetentionConfig = { videoRetentionDays: 30, accountGraceDays: 14 };
const DAY = 86_400_000;

export interface RetentionReport { videosDeleted: number; videosScrubbed: number; usersDeleted: number; usersDeferred: number }

/**
 * Hard-delete retention. Idempotent and safe to run concurrently in every worker: each step re-checks eligibility under
 * row locks. Objects are removed from storage BEFORE rows are deleted; if storage fails, the row stays and the next run retries.
 */
export class RetentionService {
  constructor(
    private readonly retention: RetentionStore, private readonly videos: VideoStore, private readonly storage: Pick<StorageProvider, 'delete'>,
    private readonly clock: Clock, private readonly cfg: RetentionConfig = DEFAULT_RETENTION_CONFIG, private readonly log: ServiceLogger = { warn: () => undefined },
  ) {}

  async run(): Promise<RetentionReport> {
    const now = this.clock.now();
    const report: RetentionReport = { videosDeleted: 0, videosScrubbed: 0, usersDeleted: 0, usersDeferred: 0 };

    const v = await this.videos.purgeSoftDeleted(new Date(now.getTime() - this.cfg.videoRetentionDays * DAY), now);
    report.videosDeleted = v.deleted; report.videosScrubbed = v.scrubbed;

    const cutoff = new Date(now.getTime() - this.cfg.accountGraceDays * DAY);
    for (const userId of await this.retention.listUsersPastGrace(cutoff)) {
      let allGone = true;
      for (let guard = 0; guard < 20; guard++) { // bounded: at most 20 pages of 500 objects per user per run
        const objects = await this.retention.pendingObjects(userId);
        if (objects.length === 0) break;
        for (const o of objects) {
          try { await this.storage.delete(o.storageKey); await this.videos.markPurged(o.videoId, now); }
          catch { allGone = false; this.log.warn({ userId, videoId: o.videoId }, 'retention: object delete failed; will retry'); }
        }
        if (!allGone) break;
      }
      const r = allGone ? await this.retention.hardDeleteUser(userId, cutoff) : 'OBJECTS_REMAIN';
      if (r === 'DELETED') report.usersDeleted++; else report.usersDeferred++;
    }
    return report;
  }
}
