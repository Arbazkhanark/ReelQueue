import {
  JOB_STATUSES,
  LeaseLostError,
  TERMINAL_JOB_STATUSES,
  assertTransition,
  blocksLaterJobs,
  type AttemptEvent,
  type ClaimResult,
  type CycleState,
  type JobContext,
  type JobPatch,
  type JobStatus,
  type JobStore,
  type PauseReason,
  type ProviderKind,
  type PublishJobRecord,
} from '@reelqueue/core';
import { toDate, toDateOrNull, toNum, toStrOrNull, type Row, type SqlExecutor } from './sql';

const BLOCKING_STATUSES: string[] = JOB_STATUSES.filter((s) => blocksLaterJobs(s));
export const TERMINAL_STATUS_LIST: string[] = [...TERMINAL_JOB_STATUSES];

export function mapJob(r: Row): PublishJobRecord {
  return {
    id: String(r.id),
    cycleId: String(r.cycle_id),
    accountId: String(r.instagram_account_id),
    videoId: String(r.video_id),
    sequenceNo: toNum(r.sequence_no),
    iteration: toNum(r.iteration),
    idempotencyKey: String(r.idempotency_key),
    provider: String(r.provider) as ProviderKind,
    status: String(r.status) as JobStatus,
    attemptCount: toNum(r.attempt_count),
    nextAttemptAt: toDate(r.next_attempt_at),
    containerId: toStrOrNull(r.container_id),
    containerCreatedAt: toDateOrNull(r.container_created_at),
    publishRequestedAt: toDateOrNull(r.publish_requested_at),
    mediaId: toStrOrNull(r.media_id),
    permalink: toStrOrNull(r.permalink),
    confirmAttempts: toNum(r.confirm_attempts),
    leaseOwner: toStrOrNull(r.lease_owner),
    leaseExpiresAt: toDateOrNull(r.lease_expires_at),
    lastErrorKind: toStrOrNull(r.last_error_kind),
    lastErrorCode: toStrOrNull(r.last_error_code),
    failureReason: toStrOrNull(r.failure_reason),
    retryable: Boolean(r.retryable),
    deferredReason: toStrOrNull(r.deferred_reason),
    version: toNum(r.version),
    createdAt: toDate(r.created_at),
    updatedAt: toDate(r.updated_at),
  };
}

/** JobPatch key -> column. Anything not listed can never be written through the store. */
const PATCH_COLUMNS: Record<Exclude<keyof JobPatch, 'releaseLease'>, string> = {
  status: 'status',
  nextAttemptAt: 'next_attempt_at',
  containerId: 'container_id',
  containerCreatedAt: 'container_created_at',
  publishRequestedAt: 'publish_requested_at',
  mediaId: 'media_id',
  permalink: 'permalink',
  attemptCount: 'attempt_count',
  confirmAttempts: 'confirm_attempts',
  lastErrorKind: 'last_error_kind',
  lastErrorCode: 'last_error_code',
  failureReason: 'failure_reason',
  retryable: 'retryable',
  deferredReason: 'deferred_reason',
};

/**
 * PostgreSQL implementation of the executor's JobStore port.
 *
 * claim(): per-account advisory lock (serialises concurrent claimers of the same account) + row lock; then
 * checks, in order: terminal, due, leased, ACCOUNT_BUSY (another live lease on the account), OUT_OF_ORDER
 * (an earlier unresolved job of the account blocks this one). Only then is the lease written.
 * update(): compare-and-set on the lease; validates the status transition; throws LeaseLostError otherwise.
 */
export class PgJobStore implements JobStore {
  constructor(private readonly db: SqlExecutor) {}

  async claim(jobId: string, args: { workerId: string; now: Date; leaseMs: number }): Promise<ClaimResult> {
    const first = await this.db.query('SELECT instagram_account_id FROM publish_jobs WHERE id = $1', [jobId]);
    if (first.length === 0) return { claimed: false, reason: 'NOT_FOUND', retryAt: null };
    const accountId = String(first[0]!.instagram_account_id);

    return this.db.transaction(async (tx) => {
      await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0)) AS locked', [accountId]);
      const rows = await tx.query('SELECT * FROM publish_jobs WHERE id = $1 FOR UPDATE', [jobId]);
      const row = rows[0];
      if (!row) return { claimed: false, reason: 'NOT_FOUND', retryAt: null } as const;
      const job = mapJob(row);
      const now = args.now;

      if (TERMINAL_JOB_STATUSES.has(job.status)) return { claimed: false, reason: 'TERMINAL', retryAt: null } as const;
      if (job.nextAttemptAt.getTime() > now.getTime()) {
        return { claimed: false, reason: 'NOT_DUE', retryAt: job.nextAttemptAt } as const;
      }
      if (job.leaseOwner && job.leaseExpiresAt && job.leaseExpiresAt.getTime() > now.getTime()) {
        return { claimed: false, reason: 'LEASED', retryAt: job.leaseExpiresAt } as const;
      }

      const busy = await tx.query(
        `SELECT lease_expires_at FROM publish_jobs
          WHERE instagram_account_id = $1 AND id <> $2 AND lease_owner IS NOT NULL AND lease_expires_at > $3::timestamptz
          ORDER BY lease_expires_at LIMIT 1`,
        [accountId, jobId, now],
      );
      if (busy[0]) {
        return { claimed: false, reason: 'ACCOUNT_BUSY', retryAt: toDate(busy[0].lease_expires_at) } as const;
      }

      const blocked = await tx.query(
        `SELECT 1 AS blocked
           FROM publish_jobs o
           JOIN publishing_cycles oc ON oc.id = o.cycle_id
           JOIN publishing_cycles jc ON jc.id = $2
          WHERE o.instagram_account_id = $1 AND o.id <> $3 AND o.status = ANY($4::text[])
            AND ((o.cycle_id = $2 AND o.sequence_no < $5) OR (o.cycle_id <> $2 AND oc.started_at < jc.started_at))
          LIMIT 1`,
        [accountId, job.cycleId, jobId, BLOCKING_STATUSES, job.sequenceNo],
      );
      if (blocked[0]) return { claimed: false, reason: 'OUT_OF_ORDER', retryAt: null } as const;

      const leased = await tx.query(
        `UPDATE publish_jobs SET lease_owner = $2, lease_expires_at = $3::timestamptz, version = version + 1
          WHERE id = $1 RETURNING *`,
        [jobId, args.workerId, new Date(now.getTime() + args.leaseMs)],
      );
      return { claimed: true, job: mapJob(leased[0]!) } as const;
    });
  }

  async update(jobId: string, workerId: string, patch: JobPatch, now: Date): Promise<PublishJobRecord> {
    return this.db.transaction(async (tx) => {
      const cur = await tx.query('SELECT * FROM publish_jobs WHERE id = $1 FOR UPDATE', [jobId]);
      const row = cur[0];
      if (!row) throw new Error(`no job ${jobId}`);
      const job = mapJob(row);
      if (job.leaseOwner !== workerId || !job.leaseExpiresAt || job.leaseExpiresAt.getTime() <= now.getTime()) {
        throw new LeaseLostError(jobId);
      }
      if (patch.status) assertTransition(job.status, patch.status);

      const sets: string[] = [];
      const params: unknown[] = [jobId];
      for (const [key, column] of Object.entries(PATCH_COLUMNS)) {
        const value = (patch as Record<string, unknown>)[key];
        if (value === undefined) continue;
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      }
      if (patch.releaseLease) sets.push('lease_owner = NULL', 'lease_expires_at = NULL');
      sets.push('version = version + 1');
      params.push(now);
      sets.push(`updated_at = $${params.length}::timestamptz`);
      const updated = await tx.query(`UPDATE publish_jobs SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
      return mapJob(updated[0]!);
    });
  }

  async getCycleGuard(cycleId: string): Promise<CycleState | null> {
    const r = await this.db.query('SELECT status, started_at, ends_at FROM publishing_cycles WHERE id = $1', [cycleId]);
    const row = r[0];
    if (!row) return null;
    return { status: String(row.status) as CycleState['status'], startedAt: toDate(row.started_at), endsAt: toDate(row.ends_at) };
  }

  async getJobContext(jobId: string): Promise<JobContext> {
    const r = await this.db.query(
      `SELECT j.instagram_account_id, j.video_id, v.caption
         FROM publish_jobs j JOIN videos v ON v.id = j.video_id AND v.user_id = j.user_id WHERE j.id = $1`,
      [jobId],
    );
    const row = r[0];
    if (!row) throw new Error(`no job context for ${jobId}`);
    return { accountId: String(row.instagram_account_id), videoId: String(row.video_id), caption: toStrOrNull(row.caption) };
  }

  async recordAttempt(e: AttemptEvent): Promise<void> {
    await this.db.exec(
      `INSERT INTO publish_attempts (user_id, job_id, step, outcome, error_kind, error_code, http_status, created_at)
       SELECT user_id, id, $2, $3, $4, $5, $6, $7::timestamptz FROM publish_jobs WHERE id = $1`,
      [e.jobId, e.step, e.outcome, e.errorKind ?? null, e.errorCode ?? null, e.httpStatus ?? null, e.at],
    );
  }

  async pauseCycle(cycleId: string, reason: PauseReason, now: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      const paused = await tx.query(
        `UPDATE publishing_cycles SET status = 'PAUSED', pause_reason = $2, updated_at = $3::timestamptz
          WHERE id = $1 AND status = 'ACTIVE' RETURNING instagram_account_id`,
        [cycleId, reason, now],
      );
      const acct = paused[0]?.instagram_account_id;
      if (acct) {
        const status = reason === 'PERMISSION_REVOKED' ? 'PERMISSION_REVOKED' : 'REAUTH_REQUIRED';
        await tx.exec(`UPDATE instagram_accounts SET status = $2, last_error_code = $3 WHERE id = $1 AND status = 'CONNECTED'`, [
          acct,
          status,
          reason,
        ]);
      }
    });
  }
}
