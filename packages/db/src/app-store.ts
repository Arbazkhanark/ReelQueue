import { toDate, toDateOrNull, toNum, toStrOrNull, type Row, type SqlExecutor } from './sql';

/* ------------------------------------------------------------------ settings */
export interface SettingsRow {
  timezone: string; batchSize: number; intervalMinutes: number; cycleDurationHours: number; loopEnabled: boolean;
  defaultInstagramAccountId: string | null; storageQuotaBytes: number; maxVideos: number; maxUploadBatch: number;
}
const mapSettings = (r: Row): SettingsRow => ({
  timezone: String(r.timezone), batchSize: toNum(r.batch_size), intervalMinutes: toNum(r.interval_minutes),
  cycleDurationHours: toNum(r.cycle_duration_hours), loopEnabled: Boolean(r.loop_enabled),
  defaultInstagramAccountId: toStrOrNull(r.default_instagram_account_id), storageQuotaBytes: toNum(r.storage_quota_bytes),
  maxVideos: toNum(r.max_videos), maxUploadBatch: toNum(r.max_upload_batch),
});

export class SettingsStore {
  constructor(private readonly db: SqlExecutor) {}
  /** Creates the default row on first use. */
  async get(userId: string): Promise<SettingsRow> {
    await this.db.exec(`INSERT INTO user_settings (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
    return mapSettings((await this.db.query(`SELECT * FROM user_settings WHERE user_id = $1`, [userId]))[0]!);
  }
  /** Values are validated by the caller (core rules); the DB CHECKs are the backstop. */
  async update(userId: string, p: Partial<Pick<SettingsRow, 'timezone' | 'batchSize' | 'intervalMinutes' | 'cycleDurationHours' | 'loopEnabled' | 'defaultInstagramAccountId'>>): Promise<SettingsRow> {
    await this.get(userId);
    const map: [keyof typeof p, string][] = [['timezone', 'timezone'], ['batchSize', 'batch_size'], ['intervalMinutes', 'interval_minutes'], ['cycleDurationHours', 'cycle_duration_hours'], ['loopEnabled', 'loop_enabled'], ['defaultInstagramAccountId', 'default_instagram_account_id']];
    const sets: string[] = []; const params: unknown[] = [userId];
    for (const [k, col] of map) if (p[k] !== undefined) { params.push(p[k]); sets.push(`${col} = $${params.length}`); }
    if (sets.length) await this.db.exec(`UPDATE user_settings SET ${sets.join(', ')} WHERE user_id = $1`, params);
    return this.get(userId);
  }
}

/* ------------------------------------------------------------------ accounts */
export interface AccountRow {
  id: string; userId: string; provider: 'META' | 'MOCK'; providerAccountId: string; username: string | null; accountType: string | null;
  status: 'CONNECTED' | 'REAUTH_REQUIRED' | 'PERMISSION_REVOKED' | 'DISCONNECTED'; tokenExpiresAt: Date | null;
  quota: { used: number; total: number; windowSeconds: number; fetchedAt: Date } | null; lastErrorCode: string | null; createdAt: Date;
}
const ACC_COLS = `id, user_id, provider, provider_account_id, username, account_type, status, token_expires_at, last_quota_used, last_quota_total,
  last_quota_window_seconds, last_quota_fetched_at, last_error_code, created_at`;
const mapAccount = (r: Row): AccountRow => ({
  id: String(r.id), userId: String(r.user_id), provider: r.provider as AccountRow['provider'], providerAccountId: String(r.provider_account_id),
  username: toStrOrNull(r.username), accountType: toStrOrNull(r.account_type), status: r.status as AccountRow['status'],
  tokenExpiresAt: toDateOrNull(r.token_expires_at),
  quota: r.last_quota_used == null || r.last_quota_total == null || r.last_quota_fetched_at == null ? null
    : { used: toNum(r.last_quota_used), total: toNum(r.last_quota_total), windowSeconds: r.last_quota_window_seconds == null ? 0 : toNum(r.last_quota_window_seconds), fetchedAt: toDate(r.last_quota_fetched_at) },
  lastErrorCode: toStrOrNull(r.last_error_code), createdAt: toDate(r.created_at),
});

export class AccountStore {
  constructor(private readonly db: SqlExecutor) {}
  async list(userId: string): Promise<AccountRow[]> {
    return (await this.db.query(`SELECT ${ACC_COLS} FROM instagram_accounts WHERE user_id = $1 AND status <> 'DISCONNECTED' ORDER BY created_at, id`, [userId])).map(mapAccount);
  }
  async get(userId: string, id: string): Promise<AccountRow | null> {
    const r = await this.db.query(`SELECT ${ACC_COLS} FROM instagram_accounts WHERE id = $1 AND user_id = $2`, [id, userId]);
    return r[0] ? mapAccount(r[0]) : null;
  }
  /** Dev/test only (caller enforces MOCK mode). The provider id is `mock_*` (DB CHECK) so it can never collide with a real IG id. */
  async createMock(userId: string, username: string, tokenPlaceholder: string): Promise<AccountRow> {
    const rows = await this.db.query(
      `INSERT INTO instagram_accounts (user_id, provider, provider_account_id, username, account_type, access_token_enc)
       VALUES ($1, 'MOCK', $2, $3, 'MOCK', $4) RETURNING ${ACC_COLS}`,
      [userId, `mock_${userId.slice(0, 8)}_${username.toLowerCase()}_${Date.now().toString(36)}`, username, tokenPlaceholder]);
    return mapAccount(rows[0]!);
  }
  async disconnect(userId: string, id: string, now: Date): Promise<{ ok: true; account: AccountRow } | { ok: false; code: 'NOT_FOUND' | 'CYCLE_ACTIVE' }> {
    return this.db.transaction(async (tx) => {
      const acc = await tx.query(`SELECT id FROM instagram_accounts WHERE id = $1 AND user_id = $2 FOR UPDATE`, [id, userId]);
      if (!acc[0]) return { ok: false as const, code: 'NOT_FOUND' as const };
      const live = await tx.query(`SELECT 1 FROM publishing_cycles WHERE instagram_account_id = $1 AND status IN ('ACTIVE','PAUSED') LIMIT 1`, [id]);
      if (live[0]) return { ok: false as const, code: 'CYCLE_ACTIVE' as const };
      const r = await tx.query(`UPDATE instagram_accounts SET status = 'DISCONNECTED', access_token_enc = NULL, disconnected_at = $3 WHERE id = $1 AND user_id = $2 RETURNING ${ACC_COLS}`, [id, userId, now]);
      return { ok: true as const, account: mapAccount(r[0]!) };
    });
  }
}

/* ------------------------------------------------------------------ read models */
export interface CycleCounts { queued: number; pending: number; published: number; simulated: number; failed: number; cancelled: number; expired: number }
export interface JobView {
  id: string; cycleId: string; videoId: string; videoFilename: string | null; sequenceNo: number; iteration: number; status: string; provider: 'META' | 'MOCK';
  nextAttemptAt: Date; attemptCount: number; deferredReason: string | null; failureReason: string | null; lastErrorCode: string | null; retryable: boolean;
  permalink: string | null; createdAt: Date; updatedAt: Date;
}
const mapJobView = (r: Row): JobView => ({
  id: String(r.id), cycleId: String(r.cycle_id), videoId: String(r.video_id), videoFilename: toStrOrNull(r.original_filename), sequenceNo: toNum(r.sequence_no),
  iteration: toNum(r.iteration), status: String(r.status), provider: r.provider as 'META' | 'MOCK', nextAttemptAt: toDate(r.next_attempt_at),
  attemptCount: toNum(r.attempt_count), deferredReason: toStrOrNull(r.deferred_reason), failureReason: toStrOrNull(r.failure_reason),
  lastErrorCode: toStrOrNull(r.last_error_code), retryable: Boolean(r.retryable), permalink: toStrOrNull(r.permalink),
  createdAt: toDate(r.created_at), updatedAt: toDate(r.updated_at),
});
const JOB_SELECT = `SELECT j.id, j.cycle_id, j.video_id, v.original_filename, j.sequence_no, j.iteration, j.status, j.provider, j.next_attempt_at, j.attempt_count,
  j.deferred_reason, j.failure_reason, j.last_error_code, j.retryable, j.permalink, j.created_at, j.updated_at
  FROM publish_jobs j JOIN videos v ON v.id = j.video_id AND v.user_id = j.user_id`;
const PENDING = `'SCHEDULED','DEFERRED','RETRY_WAIT','CREATING_CONTAINER','PROCESSING_MEDIA','PUBLISH_REQUESTED'`;

/** Tenant-scoped read models for the dashboard. Every method filters on userId. */
export class QueryStore {
  constructor(private readonly db: SqlExecutor) {}

  async cycleCounts(userId: string, cycleId: string, cursorLastPosition: number): Promise<CycleCounts> {
    const r = (await this.db.query(
      `SELECT count(*) FILTER (WHERE status IN (${PENDING})) AS pending, count(*) FILTER (WHERE status IN ('ACCEPTED','CONFIRMED')) AS published,
              count(*) FILTER (WHERE status = 'SIMULATED') AS simulated, count(*) FILTER (WHERE status = 'FAILED') AS failed,
              count(*) FILTER (WHERE status = 'CANCELLED') AS cancelled, count(*) FILTER (WHERE status = 'EXPIRED') AS expired
         FROM publish_jobs WHERE cycle_id = $1 AND user_id = $2`, [cycleId, userId]))[0]!;
    const q = (await this.db.query(`SELECT count(*) AS n FROM videos WHERE user_id = $1 AND status = 'READY' AND deleted_at IS NULL AND position > $2`, [userId, cursorLastPosition]))[0]!;
    return { queued: toNum(q.n), pending: toNum(r.pending), published: toNum(r.published), simulated: toNum(r.simulated), failed: toNum(r.failed), cancelled: toNum(r.cancelled), expired: toNum(r.expired) };
  }

  async listCycleIds(userId: string, limit: number, offset: number): Promise<{ ids: string[]; total: number }> {
    const rows = await this.db.query(`SELECT id FROM publishing_cycles WHERE user_id = $1 ORDER BY started_at DESC, id LIMIT $2 OFFSET $3`, [userId, limit, offset]);
    const t = await this.db.query(`SELECT count(*) AS n FROM publishing_cycles WHERE user_id = $1`, [userId]);
    return { ids: rows.map((r) => String(r.id)), total: toNum(t[0]!.n) };
  }

  async listJobs(userId: string, f: { status?: string; cycleId?: string; from?: Date; to?: Date; limit: number; offset: number }): Promise<{ items: JobView[]; total: number }> {
    const where = ['j.user_id = $1']; const params: unknown[] = [userId];
    const add = (sql: string, v: unknown) => { params.push(v); where.push(sql.replace('?', `$${params.length}`)); };
    if (f.status) add('j.status = ?', f.status);
    if (f.cycleId) add('j.cycle_id = ?', f.cycleId);
    if (f.from) add('j.created_at >= ?', f.from);
    if (f.to) add('j.created_at <= ?', f.to);
    const w = where.join(' AND ');
    const total = await this.db.query(`SELECT count(*) AS n FROM publish_jobs j WHERE ${w}`, params);
    const rows = await this.db.query(`${JOB_SELECT} WHERE ${w} ORDER BY j.created_at DESC, j.sequence_no DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, f.limit, f.offset]);
    return { items: rows.map(mapJobView), total: toNum(total[0]!.n) };
  }

  async getJob(userId: string, jobId: string): Promise<JobView | null> {
    const rows = await this.db.query(`${JOB_SELECT} WHERE j.id = $1 AND j.user_id = $2`, [jobId, userId]);
    return rows[0] ? mapJobView(rows[0]) : null;
  }

  async upcomingJobs(userId: string, limit: number): Promise<JobView[]> {
    return (await this.db.query(`${JOB_SELECT} WHERE j.user_id = $1 AND j.status IN (${PENDING}) ORDER BY j.next_attempt_at, j.sequence_no LIMIT $2`, [userId, limit])).map(mapJobView);
  }

  async totals(userId: string): Promise<{ readyVideos: number; published: number; simulated: number; failed: number }> {
    const v = (await this.db.query(`SELECT count(*) AS n FROM videos WHERE user_id = $1 AND status = 'READY' AND deleted_at IS NULL`, [userId]))[0]!;
    const j = (await this.db.query(
      `SELECT count(*) FILTER (WHERE status IN ('ACCEPTED','CONFIRMED')) AS published, count(*) FILTER (WHERE status = 'SIMULATED') AS simulated,
              count(*) FILTER (WHERE status = 'FAILED') AS failed FROM publish_jobs WHERE user_id = $1`, [userId]))[0]!;
    return { readyVideos: toNum(v.n), published: toNum(j.published), simulated: toNum(j.simulated), failed: toNum(j.failed) };
  }

  /** inUse: a live job references the video. publishedCount: ACCEPTED/CONFIRMED/SIMULATED jobs for it. */
  async videoFlags(userId: string, videoIds: readonly string[]): Promise<Map<string, { inUse: boolean; publishedCount: number }>> {
    const out = new Map<string, { inUse: boolean; publishedCount: number }>(videoIds.map((id) => [id, { inUse: false, publishedCount: 0 }]));
    if (videoIds.length === 0) return out;
    const rows = await this.db.query(
      `SELECT video_id, count(*) FILTER (WHERE status IN (${PENDING})) AS live, count(*) FILTER (WHERE status IN ('ACCEPTED','CONFIRMED','SIMULATED')) AS done
         FROM publish_jobs WHERE user_id = $1 AND video_id = ANY($2::text[]::uuid[]) GROUP BY video_id`, [userId, [...videoIds]]);
    for (const r of rows) out.set(String(r.video_id), { inUse: toNum(r.live) > 0, publishedCount: toNum(r.done) });
    return out;
  }

  async getBatch(userId: string, batchId: string): Promise<{ id: string; status: 'OPEN' | 'COMPLETED' | 'ABANDONED'; declaredFiles: number; completedFiles: number; failedFiles: number; expiresAt: Date } | null> {
    const r = (await this.db.query(`SELECT id, status, declared_files, completed_files, failed_files, expires_at FROM upload_batches WHERE id = $1 AND user_id = $2`, [batchId, userId]))[0];
    return r ? { id: String(r.id), status: r.status as 'OPEN', declaredFiles: toNum(r.declared_files), completedFiles: toNum(r.completed_files), failedFiles: toNum(r.failed_files), expiresAt: toDate(r.expires_at) } : null;
  }

  async batchVideoIds(userId: string, batchId: string): Promise<string[]> {
    return (await this.db.query(`SELECT id FROM videos WHERE upload_batch_id = $1 AND user_id = $2 ORDER BY position, id`, [batchId, userId])).map((r) => String(r.id));
  }
}
