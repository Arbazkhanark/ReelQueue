import { toDate, toNum, type SqlExecutor } from './sql';

export interface PendingObject { videoId: string; storageKey: string }

/** System-level (no tenant argument): used only by the retention job, never reachable from an API request. */
export class RetentionStore {
  constructor(private readonly db: SqlExecutor) {}

  /** Users whose deletion grace period has elapsed (and who did not cancel). */
  async listUsersPastGrace(cutoff: Date, limit = 50): Promise<string[]> {
    const rows = await this.db.query(`SELECT id FROM users WHERE status = 'PENDING_DELETION' AND deletion_requested_at < $1 ORDER BY deletion_requested_at LIMIT $2`, [cutoff, limit]);
    return rows.map((r) => String(r.id));
  }
  /** Stored objects of a user that have not been removed from object storage yet. */
  async pendingObjects(userId: string, limit = 500): Promise<PendingObject[]> {
    const rows = await this.db.query(`SELECT id, storage_key FROM videos WHERE user_id = $1 AND storage_deleted_at IS NULL ORDER BY created_at LIMIT $2`, [userId, limit]);
    return rows.map((r) => ({ videoId: String(r.id), storageKey: String(r.storage_key) }));
  }
  /**
   * Irreversibly deletes the user and everything under them. Re-checks eligibility under a row lock (the user may have
   * cancelled meanwhile) and refuses while any object remains in storage (so no orphaned objects are left behind).
   * Jobs are deleted explicitly first: their FK to videos is RESTRICT and cascade order is not guaranteed.
   */
  async hardDeleteUser(userId: string, cutoff: Date): Promise<'DELETED' | 'NOT_ELIGIBLE' | 'OBJECTS_REMAIN' | 'LIVE_CYCLE'> {
    return this.db.transaction(async (tx) => {
      const u = (await tx.query(`SELECT status, deletion_requested_at FROM users WHERE id = $1 FOR UPDATE`, [userId]))[0];
      if (!u || u.status !== 'PENDING_DELETION' || u.deletion_requested_at === null || toDate(u.deletion_requested_at) >= cutoff) return 'NOT_ELIGIBLE' as const;
      if ((await tx.query(`SELECT 1 FROM publishing_cycles WHERE user_id = $1 AND status IN ('ACTIVE','PAUSED') LIMIT 1`, [userId]))[0]) return 'LIVE_CYCLE' as const;
      if ((await tx.query(`SELECT 1 FROM videos WHERE user_id = $1 AND storage_deleted_at IS NULL LIMIT 1`, [userId]))[0]) return 'OBJECTS_REMAIN' as const;
      await tx.exec(`DELETE FROM publish_jobs WHERE user_id = $1`, [userId]);
      await tx.exec(`DELETE FROM users WHERE id = $1`, [userId]);
      return 'DELETED' as const;
    });
  }
  async countUsers(): Promise<number> { return toNum((await this.db.query(`SELECT count(*) AS n FROM users`))[0]!.n); }
}
