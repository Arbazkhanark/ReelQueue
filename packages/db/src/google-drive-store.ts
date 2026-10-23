import { toDate, toDateOrNull, toStrOrNull, type Row, type SqlExecutor } from './sql';

export interface DriveConnectionRow {
  id: string; userId: string; googleAccountId: string | null;
  /** AES-GCM envelopes. INTERNAL: services decrypt them; they are never returned by an API. */
  accessTokenEnc: string; refreshTokenEnc: string;
  tokenExpiresAt: Date; scopes: string[]; status: 'CONNECTED' | 'REAUTH_REQUIRED'; appFolderId: string | null; lastErrorCode: string | null; createdAt: Date; updatedAt: Date;
}
const toStrArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.replace(/^\{|\}$/g, '').split(',').filter(Boolean).map((s) => s.replace(/^"|"$/g, '')) : []);
const map = (r: Row): DriveConnectionRow => ({
  id: String(r.id), userId: String(r.user_id), googleAccountId: toStrOrNull(r.google_account_id), accessTokenEnc: String(r.access_token_enc), refreshTokenEnc: String(r.refresh_token_enc),
  tokenExpiresAt: toDate(r.token_expires_at), scopes: toStrArray(r.scopes), status: r.status === 'REAUTH_REQUIRED' ? 'REAUTH_REQUIRED' : 'CONNECTED',
  appFolderId: toStrOrNull(r.app_folder_id), lastErrorCode: toStrOrNull(r.last_error_code), createdAt: toDate(r.created_at), updatedAt: toDate(r.updated_at),
});

export type ConsumedState = { userId: string; codeVerifierEnc: string; expired: boolean };

/** Google Drive connection + OAuth state persistence. Every method is keyed by the (session-derived) userId or by the secret state hash. */
export class GoogleDriveStore {
  constructor(private readonly db: SqlExecutor) {}

  /** Replaces any pending state of this user (at most one outstanding flow) and sweeps expired states. */
  async createState(userId: string, stateHash: string, codeVerifierEnc: string, now: Date, expiresAt: Date): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.exec(`DELETE FROM google_oauth_states WHERE user_id = $1 OR expires_at < $2`, [userId, now]);
      await tx.exec(`INSERT INTO google_oauth_states (state_hash, user_id, code_verifier_enc, created_at, expires_at) VALUES ($1, $2, $3, $4, $5)`, [stateHash, userId, codeVerifierEnc, now, expiresAt]);
    });
  }
  /** Atomic single use: the row is deleted whether or not it was still valid, so a state can never be replayed. */
  async consumeState(stateHash: string, now: Date): Promise<ConsumedState | null> {
    const r = (await this.db.query(`DELETE FROM google_oauth_states WHERE state_hash = $1 RETURNING user_id, code_verifier_enc, expires_at`, [stateHash]))[0];
    return r ? { userId: String(r.user_id), codeVerifierEnc: String(r.code_verifier_enc), expired: toDate(r.expires_at).getTime() <= now.getTime() } : null;
  }

  async get(userId: string): Promise<DriveConnectionRow | null> {
    const r = (await this.db.query(`SELECT * FROM google_drive_connections WHERE user_id = $1`, [userId]))[0];
    return r ? map(r) : null;
  }
  /** Connect or reconnect. A different Google account invalidates the remembered app folder. */
  async upsert(a: { userId: string; googleAccountId: string | null; accessTokenEnc: string; refreshTokenEnc: string; tokenExpiresAt: Date; scopes: string[]; now: Date }): Promise<DriveConnectionRow> {
    const r = await this.db.query(
      `INSERT INTO google_drive_connections (user_id, google_account_id, access_token_enc, refresh_token_enc, token_expires_at, scopes, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $7)
       ON CONFLICT (user_id) DO UPDATE SET
         app_folder_id = CASE WHEN google_drive_connections.google_account_id IS NOT DISTINCT FROM EXCLUDED.google_account_id THEN google_drive_connections.app_folder_id ELSE NULL END,
         google_account_id = EXCLUDED.google_account_id, access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
         token_expires_at = EXCLUDED.token_expires_at, scopes = EXCLUDED.scopes, status = 'CONNECTED', last_error_code = NULL, updated_at = EXCLUDED.updated_at
       RETURNING *`,
      [a.userId, a.googleAccountId, a.accessTokenEnc, a.refreshTokenEnc, a.tokenExpiresAt, a.scopes, a.now]);
    return map(r[0]!);
  }
  /** Compare-and-set on the old access ciphertext so two concurrent refreshes cannot interleave stale writes over a reconnect. */
  async applyRefreshedAccess(userId: string, oldAccessEnc: string, newAccessEnc: string, expiresAt: Date, now: Date): Promise<boolean> {
    return (await this.db.exec(`UPDATE google_drive_connections SET access_token_enc = $3, token_expires_at = $4, status = 'CONNECTED', last_error_code = NULL, updated_at = $5 WHERE user_id = $1 AND access_token_enc = $2`, [userId, oldAccessEnc, newAccessEnc, expiresAt, now])) === 1;
  }
  /** First writer wins; returns the folder id that is now stored. */
  async setAppFolderIfUnset(userId: string, folderId: string, now: Date): Promise<string | null> {
    const r = (await this.db.query(`UPDATE google_drive_connections SET app_folder_id = COALESCE(app_folder_id, $2), updated_at = $3 WHERE user_id = $1 RETURNING app_folder_id`, [userId, folderId, now]))[0];
    return r ? toStrOrNull(r.app_folder_id) : null;
  }
  async clearAppFolder(userId: string, now: Date): Promise<void> { await this.db.exec(`UPDATE google_drive_connections SET app_folder_id = NULL, updated_at = $2 WHERE user_id = $1`, [userId, now]); }
  async markReauth(userId: string, code: string, now: Date): Promise<void> {
    await this.db.exec(`UPDATE google_drive_connections SET status = 'REAUTH_REQUIRED', last_error_code = $2, updated_at = $3 WHERE user_id = $1`, [userId, code, now]);
  }
  async delete(userId: string): Promise<boolean> { return (await this.db.exec(`DELETE FROM google_drive_connections WHERE user_id = $1`, [userId])) === 1; }
}