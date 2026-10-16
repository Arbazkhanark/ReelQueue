import {
  CANCELLABLE_JOB_STATUSES,
  applyCycleCommand,
  computeCycleWindow,
  effectiveStatus,
  makeIdempotencyKey,
  planTick,
  type CursorState,
  type CycleStatus,
  type PublishQuota,
  type ProviderKind,
  type TickDecision,
} from '@reelqueue/core';
import { TERMINAL_STATUS_LIST } from './pg-job-store';
import { isUniqueViolation, toDate, toDateOrNull, toNum, toStrOrNull, type Row, type SqlExecutor } from './sql';

export interface CycleRow {
  id: string;
  userId: string;
  accountId: string;
  provider: ProviderKind;
  status: CycleStatus;
  pauseReason: string | null;
  batchSize: number;
  intervalMinutes: number;
  loopEnabled: boolean;
  startedAt: Date;
  endsAt: Date;
  nextBatchAt: Date;
  cursor: CursorState;
  nextSequenceNo: number;
  endedAt: Date | null;
  endReason: string | null;
}

export function mapCycle(r: Row): CycleRow {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    accountId: String(r.instagram_account_id),
    provider: String(r.provider) as ProviderKind,
    status: String(r.status) as CycleStatus,
    pauseReason: toStrOrNull(r.pause_reason),
    batchSize: toNum(r.batch_size),
    intervalMinutes: toNum(r.interval_minutes),
    loopEnabled: Boolean(r.loop_enabled),
    startedAt: toDate(r.started_at),
    endsAt: toDate(r.ends_at),
    nextBatchAt: toDate(r.next_batch_at),
    cursor: { lastPosition: toNum(r.cursor_last_position), iteration: toNum(r.cursor_iteration) },
    nextSequenceNo: toNum(r.next_sequence_no),
    endedAt: toDateOrNull(r.ended_at),
    endReason: toStrOrNull(r.end_reason),
  };
}

export interface TickConfig {
  quotaReserve: number;
  quotaRecheckMinutes: number;
  backpressureRecheckSeconds: number;
}
export const DEFAULT_TICK_CONFIG: TickConfig = { quotaReserve: 0, quotaRecheckMinutes: 15, backpressureRecheckSeconds: 60 };

export interface TickResult {
  decision: TickDecision['type'] | 'GONE';
  cycleStatus: CycleStatus | null;
  /** Jobs created by this tick; they are due immediately. */
  newJobs: { id: string; runAt: Date }[];
  /** When the next tick should run (null = no further tick needed). */
  nextTickAt: Date | null;
  quotaLimited: boolean;
  deferredByQuota: number;
  /** Why a COMPLETE/QUOTA_DEFER happened, for UI warnings. */
  reason?: string;
}

export type CommandOutcome =
  | { ok: true; cycle: CycleRow; cancelledJobs: number }
  | { ok: false; code: 'NOT_FOUND' | 'INVALID_TRANSITION' | 'CYCLE_EXPIRED'; message: string };

export type RetryOutcome =
  | { ok: true; jobId: string }
  | { ok: false; code: 'NOT_FOUND' | 'JOB_NOT_RETRYABLE' | 'CYCLE_NOT_ACTIVE' };

const PRE_PUBLISH_STATUSES = [...CANCELLABLE_JOB_STATUSES];
const NON_TERMINAL_STATUSES_SQL = TERMINAL_STATUS_LIST;

/** Persistence + transactions for the cycle lifecycle. All rules come from @reelqueue/core. */
export class SchedulerStore {
  constructor(private readonly db: SqlExecutor) {}

  /* ------------------------------------------------------------ create */

  /** Throws a unique-violation if the account already has a live cycle (one live cycle per account, DB-enforced). */
  async createCycle(input: {
    userId: string;
    accountId: string;
    provider: ProviderKind;
    batchSize: number;
    intervalMinutes: number;
    loopEnabled: boolean;
    durationHours: number;
    now: Date;
  }): Promise<{ ok: true; cycle: CycleRow } | { ok: false; code: 'CYCLE_ALREADY_ACTIVE' }> {
    const { startedAt, endsAt } = computeCycleWindow(input.now, input.durationHours);
    try {
      const rows = await this.db.query(
        `INSERT INTO publishing_cycles (user_id, instagram_account_id, provider, batch_size, interval_minutes, loop_enabled,
                                        started_at, ends_at, next_batch_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $7::timestamptz) RETURNING *`,
        [input.userId, input.accountId, input.provider, input.batchSize, input.intervalMinutes, input.loopEnabled, startedAt, endsAt],
      );
      return { ok: true, cycle: mapCycle(rows[0]!) };
    } catch (err) {
      if (isUniqueViolation(err, 'publishing_cycles_one_live_per_account')) return { ok: false, code: 'CYCLE_ALREADY_ACTIVE' };
      throw err;
    }
  }

  async countReadyVideos(userId: string): Promise<number> {
    const r = await this.db.query(`SELECT count(*) AS n FROM videos WHERE user_id = $1 AND status = 'READY' AND deleted_at IS NULL`, [userId]);
    return toNum(r[0]!.n);
  }

  async getCycle(userId: string, cycleId: string): Promise<CycleRow | null> {
    const r = await this.db.query('SELECT * FROM publishing_cycles WHERE id = $1 AND user_id = $2', [cycleId, userId]);
    return r[0] ? mapCycle(r[0]) : null;
  }

  async getLiveCycle(userId: string): Promise<CycleRow | null> {
    const r = await this.db.query(
      `SELECT * FROM publishing_cycles WHERE user_id = $1 AND status IN ('ACTIVE','PAUSED') ORDER BY started_at DESC LIMIT 1`,
      [userId],
    );
    return r[0] ? mapCycle(r[0]) : null;
  }

  async recordQuota(accountId: string, quota: PublishQuota): Promise<void> {
    await this.db.exec(
      `UPDATE instagram_accounts SET last_quota_used = $2, last_quota_total = $3, last_quota_fetched_at = $4::timestamptz WHERE id = $1`,
      [accountId, Math.max(0, Math.trunc(quota.used)), Math.max(0, Math.trunc(quota.total)), quota.fetchedAt],
    );
  }

  /* -------------------------------------------------------------- tick */

  /**
   * One scheduler tick for a cycle, fully transactional under a row lock on the cycle: duplicate or concurrent ticks
   * serialise, and the same slot can never be materialised twice (idempotency key + unique constraints).
   * `quota` comes from the provider (fetched by the caller, outside the transaction); null = unknown (fail closed).
   */
  async tick(cycleId: string, now: Date, quota: PublishQuota | null, cfg: TickConfig = DEFAULT_TICK_CONFIG): Promise<TickResult> {
    return this.db.transaction(async (tx) => {
      const locked = await tx.query('SELECT * FROM publishing_cycles WHERE id = $1 FOR UPDATE', [cycleId]);
      if (!locked[0]) return emptyResult('GONE', null);
      const cycle = mapCycle(locked[0]);

      const videos = (
        await tx.query(`SELECT id, position FROM videos WHERE user_id = $1 AND status = 'READY' AND deleted_at IS NULL`, [cycle.userId])
      ).map((v) => ({ id: String(v.id), position: toNum(v.position) }));
      const unresolved = toNum(
        (
          await tx.query(
            `SELECT count(*) AS n FROM publish_jobs WHERE cycle_id = $1 AND status <> ALL($2::text[]) AND status <> 'ACCEPTED'`,
            [cycleId, NON_TERMINAL_STATUSES_SQL],
          )
        )[0]!.n,
      );

      const decision = planTick({
        now,
        cycle: {
          status: cycle.status,
          startedAt: cycle.startedAt,
          endsAt: cycle.endsAt,
          nextBatchAt: cycle.nextBatchAt,
          cursor: cycle.cursor,
        },
        settings: { batchSize: cycle.batchSize, intervalMinutes: cycle.intervalMinutes, loopEnabled: cycle.loopEnabled },
        videos,
        unresolvedJobs: unresolved,
        quota,
        quotaReserve: cfg.quotaReserve,
        quotaRecheckMinutes: cfg.quotaRecheckMinutes,
        backpressureRecheckSeconds: cfg.backpressureRecheckSeconds,
      });

      switch (decision.type) {
        case 'EXPIRE':
          await expireCycle(tx, cycleId, now, 'WINDOW_ELAPSED');
          return emptyResult('EXPIRE', 'EXPIRED');
        case 'IDLE':
          return emptyResult('IDLE', cycle.status);
        case 'NOT_DUE':
        case 'BACKPRESSURE':
          return { ...emptyResult(decision.type, cycle.status), nextTickAt: decision.runAt };
        case 'QUOTA_DEFER':
          return { ...emptyResult('QUOTA_DEFER', cycle.status), nextTickAt: decision.runAt, reason: decision.reason };
        case 'COMPLETE':
          await tx.exec(
            `UPDATE publishing_cycles SET status = 'COMPLETED', ended_at = $2::timestamptz, end_reason = $3 WHERE id = $1`,
            [cycleId, now, decision.reason],
          );
          return { ...emptyResult('COMPLETE', 'COMPLETED'), reason: decision.reason };
        case 'SCHEDULE_BATCH': {
          const newJobs: { id: string; runAt: Date }[] = [];
          let seq = cycle.nextSequenceNo;
          for (const item of decision.items) {
            const key = makeIdempotencyKey(cycleId, item.videoId, item.iteration);
            const inserted = await tx.query(
              `INSERT INTO publish_jobs (user_id, cycle_id, instagram_account_id, video_id, sequence_no, iteration,
                                         idempotency_key, provider, next_attempt_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::timestamptz)
               ON CONFLICT (idempotency_key) DO NOTHING RETURNING id`,
              [cycle.userId, cycleId, cycle.accountId, item.videoId, seq, item.iteration, key, cycle.provider, now],
            );
            seq += 1;
            if (inserted[0]) newJobs.push({ id: String(inserted[0].id), runAt: now });
          }
          const nextBatchAt = decision.nextBatchAt ?? cycle.endsAt; // wake at expiry to close the cycle
          await tx.exec(
            `UPDATE publishing_cycles
                SET cursor_last_position = $2, cursor_iteration = $3, next_sequence_no = $4, next_batch_at = $5::timestamptz
              WHERE id = $1`,
            [cycleId, decision.cursorAfter.lastPosition, decision.cursorAfter.iteration, seq, nextBatchAt],
          );
          return {
            decision: 'SCHEDULE_BATCH',
            cycleStatus: cycle.status,
            newJobs,
            nextTickAt: nextBatchAt,
            quotaLimited: decision.quotaLimited,
            deferredByQuota: decision.deferredByQuota,
          };
        }
      }
    });
  }

  /* ---------------------------------------------------------- commands */

  async command(userId: string, cycleId: string, cmd: 'PAUSE' | 'RESUME' | 'STOP', now: Date): Promise<CommandOutcome> {
    return this.db.transaction(async (tx) => {
      const locked = await tx.query('SELECT * FROM publishing_cycles WHERE id = $1 AND user_id = $2 FOR UPDATE', [cycleId, userId]);
      if (!locked[0]) return { ok: false, code: 'NOT_FOUND', message: 'Cycle not found' } as const;
      const cycle = mapCycle(locked[0]);
      const state = { status: cycle.status, startedAt: cycle.startedAt, endsAt: cycle.endsAt };
      const result = applyCycleCommand(state, cmd, now);

      if (!result.ok) {
        if (result.code === 'CYCLE_EXPIRED') {
          await expireCycle(tx, cycleId, now, 'WINDOW_ELAPSED'); // make the lazy expiry durable
        }
        return { ok: false, code: result.code, message: result.message } as const;
      }

      let cancelled = 0;
      if (cmd === 'PAUSE') {
        await tx.exec(`UPDATE publishing_cycles SET status = 'PAUSED', pause_reason = 'USER' WHERE id = $1`, [cycleId]);
      } else if (cmd === 'RESUME') {
        await tx.exec(`UPDATE publishing_cycles SET status = 'ACTIVE', pause_reason = NULL WHERE id = $1`, [cycleId]);
      } else {
        await tx.exec(
          `UPDATE publishing_cycles SET status = 'STOPPED', ended_at = $2::timestamptz, end_reason = 'USER_STOPPED' WHERE id = $1`,
          [cycleId, now],
        );
        cancelled = await cancelUnstartedJobs(tx, cycleId, 'CANCELLED', 'CYCLE_STOPPED', now);
      }
      const fresh = await tx.query('SELECT * FROM publishing_cycles WHERE id = $1', [cycleId]);
      return { ok: true, cycle: mapCycle(fresh[0]!), cancelledJobs: cancelled } as const;
    });
  }

  async setLoop(userId: string, cycleId: string, loopEnabled: boolean): Promise<CycleRow | null> {
    const r = await this.db.query(
      `UPDATE publishing_cycles SET loop_enabled = $3 WHERE id = $1 AND user_id = $2 AND status IN ('ACTIVE','PAUSED') RETURNING *`,
      [cycleId, userId, loopEnabled],
    );
    return r[0] ? mapCycle(r[0]) : null;
  }

  /* ------------------------------------------------------------ retry */

  async retryJob(userId: string, jobId: string, now: Date): Promise<RetryOutcome> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query(
        `SELECT j.status, j.retryable, c.status AS cycle_status, c.started_at, c.ends_at
           FROM publish_jobs j JOIN publishing_cycles c ON c.id = j.cycle_id
          WHERE j.id = $1 AND j.user_id = $2 FOR UPDATE OF j`,
        [jobId, userId],
      );
      const row = rows[0];
      if (!row) return { ok: false, code: 'NOT_FOUND' } as const;
      if (String(row.status) !== 'FAILED' || !row.retryable) return { ok: false, code: 'JOB_NOT_RETRYABLE' } as const;
      const cycleEff = effectiveStatus(
        { status: String(row.cycle_status) as CycleStatus, startedAt: toDate(row.started_at), endsAt: toDate(row.ends_at) },
        now,
      );
      if (cycleEff !== 'ACTIVE') return { ok: false, code: 'CYCLE_NOT_ACTIVE' } as const;
      await tx.exec(
        `UPDATE publish_jobs
            SET status = 'SCHEDULED', next_attempt_at = $2::timestamptz, attempt_count = 0, retryable = false,
                failure_reason = NULL, last_error_kind = NULL, last_error_code = NULL, deferred_reason = NULL,
                publish_requested_at = NULL, lease_owner = NULL, lease_expires_at = NULL, version = version + 1
          WHERE id = $1`,
        [jobId, now],
      );
      return { ok: true, jobId } as const;
    });
  }

  /* ----------------------------------------------------------- sweeper */

  /**
   * Safety net for lost Redis state: due, unleased jobs whose cycle is ACTIVE, plus jobs that must be reconciled
   * (PUBLISH_REQUESTED / ACCEPTED) regardless of cycle state, ordered so each account is served in sequence.
   */
  async findDueJobs(now: Date, limit: number): Promise<{ id: string; accountId: string; dueAt: Date }[]> {
    const r = await this.db.query(
      `SELECT j.id, j.instagram_account_id, j.next_attempt_at
         FROM publish_jobs j JOIN publishing_cycles c ON c.id = j.cycle_id
        WHERE j.status <> ALL($1::text[])
          AND j.next_attempt_at <= $2::timestamptz
          AND (j.lease_owner IS NULL OR j.lease_expires_at <= $2::timestamptz)
          AND (c.status = 'ACTIVE' OR j.status IN ('PUBLISH_REQUESTED', 'ACCEPTED'))
        ORDER BY j.instagram_account_id, c.started_at, j.sequence_no
        LIMIT $3`,
      [TERMINAL_STATUS_LIST, now, limit],
    );
    return r.map((x) => ({ id: String(x.id), accountId: String(x.instagram_account_id), dueAt: toDate(x.next_attempt_at) }));
  }

  async findDueCycles(now: Date, limit: number): Promise<{ id: string; dueAt: Date }[]> {
    const r = await this.db.query(
      `SELECT id, LEAST(next_batch_at, ends_at) AS due_at FROM publishing_cycles
        WHERE (status = 'ACTIVE' AND next_batch_at <= $1::timestamptz) OR (status IN ('ACTIVE','PAUSED') AND ends_at <= $1::timestamptz)
        ORDER BY due_at LIMIT $2`,
      [now, limit],
    );
    return r.map((x) => ({ id: String(x.id), dueAt: toDate(x.due_at) }));
  }
}

/* ------------------------------------------------------------- helpers */

function emptyResult(decision: TickResult['decision'], cycleStatus: CycleStatus | null): TickResult {
  return { decision, cycleStatus, newJobs: [], nextTickAt: null, quotaLimited: false, deferredByQuota: 0 };
}

async function cancelUnstartedJobs(tx: SqlExecutor, cycleId: string, to: 'CANCELLED' | 'EXPIRED', reason: string, now: Date): Promise<number> {
  // Only jobs that have not reached PUBLISH_REQUESTED, and are not under a live lease (a live worker re-checks the
  // cycle itself before every irreversible step and cancels on its own).
  return tx.exec(
    `UPDATE publish_jobs
        SET status = $2, failure_reason = $3, lease_owner = NULL, lease_expires_at = NULL, version = version + 1,
            updated_at = $4::timestamptz
      WHERE cycle_id = $1 AND status = ANY($5::text[]) AND (lease_owner IS NULL OR lease_expires_at <= $4::timestamptz)`,
    [cycleId, to, reason, now, PRE_PUBLISH_STATUSES],
  );
}

async function expireCycle(tx: SqlExecutor, cycleId: string, now: Date, reason: string): Promise<void> {
  await tx.exec(
    `UPDATE publishing_cycles SET status = 'EXPIRED', ended_at = $2::timestamptz, end_reason = $3
      WHERE id = $1 AND status IN ('ACTIVE','PAUSED')`,
    [cycleId, now, reason],
  );
  await cancelUnstartedJobs(tx, cycleId, 'EXPIRED', 'CYCLE_EXPIRED', now);
}
