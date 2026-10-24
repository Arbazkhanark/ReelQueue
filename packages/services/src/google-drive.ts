// packages/services/src/google-drive.ts
import { randomBytes } from 'node:crypto';
import { hashToken, type Clock, type TokenCipher } from '@reelqueue/core';
import type { GoogleDriveStore } from '@reelqueue/db';
import { GoogleApiError, pkceChallenge, newPkceVerifier, type DriveClient, type DriveFile, type GoogleOAuthClient } from '@reelqueue/integrations';
import { AppError, type DriveFileDto, type DriveFileListDto, type GoogleDriveStatusDto } from '@reelqueue/shared';
import type { ServiceLogger } from './upload-service';

/** Structural ports: tests inject fakes, production injects the real clients. */
export type GoogleOAuthPort = Pick<GoogleOAuthClient, 'buildAuthorizationUrl' | 'exchangeCode' | 'refresh' | 'revoke'>;
export type DrivePort = Pick<DriveClient, 'aboutUser' | 'getFile' | 'listFiles' | 'findAppFolder' | 'createFolder' | 'startResumableUpload' | 'uploadToSession' | 'download' | 'deleteFile'> ;
// & {
//   uploadToSession: (sessionUri: string, bytes: Uint8Array, mimeType: string) => Promise<DriveFile>;
// };

export interface GoogleDriveConfig {
  /** Scopes that must have been granted (the user can untick granular permissions on Google's consent screen). */
  requiredScopes: string[];
  stateTtlMs: number;
  appFolderName: string;
  allowedContentTypes: readonly string[];
  maxFileBytes: number;
  /** Legacy config field retained for compatibility; uploads now go server-to-server. */
  webOrigin: string;
  /** Refresh the access token when it expires within this window. */
  refreshSkewMs: number;
}
export const DEFAULT_GOOGLE_DRIVE_CONFIG = { stateTtlMs: 10 * 60_000, appFolderName: 'ReelQueue', refreshSkewMs: 60_000 } as const;

export type DriveConnectFailure = 'STATE_INVALID' | 'STATE_EXPIRED' | 'MISSING_PERMISSION' | 'NO_REFRESH_TOKEN' | 'PROVIDER_ERROR';
export type DriveConnectResult = { ok: true } | { ok: false; reason: DriveConnectFailure };

const pkceAad = (userId: string) => `gdrive-pkce:${userId}`;
export const driveTokenAad = (userId: string, kind: 'access' | 'refresh') => `gdrive-${kind}:${userId}`;
const toDto = (f: DriveFile): DriveFileDto => ({ id: f.id, name: f.name, mimeType: f.mimeType, sizeBytes: f.sizeBytes, modifiedTime: f.modifiedTime, createdTime: f.createdTime, isFolder: f.isFolder, managedByReelQueue: f.createdByApp });
const cleanName = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, '').trim();

/**
 * Optional Google Drive integration. Every method takes the SESSION's userId; Drive ids supplied by the client are only ever
 * used with THAT user's own token, so another user's files are unreachable (Drive answers "not found"). S3 is not involved.
 * All Google behaviour is UNVERIFIED against the real service (see docs/GOOGLE_DRIVE.md).
 */
export class GoogleDriveService {
  constructor(
    private readonly store: GoogleDriveStore, private readonly oauth: GoogleOAuthPort, private readonly drive: DrivePort,
    private readonly cipher: TokenCipher, private readonly clock: Clock, private readonly cfg: GoogleDriveConfig, private readonly log: ServiceLogger = { warn: () => undefined },
  ) {}

  /* --------------------------------------------------------------- connect */
  async start(userId: string): Promise<{ authorizationUrl: string }> {
    const state = randomBytes(32).toString('base64url'); const verifier = newPkceVerifier(); const now = this.clock.now();
    await this.store.createState(userId, hashToken(state), this.cipher.encrypt(verifier, pkceAad(userId)), now, new Date(now.getTime() + this.cfg.stateTtlMs));
    return { authorizationUrl: this.oauth.buildAuthorizationUrl(state, pkceChallenge(verifier)) };
  }

  /** `sessionUserId` comes from the authenticated session of the callback request, NOT from the URL. */
  async complete(a: { sessionUserId: string; code: string; state: string }): Promise<DriveConnectResult> {
    const now = this.clock.now();
    const st = await this.store.consumeState(hashToken(a.state), now); // single use, even when the checks below fail
    if (!st || st.userId !== a.sessionUserId) return { ok: false, reason: 'STATE_INVALID' }; // unknown, replayed, or started by another user
    if (st.expired) return { ok: false, reason: 'STATE_EXPIRED' };
    let verifier: string;
    try { verifier = this.cipher.decrypt(st.codeVerifierEnc, pkceAad(st.userId)); } catch { return { ok: false, reason: 'STATE_INVALID' }; }
    try {
      const t = await this.oauth.exchangeCode(a.code, verifier);
      if (!this.cfg.requiredScopes.every((s) => t.scopes.includes(s))) return { ok: false, reason: 'MISSING_PERMISSION' };
      const existing = await this.store.get(st.userId);
      const refreshEnc = t.refreshToken ? this.cipher.encrypt(t.refreshToken, driveTokenAad(st.userId, 'refresh')) : existing?.refreshTokenEnc;
      if (!refreshEnc) return { ok: false, reason: 'NO_REFRESH_TOKEN' };
      let googleAccountId: string | null = null;
      try { googleAccountId = (await this.drive.aboutUser(t.accessToken)).permissionId; } catch { /* optional: only used to notice a different Google account */ }
      await this.store.upsert({ userId: st.userId, googleAccountId, accessTokenEnc: this.cipher.encrypt(t.accessToken, driveTokenAad(st.userId, 'access')), refreshTokenEnc: refreshEnc, tokenExpiresAt: t.expiresAt, scopes: t.scopes, now });
      return { ok: true };
    } catch (e) {
      this.log.warn({ kind: e instanceof GoogleApiError ? e.kind : 'UNEXPECTED' }, 'google drive connect failed');
      return { ok: false, reason: 'PROVIDER_ERROR' };
    }
  }

  async status(userId: string): Promise<GoogleDriveStatusDto> {
    const c = await this.store.get(userId);
    return { enabled: true, status: !c ? 'NOT_CONNECTED' : c.status, scopes: c?.scopes ?? [], connectedAt: c ? c.createdAt.toISOString() : null };
  }

  async disconnect(userId: string): Promise<void> {
    const c = await this.store.get(userId);
    if (!c) return; // idempotent
    try { await this.oauth.revoke(this.cipher.decrypt(c.refreshTokenEnc, driveTokenAad(userId, 'refresh'))); }
    catch (e) { this.log.warn({ kind: e instanceof GoogleApiError ? e.kind : 'UNDECRYPTABLE' }, 'google token revoke failed; the connection is removed anyway'); }
    await this.store.delete(userId);
  }

  /* ----------------------------------------------------------------- tokens */
  private async accessToken(userId: string, force = false): Promise<string> {
    const c = await this.store.get(userId);
    if (!c) throw new AppError('GOOGLE_DRIVE_NOT_CONNECTED', 'Google Drive is not connected.');
    if (c.status === 'REAUTH_REQUIRED') throw new AppError('GOOGLE_DRIVE_REAUTH_REQUIRED', 'Reconnect Google Drive to continue.');
    const now = this.clock.now();
    if (!force && c.tokenExpiresAt.getTime() - now.getTime() > this.cfg.refreshSkewMs) return this.cipher.decrypt(c.accessTokenEnc, driveTokenAad(userId, 'access'));
    let fresh;
    try { fresh = await this.oauth.refresh(this.cipher.decrypt(c.refreshTokenEnc, driveTokenAad(userId, 'refresh'))); }
    catch (e) {
      if (e instanceof GoogleApiError && e.kind === 'AUTH_EXPIRED') { await this.store.markReauth(userId, 'AUTH_EXPIRED', now); throw new AppError('GOOGLE_DRIVE_REAUTH_REQUIRED', 'Reconnect Google Drive to continue.'); }
      if (!(e instanceof GoogleApiError)) { await this.store.markReauth(userId, 'TOKEN_UNREADABLE', now); throw new AppError('GOOGLE_DRIVE_REAUTH_REQUIRED', 'Reconnect Google Drive to continue.'); }
      throw this.mapError(e);
    }
    const swapped = await this.store.applyRefreshedAccess(userId, c.accessTokenEnc, this.cipher.encrypt(fresh.accessToken, driveTokenAad(userId, 'access')), fresh.expiresAt, now);
    if (swapped) return fresh.accessToken;
    const again = await this.store.get(userId); // someone else refreshed or reconnected meanwhile: use what is stored now
    if (!again) throw new AppError('GOOGLE_DRIVE_NOT_CONNECTED', 'Google Drive is not connected.');
    return this.cipher.decrypt(again.accessTokenEnc, driveTokenAad(userId, 'access'));
  }

  private mapError(e: unknown): AppError {
    if (e instanceof AppError) return e;
    if (e instanceof GoogleApiError) {
      switch (e.kind) {
        case 'NOT_FOUND': case 'PERMISSION': return new AppError('NOT_FOUND', 'File not found, or not accessible to ReelQueue.'); // same answer: no existence leak
        case 'RATE_LIMITED': return new AppError('RATE_LIMITED', 'Google Drive is rate limiting requests. Try again shortly.');
        case 'VALIDATION': return new AppError('VALIDATION_FAILED', 'Google Drive rejected the request.');
        case 'AUTH_EXPIRED': return new AppError('GOOGLE_DRIVE_REAUTH_REQUIRED', 'Reconnect Google Drive to continue.');
        default: this.log.warn({ kind: e.kind, httpStatus: e.httpStatus, reason: e.reason }, 'google drive request failed'); return new AppError('GOOGLE_DRIVE_UNAVAILABLE', 'Google Drive is unavailable right now.');
      }
    }
    this.log.warn({ kind: 'UNEXPECTED' }, 'google drive request failed');
    return new AppError('GOOGLE_DRIVE_UNAVAILABLE', 'Google Drive is unavailable right now.');
  }

  /** Runs `fn` with the user's token; a 401 triggers exactly one forced refresh + retry. */
  private async call<T>(userId: string, fn: (token: string) => Promise<T>): Promise<T> {
    let token = await this.accessToken(userId);
    try { return await fn(token); }
    catch (e) {
      if (e instanceof GoogleApiError && e.kind === 'AUTH_EXPIRED') {
        token = await this.accessToken(userId, true);
        try { return await fn(token); } catch (e2) { if (e2 instanceof GoogleApiError && e2.kind === 'AUTH_EXPIRED') { await this.store.markReauth(userId, 'AUTH_EXPIRED', this.clock.now()); } throw this.mapError(e2); }
      }
      throw this.mapError(e);
    }
  }

  /* ------------------------------------------------------------------ files */
  async list(userId: string, o: { pageToken?: string; pageSize?: number }): Promise<DriveFileListDto> {
    const r = await this.call(userId, (t) => this.drive.listFiles(t, { pageSize: o.pageSize ?? 50, ...(o.pageToken ? { pageToken: o.pageToken } : {}) }));
    return { files: r.files.map(toDto), nextPageToken: r.nextPageToken };
  }
  async get(userId: string, fileId: string): Promise<DriveFileDto> {
    const f = await this.call(userId, (t) => this.drive.getFile(t, fileId));
    if (f.trashed) throw new AppError('NOT_FOUND', 'File not found, or not accessible to ReelQueue.');
    return toDto(f);
  }

  /** Metadata needed to import a Drive video as a ReelQueue video (no bytes are downloaded). */
  async getForImport(userId: string, fileId: string): Promise<{ name: string; mimeType: string; sizeBytes: number | null; isFolder: boolean; video: { durationMs: number; width: number; height: number } | null }> {
    const f = await this.call(userId, (t) => this.drive.getFile(t, fileId));
    if (f.trashed) throw new AppError('NOT_FOUND', 'File not found, or not accessible to ReelQueue.');
    return { name: f.name, mimeType: f.mimeType, sizeBytes: f.sizeBytes, isFolder: f.isFolder, video: f.video ?? null };
  }

  /** Validates against the same media rules as the S3 upload flow, creates the app folder on first use, and returns a resumable session. */
  async startUpload(userId: string, f: { filename: string; contentType: string; sizeBytes: number }): Promise<{ sessionUri: string }> {
    const name = cleanName(f.filename);
    if (!name || name.length > 255) throw new AppError('VALIDATION_FAILED', 'Invalid file name.');
    if (!this.cfg.allowedContentTypes.includes(f.contentType.split(';')[0]!.trim().toLowerCase())) throw new AppError('UNSUPPORTED_MEDIA', 'This file type is not supported.');
    if (!Number.isInteger(f.sizeBytes) || f.sizeBytes <= 0) throw new AppError('VALIDATION_FAILED', 'Invalid file size.');
    if (f.sizeBytes > this.cfg.maxFileBytes) throw new AppError('UPLOAD_LIMIT_EXCEEDED', 'File is larger than the allowed size.');
    return this.call(userId, async (t) => {
      const attempt = async () => this.drive.startResumableUpload(t, { name, mimeType: f.contentType, sizeBytes: f.sizeBytes, parentId: await this.ensureFolder(userId, t), origin: this.cfg.webOrigin });
      try { return await attempt(); }
      catch (e) { if (e instanceof GoogleApiError && e.kind === 'NOT_FOUND') { await this.store.clearAppFolder(userId, this.clock.now()); return attempt(); } throw e; } // the user deleted the folder: recreate once
    });
  }
  // NEW: Complete the upload on the server. The resumable session URL is never returned to the browser.
    // NEW: Uploads the actual binary file through the backend to Google Drive.
  async uploadFile(
    userId: string,
    f: {
      filename: string;
      contentType: string;
      sizeBytes: number;
    },
    bytes: Uint8Array,
  ): Promise<DriveFileDto> {
    // NEW: Verify declared file size against the actual received bytes.
    if (bytes.byteLength !== f.sizeBytes) {
      throw new AppError(
        'VALIDATION_FAILED',
        'Uploaded byte count does not match the declared file size.',
      );
    }

    // Reuse existing validation, folder creation and resumable-session logic.
    const { sessionUri } = await this.startUpload(userId, f);

    try {
      // NEW: Send bytes from the backend to Google, avoiding browser CORS.
      const uploaded = await this.drive.uploadToSession(
        sessionUri,
        bytes,
        f.contentType,
      );

      // Return the same DTO format used by the existing Drive file endpoints.
      return toDto(uploaded);
    } catch (error) {
      throw this.mapError(error);
    }
  }

  private async ensureFolder(userId: string, token: string): Promise<string> {
    const c = await this.store.get(userId);
    if (c?.appFolderId) return c.appFolderId;
    const folder = (await this.drive.findAppFolder(token, this.cfg.appFolderName)) ?? (await this.drive.createFolder(token, this.cfg.appFolderName));
    return (await this.store.setAppFolderIfUnset(userId, folder.id, this.clock.now())) ?? folder.id;
  }

  /** Streams the file; the bytes are never buffered here. Native Google documents and folders cannot be downloaded. */
  async openDownload(userId: string, fileId: string): Promise<{ stream: AsyncIterable<Uint8Array>; name: string; sizeBytes: number | null }> {
    return this.call(userId, async (t) => {
      const meta = await this.drive.getFile(t, fileId);
      if (meta.trashed) throw new GoogleApiError('NOT_FOUND', 'gone');
      if (meta.isFolder || meta.mimeType.startsWith('application/vnd.google-apps.')) throw new AppError('VALIDATION_FAILED', 'This item cannot be downloaded.');
      const d = await this.drive.download(t, fileId);
      return { stream: d.stream, name: meta.name, sizeBytes: meta.sizeBytes ?? d.contentLength };
    });
  }

  /** Only files ReelQueue created itself (app property) may be deleted through the API. */
  async delete(userId: string, fileId: string): Promise<void> {
    await this.call(userId, async (t) => {
      const meta = await this.drive.getFile(t, fileId);
      if (!meta.createdByApp) throw new AppError('FORBIDDEN', 'Only files created by ReelQueue can be deleted here.');
      await this.drive.deleteFile(t, fileId);
    });
  }
}