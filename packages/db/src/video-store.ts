//packages/db/src/video-store.ts
import { randomUUID } from 'node:crypto';
import { planUpload, type RejectedFile, type UploadFileSpec, type UploadLimits, type UploadPlan, type UploadUsage } from '@reelqueue/core';
import { toDate, toNum, toStrOrNull, type Row, type SqlExecutor } from './sql';

export type VideoStatus = 'PENDING_UPLOAD' | 'VALIDATING' | 'READY' | 'REJECTED' | 'FAILED';

export interface VideoRow {
  id: string; userId: string; batchId: string | null; filename: string; storageKey: string; contentType: string; sizeBytes: number;
  durationMs: number | null; width: number | null; height: number | null; status: VideoStatus; rejectionReason: string | null;
  // caption: string | null; position: number; validationAttempts: number; createdAt: Date;
  caption: string | null; position: number; validationAttempts: number; createdAt: Date;
  sourceType: 'S3' | 'GOOGLE_DRIVE'; googleDriveFileId: string | null;
}
const COLS = `id, user_id, upload_batch_id, original_filename, storage_key, content_type, size_bytes, duration_ms, width, height,
  status, rejection_reason, caption, position, validation_attempts, created_at, source_type, google_drive_file_id`;
  // status, rejection_reason, caption, position, validation_attempts, created_at`;
const mapVideo = (r: Row): VideoRow => ({
  id: String(r.id), userId: String(r.user_id), batchId: toStrOrNull(r.upload_batch_id), filename: String(r.original_filename),
  storageKey: String(r.storage_key), contentType: String(r.content_type), sizeBytes: toNum(r.size_bytes),
  durationMs: r.duration_ms == null ? null : toNum(r.duration_ms), width: r.width == null ? null : toNum(r.width),
  height: r.height == null ? null : toNum(r.height), status: r.status as VideoStatus, rejectionReason: toStrOrNull(r.rejection_reason),
  // caption: toStrOrNull(r.caption), position: toNum(r.position), validationAttempts: toNum(r.validation_attempts), createdAt: toDate(r.created_at),
    caption: toStrOrNull(r.caption), position: toNum(r.position), validationAttempts: toNum(r.validation_attempts), createdAt: toDate(r.created_at),
    sourceType: r.source_type === 'GOOGLE_DRIVE' ? 'GOOGLE_DRIVE' : 'S3', googleDriveFileId: toStrOrNull(r.google_drive_file_id),
});

export interface ReservedItem { index: number; videoId: string; storageKey: string; contentType: string; sizeBytes: number; filename: string }
export type ReserveResult =
  | { ok: true; batch: { id: string; expiresAt: Date } | null; items: ReservedItem[]; rejected: RejectedFile[] }
  | Extract<UploadPlan, { ok: false }>;

export interface DeadObject { id: string; userId: string; storageKey: string }

/**
 * Persistence for the upload lifecycle. Quota accounting (storage_usage) is mutated ONLY here, under row locks:
 *   reserve  : bytes_reserved += size, video_count += 1
 *   ready    : bytes_reserved -= size, bytes_used += size
 *   reject / fail / abandon / delete-pending : bytes_reserved -= size, video_count -= 1
 *   delete-ready : bytes_used -= size, video_count -= 1
 * Every state change is a compare-and-set on the video status, so duplicate/concurrent requests move accounting at most once.
 * Every user-facing method takes userId and filters on it (tenant isolation); `abandonExpired` and `listUnpurged` are system sweeps.
 */
export class VideoStore {
  constructor(private readonly db: SqlExecutor) {}

  /** Plans (with the SAME core rules) and reserves in ONE transaction under the user's usage lock, so concurrent batches cannot oversubscribe. */
  async reserveBatch(a: { userId: string; files: readonly UploadFileSpec[]; limits: UploadLimits; now: Date; ttlMs: number; newKey: (userId: string, videoId: string, contentType: string) => string }): Promise<ReserveResult> {
    return this.db.transaction(async (tx) => {
      await tx.exec(`INSERT INTO storage_usage (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [a.userId]);
      const u = (await tx.query(`SELECT bytes_used, bytes_reserved, video_count FROM storage_usage WHERE user_id = $1 FOR UPDATE`, [a.userId]))[0]!;
      const usage: UploadUsage = { videoCount: toNum(u.video_count), bytesUsed: toNum(u.bytes_used), bytesReserved: toNum(u.bytes_reserved) };
      const plan = planUpload(a.files, a.limits, usage);
      if (!plan.ok) return plan;
      if (plan.accepted.length === 0) return { ok: true as const, batch: null, items: [], rejected: plan.rejected };

      const expiresAt = new Date(a.now.getTime() + a.ttlMs);
      const batch = (await tx.query(
        `INSERT INTO upload_batches (user_id, declared_files, declared_bytes, expires_at) VALUES ($1,$2,$3,$4) RETURNING id`,
        [a.userId, plan.accepted.length, plan.totalBytes, expiresAt]))[0]!;
      const batchId = String(batch.id);
      let pos = toNum((await tx.query(`SELECT COALESCE(MAX(position) + 1, 0) AS p FROM videos WHERE user_id = $1 AND deleted_at IS NULL`, [a.userId]))[0]!.p);
      const items: ReservedItem[] = [];
      for (const f of plan.accepted) {
        const videoId = randomUUID();
        const storageKey = a.newKey(a.userId, videoId, f.spec.contentType);
        await tx.exec(
          `INSERT INTO videos (id, user_id, upload_batch_id, original_filename, storage_key, content_type, size_bytes, position)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [videoId, a.userId, batchId, f.spec.filename, storageKey, f.spec.contentType.toLowerCase(), f.spec.sizeBytes, pos++]);
        items.push({ index: f.index, videoId, storageKey, contentType: f.spec.contentType.toLowerCase(), sizeBytes: f.spec.sizeBytes, filename: f.spec.filename });
      }
      await tx.exec(`UPDATE storage_usage SET bytes_reserved = bytes_reserved + $2, video_count = video_count + $3 WHERE user_id = $1`, [a.userId, plan.totalBytes, plan.accepted.length]);
      return { ok: true as const, batch: { id: batchId, expiresAt }, items, rejected: plan.rejected };
    });
  }

  /** System use (publish executor): the object key for a video that is still usable. Never expose through an API. */
  async getStorageKeyForPublishing(videoId: string): Promise<string | null> {
    const r = await this.db.query(`SELECT storage_key FROM videos WHERE id = $1 AND status = 'READY' AND deleted_at IS NULL`, [videoId]);
    return r[0] ? String(r[0].storage_key) : null;
  }

  
  /** System use (media route, publish executor): where the bytes of a still-usable video live. Never expose through an API. */
  async getPublishingSource(videoId: string): Promise<{ userId: string; storageKey: string; sourceType: 'S3' | 'GOOGLE_DRIVE'; googleDriveFileId: string | null; contentType: string; sizeBytes: number } | null> {
    const r = (await this.db.query(
      `SELECT user_id, storage_key, source_type, google_drive_file_id, content_type, size_bytes FROM videos WHERE id = $1 AND status = 'READY' AND deleted_at IS NULL`, [videoId]))[0];
    return r ? { userId: String(r.user_id), storageKey: String(r.storage_key), sourceType: r.source_type === 'GOOGLE_DRIVE' ? 'GOOGLE_DRIVE' : 'S3', googleDriveFileId: toStrOrNull(r.google_drive_file_id), contentType: String(r.content_type), sizeBytes: toNum(r.size_bytes) } : null;
  }

  /**
   * A video whose bytes stay in Google Drive: checked against the same quota/limit rules, then created READY in one
   * transaction under the user's usage lock. `storage_deleted_at` is set at once because there is no object of ours to delete.
   */
  async createExternalReady(a: { userId: string; driveFileId: string; filename: string; contentType: string; sizeBytes: number; durationMs: number; width: number; height: number; limits: UploadLimits }):
    Promise<{ ok: true; video: VideoRow } | Extract<UploadPlan, { ok: false }> | { ok: false; code: 'CONFLICT' | 'VALIDATION_FAILED'; message: string }> {
    return this.db.transaction(async (tx) => {
      await tx.exec(`INSERT INTO storage_usage (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [a.userId]);
      const u = (await tx.query(`SELECT bytes_used, bytes_reserved, video_count FROM storage_usage WHERE user_id = $1 FOR UPDATE`, [a.userId]))[0]!;
      const usage: UploadUsage = { videoCount: toNum(u.video_count), bytesUsed: toNum(u.bytes_used), bytesReserved: toNum(u.bytes_reserved) };
      const dup = await tx.query(`SELECT 1 FROM videos WHERE user_id = $1 AND source_type = 'GOOGLE_DRIVE' AND google_drive_file_id = $2 AND deleted_at IS NULL LIMIT 1`, [a.userId, a.driveFileId]);
      if (dup[0]) return { ok: false as const, code: 'CONFLICT' as const, message: 'This Google Drive file is already imported.' };
      const plan = planUpload([{ filename: a.filename, contentType: a.contentType, sizeBytes: a.sizeBytes }], a.limits, usage);
      if (!plan.ok) return plan;
      if (plan.accepted.length === 0) return { ok: false as const, code: 'VALIDATION_FAILED' as const, message: plan.rejected[0]?.message ?? 'The video cannot be imported.' };
      const videoId = randomUUID();
      const pos = toNum((await tx.query(`SELECT COALESCE(MAX(position) + 1, 0) AS p FROM videos WHERE user_id = $1 AND deleted_at IS NULL`, [a.userId]))[0]!.p);
      await tx.exec(
        `INSERT INTO videos (id, user_id, original_filename, storage_key, content_type, size_bytes, duration_ms, width, height, status, position, source_type, google_drive_file_id, storage_deleted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'READY',$10,'GOOGLE_DRIVE',$11,now())`,
        [videoId, a.userId, a.filename, `gdrive/${a.userId}/${videoId}`, a.contentType.toLowerCase(), a.sizeBytes, Math.max(1, Math.round(a.durationMs)), a.width, a.height, pos, a.driveFileId]);
      await tx.exec(`UPDATE storage_usage SET bytes_used = bytes_used + $2, video_count = video_count + 1 WHERE user_id = $1`, [a.userId, a.sizeBytes]);
      const row = (await tx.query(`SELECT ${COLS} FROM videos WHERE id = $1`, [videoId]))[0]!;
      return { ok: true as const, video: mapVideo(row) };
    });
  }

  async getVideo(userId: string, videoId: string): Promise<VideoRow | null> {
    const rows = await this.db.query(`SELECT ${COLS} FROM videos WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL`, [videoId, userId]);
    return rows[0] ? mapVideo(rows[0]) : null;
  }

  async listVideos(userId: string, o: { status?: VideoStatus; limit: number; offset: number }): Promise<{ items: VideoRow[]; total: number }> {
    const where = `user_id = $1 AND deleted_at IS NULL${o.status ? ` AND status = $4` : ''}`;
    const params: unknown[] = o.status ? [userId, o.limit, o.offset, o.status] : [userId, o.limit, o.offset];
    const rows = await this.db.query(`SELECT ${COLS} FROM videos WHERE ${where} ORDER BY position, id LIMIT $2 OFFSET $3`, params);
    const total = await this.db.query(`SELECT count(*) AS c FROM videos WHERE ${where.replace('$4', '$2')}`, o.status ? [userId, o.status] : [userId]);
    return { items: rows.map(mapVideo), total: toNum(total[0]!.c) };
  }

  async getUsage(userId: string): Promise<UploadUsage & { bytesTotalHeld: number }> {
    const r = (await this.db.query(`SELECT bytes_used, bytes_reserved, video_count FROM storage_usage WHERE user_id = $1`, [userId]))[0];
    const usage = { videoCount: r ? toNum(r.video_count) : 0, bytesUsed: r ? toNum(r.bytes_used) : 0, bytesReserved: r ? toNum(r.bytes_reserved) : 0 };
    return { ...usage, bytesTotalHeld: usage.bytesUsed + usage.bytesReserved };
  }

  async updateCaption(userId: string, videoId: string, caption: string | null): Promise<VideoRow | null> {
    const rows = await this.db.query(`UPDATE videos SET caption = $3 WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL RETURNING ${COLS}`, [videoId, userId, caption]);
    return rows[0] ? mapVideo(rows[0]) : null;
  }

  /** Informational (UI shows "validating"); completion does not depend on it, so a crash after it loses nothing. */
  async markValidating(userId: string, videoId: string): Promise<void> {
    await this.db.exec(`UPDATE videos SET status = 'VALIDATING' WHERE id = $1 AND user_id = $2 AND status = 'PENDING_UPLOAD'`, [videoId, userId]);
  }

  async recordProbeFailure(userId: string, videoId: string): Promise<number> {
    const rows = await this.db.query(
      `UPDATE videos SET validation_attempts = validation_attempts + 1 WHERE id = $1 AND user_id = $2 AND status IN ('PENDING_UPLOAD','VALIDATING') RETURNING validation_attempts`, [videoId, userId]);
    return rows[0] ? toNum(rows[0].validation_attempts) : 0;
  }

  /** CAS PENDING/VALIDATING -> READY. Returns false when another request already decided this video. */
  async finalizeReady(userId: string, videoId: string, meta: { durationMs: number; width: number; height: number }): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query(
        `UPDATE videos SET status = 'READY', duration_ms = $3, width = $4, height = $5, rejection_reason = NULL
         WHERE id = $1 AND user_id = $2 AND status IN ('PENDING_UPLOAD','VALIDATING') AND deleted_at IS NULL
         RETURNING size_bytes, upload_batch_id`, [videoId, userId, Math.max(1, Math.round(meta.durationMs)), meta.width, meta.height]);
      if (!rows[0]) return false;
      const size = toNum(rows[0].size_bytes);
      await tx.exec(`UPDATE storage_usage SET bytes_reserved = GREATEST(0, bytes_reserved - $2), bytes_used = bytes_used + $2 WHERE user_id = $1`, [userId, size]);
      await this.bumpBatch(tx, userId, toStrOrNull(rows[0].upload_batch_id), 'completed_files');
      return true;
    });
  }

  /** CAS PENDING/VALIDATING -> REJECTED|FAILED, releasing the reservation. Returns false if already decided. */
  async markDead(userId: string, videoId: string, reason: string, status: 'REJECTED' | 'FAILED' = 'REJECTED'): Promise<boolean> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query(
        `UPDATE videos SET status = $3, rejection_reason = $4
         WHERE id = $1 AND user_id = $2 AND status IN ('PENDING_UPLOAD','VALIDATING') AND deleted_at IS NULL
         RETURNING size_bytes, upload_batch_id`, [videoId, userId, status, reason]);
      if (!rows[0]) return false;
      await this.releaseReservation(tx, userId, toNum(rows[0].size_bytes), 1);
      await this.bumpBatch(tx, userId, toStrOrNull(rows[0].upload_batch_id), 'failed_files');
      return true;
    });
  }

  /** Marks leftovers of expired OPEN batches FAILED(UPLOAD_ABANDONED) and returns their objects for deletion. System sweep (all tenants). */
  async abandonExpired(now: Date, limit = 50): Promise<DeadObject[]> {
    const due = await this.db.query(`SELECT id, user_id FROM upload_batches WHERE status = 'OPEN' AND expires_at <= $1 ORDER BY expires_at LIMIT $2`, [now, limit]);
    const dead: DeadObject[] = [];
    for (const b of due) {
      await this.db.transaction(async (tx) => {
        const locked = await tx.query(`SELECT id FROM upload_batches WHERE id = $1 AND status = 'OPEN' AND expires_at <= $2 FOR UPDATE`, [String(b.id), now]);
        if (!locked[0]) return;
        const vids = await tx.query(
          `UPDATE videos SET status = 'FAILED', rejection_reason = 'UPLOAD_ABANDONED'
           WHERE upload_batch_id = $1 AND user_id = $2 AND status IN ('PENDING_UPLOAD','VALIDATING') AND deleted_at IS NULL
           RETURNING id, storage_key, size_bytes`, [String(b.id), String(b.user_id)]);
        const bytes = vids.reduce((n, v) => n + toNum(v.size_bytes), 0);
        if (vids.length) await this.releaseReservation(tx, String(b.user_id), bytes, vids.length);
        await tx.exec(`UPDATE upload_batches SET status = 'ABANDONED', failed_files = failed_files + $2 WHERE id = $1`, [String(b.id), vids.length]);
        for (const v of vids) dead.push({ id: String(v.id), userId: String(b.user_id), storageKey: String(v.storage_key) });
      });
    }
    return dead;
  }

  /** Objects of REJECTED/FAILED/deleted videos not yet removed from storage (retried until markPurged). System sweep. */
  async listUnpurged(limit = 100): Promise<DeadObject[]> {
    const rows = await this.db.query(
      `SELECT id, user_id, storage_key FROM videos WHERE storage_deleted_at IS NULL AND (status IN ('REJECTED','FAILED') OR deleted_at IS NOT NULL) ORDER BY updated_at LIMIT $1`, [limit]);
    return rows.map((r) => ({ id: String(r.id), userId: String(r.user_id), storageKey: String(r.storage_key) }));
  }
  async markPurged(videoId: string, now: Date): Promise<void> {
    await this.db.exec(`UPDATE videos SET storage_deleted_at = $2 WHERE id = $1 AND storage_deleted_at IS NULL`, [videoId, now]);
  }

  /**
   * Retention: soft-deleted videos older than `cutoff` whose object is already gone get their personal data removed.
   * No job references it -> the row is deleted; publishing history references it -> the row stays (history integrity) but the
   * filename/caption are scrubbed and `purged_at` is set. Idempotent; safe to run concurrently (rows are locked SKIP LOCKED).
   */
  async purgeSoftDeleted(cutoff: Date, now: Date, limit = 200): Promise<{ deleted: number; scrubbed: number }> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query(
        `SELECT v.id, EXISTS (SELECT 1 FROM publish_jobs j WHERE j.video_id = v.id) AS referenced FROM videos v
          WHERE v.deleted_at IS NOT NULL AND v.deleted_at < $1 AND v.storage_deleted_at IS NOT NULL AND v.purged_at IS NULL
          ORDER BY v.deleted_at LIMIT $2 FOR UPDATE OF v SKIP LOCKED`, [cutoff, limit]);
      let deleted = 0, scrubbed = 0;
      for (const r of rows) {
        if (r.referenced) { await tx.exec(`UPDATE videos SET original_filename = '[deleted video]', caption = NULL, purged_at = $2 WHERE id = $1`, [r.id, now]); scrubbed++; }
        else { await tx.exec(`DELETE FROM videos WHERE id = $1`, [r.id]); deleted++; }
      }
      return { deleted, scrubbed };
    });
  }

  /** Soft delete. Refused while a live publishing job references the video. */
  async softDelete(userId: string, videoId: string, now: Date): Promise<{ ok: true; storageKey: string } | { ok: false; code: 'NOT_FOUND' | 'VIDEO_IN_USE' }> {
    return this.db.transaction(async (tx) => {
      const v = (await tx.query(`SELECT status, size_bytes, storage_key, upload_batch_id FROM videos WHERE id = $1 AND user_id = $2 AND deleted_at IS NULL FOR UPDATE`, [videoId, userId]))[0];
      if (!v) return { ok: false as const, code: 'NOT_FOUND' as const };
      const busy = await tx.query(
        `SELECT 1 FROM publish_jobs WHERE video_id = $1 AND user_id = $2
           AND status IN ('SCHEDULED','DEFERRED','RETRY_WAIT','CREATING_CONTAINER','PROCESSING_MEDIA','PUBLISH_REQUESTED') LIMIT 1`, [videoId, userId]);
      if (busy[0]) return { ok: false as const, code: 'VIDEO_IN_USE' as const };
      const size = toNum(v.size_bytes);
      if (v.status === 'READY') {
        await tx.exec(`UPDATE storage_usage SET bytes_used = GREATEST(0, bytes_used - $2), video_count = GREATEST(0, video_count - 1) WHERE user_id = $1`, [userId, size]);
        await tx.exec(`UPDATE videos SET deleted_at = $2 WHERE id = $1`, [videoId, now]);
      } else if (v.status === 'PENDING_UPLOAD' || v.status === 'VALIDATING') {
        await this.releaseReservation(tx, userId, size, 1);
        await this.bumpBatch(tx, userId, toStrOrNull(v.upload_batch_id), 'failed_files');
        await tx.exec(`UPDATE videos SET deleted_at = $2, status = 'FAILED', rejection_reason = 'DELETED_BY_USER' WHERE id = $1`, [videoId, now]);
      } else {
        await tx.exec(`UPDATE videos SET deleted_at = $2 WHERE id = $1`, [videoId, now]);
      }
      return { ok: true as const, storageKey: String(v.storage_key) };
    });
  }

  /** Sets the publishing order of ALL ready videos. Refused while a cycle is live (the cursor is position-based). */
  async reorder(userId: string, orderedIds: readonly string[]): Promise<{ ok: true } | { ok: false; code: 'REORDER_MISMATCH' | 'CYCLE_ACTIVE' }> {
    return this.db.transaction(async (tx) => {
      const live = await tx.query(`SELECT 1 FROM publishing_cycles WHERE user_id = $1 AND status IN ('ACTIVE','PAUSED') LIMIT 1`, [userId]);
      if (live[0]) return { ok: false as const, code: 'CYCLE_ACTIVE' as const };
      const ready = await tx.query(`SELECT id FROM videos WHERE user_id = $1 AND status = 'READY' AND deleted_at IS NULL ORDER BY id FOR UPDATE`, [userId]);
      const have = new Set(ready.map((r) => String(r.id)));
      if (orderedIds.length !== have.size || new Set(orderedIds).size !== orderedIds.length || orderedIds.some((id) => !have.has(id))) {
        return { ok: false as const, code: 'REORDER_MISMATCH' as const };
      }
      await tx.exec(
        `UPDATE videos v SET position = t.ord - 1 FROM unnest($2::text[]) WITH ORDINALITY AS t(id, ord) WHERE v.id = t.id::uuid AND v.user_id = $1`, [userId, [...orderedIds]]);
      return { ok: true as const };
    });
  }

  private async releaseReservation(tx: SqlExecutor, userId: string, bytes: number, count: number): Promise<void> {
    await tx.exec(`UPDATE storage_usage SET bytes_reserved = GREATEST(0, bytes_reserved - $2), video_count = GREATEST(0, video_count - $3) WHERE user_id = $1`, [userId, bytes, count]);
  }

  private async bumpBatch(tx: SqlExecutor, userId: string, batchId: string | null, col: 'completed_files' | 'failed_files'): Promise<void> {
    if (!batchId) return;
    await tx.exec(`UPDATE upload_batches SET ${col} = ${col} + 1 WHERE id = $1 AND user_id = $2`, [batchId, userId]);
    await tx.exec(`UPDATE upload_batches SET status = 'COMPLETED' WHERE id = $1 AND user_id = $2 AND status = 'OPEN' AND completed_files + failed_files >= declared_files`, [batchId, userId]);
  }
}
