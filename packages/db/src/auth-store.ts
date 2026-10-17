import { isUniqueViolation, toDate, toDateOrNull, toNum, type Row, type SqlExecutor } from './sql';

export interface UserRow {
  id: string; email: string; passwordHash: string; role: 'USER' | 'ADMIN';
  status: 'ACTIVE' | 'SUSPENDED' | 'PENDING_DELETION';
  emailVerifiedAt: Date | null; failedLoginCount: number; lockedUntil: Date | null; createdAt: Date; deletionRequestedAt: Date | null;
}
const mapUser = (r: Row): UserRow => ({
  id: String(r.id), email: String(r.email), passwordHash: String(r.password_hash), role: r.role as UserRow['role'],
  status: r.status as UserRow['status'], emailVerifiedAt: toDateOrNull(r.email_verified_at),
  failedLoginCount: toNum(r.failed_login_count), lockedUntil: toDateOrNull(r.locked_until),
  createdAt: toDate(r.created_at), deletionRequestedAt: toDateOrNull(r.deletion_requested_at),
});
const USER_COLS = `id, email, password_hash, role, status, email_verified_at, failed_login_count, locked_until, created_at, deletion_requested_at`;

export type RotateResult =
  | { status: 'OK'; userId: string; familyId: string }
  | { status: 'INVALID' }
  | { status: 'EXPIRED' }
  /** A token that was already rotated away was presented long after rotation: treat as theft, the whole family is revoked. */
  | { status: 'REUSED'; userId: string }
  /** Presented within the grace window after rotation (two tabs refreshing at once). Rejected, but the family survives. */
  | { status: 'CONCURRENT' };

export type AuthTokenPurpose = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

/** Persistence for users, rotating refresh-token families and single-use email/reset tokens. Only HASHES of tokens are stored. */
export class AuthStore {
  constructor(private readonly db: SqlExecutor) {}

  async createUser(email: string, passwordHash: string): Promise<{ ok: true; user: UserRow } | { ok: false; code: 'EMAIL_TAKEN' }> {
    try {
      const rows = await this.db.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING ${USER_COLS}`, [email.toLowerCase(), passwordHash]);
      return { ok: true, user: mapUser(rows[0]!) };
    } catch (e) {
      if (isUniqueViolation(e, 'users_email_key')) return { ok: false, code: 'EMAIL_TAKEN' };
      throw e;
    }
  }

  async findByEmail(email: string): Promise<UserRow | null> {
    const rows = await this.db.query(`SELECT ${USER_COLS} FROM users WHERE email = $1`, [email.toLowerCase()]);
    return rows[0] ? mapUser(rows[0]) : null;
  }

  async findById(id: string): Promise<UserRow | null> {
    const rows = await this.db.query(`SELECT ${USER_COLS} FROM users WHERE id = $1`, [id]);
    return rows[0] ? mapUser(rows[0]) : null;
  }

  /** Atomic increment; locks the account once `maxFailures` is reached. */
  async recordLoginFailure(userId: string, now: Date, maxFailures: number, lockMs: number): Promise<{ failedCount: number; lockedUntil: Date | null }> {
    const rows = await this.db.query(
      `UPDATE users SET failed_login_count = failed_login_count + 1,
              locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN $3::timestamptz ELSE locked_until END
       WHERE id = $1 RETURNING failed_login_count, locked_until`,
      [userId, maxFailures, new Date(now.getTime() + lockMs)],
    );
    return { failedCount: toNum(rows[0]!.failed_login_count), lockedUntil: toDateOrNull(rows[0]!.locked_until) };
  }

  async recordLoginSuccess(userId: string, now: Date): Promise<void> {
    await this.db.exec(`UPDATE users SET failed_login_count = 0, locked_until = NULL, last_login_at = $2 WHERE id = $1`, [userId, now]);
  }

  /** Starts the deletion grace period. The user can still sign in to cancel; a retention job hard-deletes later (not yet implemented). */
  async requestDeletion(userId: string, now: Date): Promise<void> {
    await this.db.exec(`UPDATE users SET status = 'PENDING_DELETION', deletion_requested_at = $2 WHERE id = $1 AND status = 'ACTIVE'`, [userId, now]);
  }
  async cancelDeletion(userId: string): Promise<boolean> {
    return (await this.db.exec(`UPDATE users SET status = 'ACTIVE', deletion_requested_at = NULL WHERE id = $1 AND status = 'PENDING_DELETION'`, [userId])) === 1;
  }

  async setPasswordHash(userId: string, hash: string): Promise<void> {
    await this.db.exec(`UPDATE users SET password_hash = $2 WHERE id = $1`, [userId, hash]);
  }

  // ---- refresh tokens -------------------------------------------------------------------------------------------

  async issueRefreshToken(a: { userId: string; tokenHash: string; expiresAt: Date; familyId?: string; userAgent?: string | null; ipHash?: string | null }): Promise<{ id: string; familyId: string }> {
    const rows = await this.db.query(
      `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip_hash)
       VALUES ($1, COALESCE($2::uuid, gen_random_uuid()), $3, $4, $5, $6) RETURNING id, family_id`,
      [a.userId, a.familyId ?? null, a.tokenHash, a.expiresAt, a.userAgent?.slice(0, 256) ?? null, a.ipHash ?? null],
    );
    return { id: String(rows[0]!.id), familyId: String(rows[0]!.family_id) };
  }

  /**
   * Rotation: the presented token is revoked and replaced by a new one in the SAME family, atomically, under a row lock
   * (so two simultaneous requests with one token cannot both succeed). Presenting an already-rotated token outside the
   * grace window revokes the entire family.
   */
  async rotateRefreshToken(a: { oldHash: string; newHash: string; newExpiresAt: Date; now: Date; graceMs: number; userAgent?: string | null; ipHash?: string | null }): Promise<RotateResult> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query(
        `SELECT id, user_id, family_id, expires_at, revoked_at, replaced_by FROM refresh_tokens WHERE token_hash = $1 FOR UPDATE`, [a.oldHash]);
      const t = rows[0];
      if (!t) return { status: 'INVALID' } as const;
      const userId = String(t.user_id), familyId = String(t.family_id);
      if (t.revoked_at) {
        const revokedAt = toDate(t.revoked_at);
        if (t.replaced_by && a.now.getTime() - revokedAt.getTime() <= a.graceMs) return { status: 'CONCURRENT' } as const;
        await tx.exec(`UPDATE refresh_tokens SET revoked_at = $2 WHERE family_id = $1 AND revoked_at IS NULL`, [familyId, a.now]);
        return { status: 'REUSED', userId } as const;
      }
      if (toDate(t.expires_at).getTime() <= a.now.getTime()) return { status: 'EXPIRED' } as const;
      const fresh = await tx.query(
        `INSERT INTO refresh_tokens (user_id, family_id, token_hash, expires_at, user_agent, ip_hash) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
        [userId, familyId, a.newHash, a.newExpiresAt, a.userAgent?.slice(0, 256) ?? null, a.ipHash ?? null]);
      await tx.exec(`UPDATE refresh_tokens SET revoked_at = $2, replaced_by = $3 WHERE id = $1`, [String(t.id), a.now, String(fresh[0]!.id)]);
      return { status: 'OK', userId, familyId } as const;
    });
  }

  /** Logout: revokes the family of the presented token. Unknown tokens are a no-op (never reveals existence). */
  async revokeFamilyOf(tokenHash: string, now: Date): Promise<void> {
    await this.db.exec(
      `UPDATE refresh_tokens SET revoked_at = $2 WHERE revoked_at IS NULL AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`, [tokenHash, now]);
  }

  async revokeAllForUser(userId: string, now: Date): Promise<number> {
    return this.db.exec(`UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [userId, now]);
  }

  async purgeExpiredRefreshTokens(now: Date, olderThanMs: number): Promise<number> {
    return this.db.exec(`DELETE FROM refresh_tokens WHERE expires_at < $1`, [new Date(now.getTime() - olderThanMs)]);
  }

  // ---- single-use email-verification / password-reset tokens ------------------------------------------------------

  /** Issuing a new token invalidates older unused ones of the same purpose. */
  async createAuthToken(a: { userId: string; purpose: AuthTokenPurpose; tokenHash: string; expiresAt: Date; now: Date }): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.exec(`UPDATE auth_tokens SET used_at = $3 WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [a.userId, a.purpose, a.now]);
      await tx.exec(`INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3,$4)`, [a.userId, a.purpose, a.tokenHash, a.expiresAt]);
    });
  }

  /** Atomic single use: two concurrent consumers cannot both win. */
  async consumeAuthToken(tokenHash: string, purpose: AuthTokenPurpose, now: Date): Promise<{ userId: string } | null> {
    const rows = await this.db.query(
      `UPDATE auth_tokens SET used_at = $3 WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > $3 RETURNING user_id`, [tokenHash, purpose, now]);
    return rows[0] ? { userId: String(rows[0].user_id) } : null;
  }

  async markEmailVerified(userId: string, now: Date): Promise<void> {
    await this.db.exec(`UPDATE users SET email_verified_at = COALESCE(email_verified_at, $2) WHERE id = $1`, [userId, now]);
  }

  /** Password reset: consume the token, set the new hash and sign out every session, all in one transaction. */
  async resetPassword(a: { tokenHash: string; newPasswordHash: string; now: Date }): Promise<{ userId: string } | null> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.query(
        `UPDATE auth_tokens SET used_at = $2 WHERE token_hash = $1 AND purpose = 'PASSWORD_RESET' AND used_at IS NULL AND expires_at > $2 RETURNING user_id`, [a.tokenHash, a.now]);
      if (!rows[0]) return null;
      const userId = String(rows[0].user_id);
      await tx.exec(`UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL WHERE id = $1`, [userId, a.newPasswordHash]);
      await tx.exec(`UPDATE refresh_tokens SET revoked_at = $2 WHERE user_id = $1 AND revoked_at IS NULL`, [userId, a.now]);
      return { userId };
    });
  }
}
