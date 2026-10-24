// packages/integrations/google/drive.ts
import { classify, defaultFetch, DEFAULT_RETRY, GoogleApiError, parseJson, send, withRetry, type GFetch, type RetryOptions } from './common';

/**
 * Google Drive API v3 client: only the operations ReelQueue's storage lifecycle needs.
 */
export interface DriveClientConfig { requestTimeoutMs: number; maxFileBytes?: number; baseUrl?: string; uploadUrl?: string }
export interface DriveFile {
  id: string; name: string; mimeType: string; sizeBytes: number | null; createdTime: string | null; modifiedTime: string | null;
  md5Checksum: string | null; parents: string[]; trashed: boolean; isFolder: boolean; createdByApp: boolean;
  /** Duration/size as computed by Google for video files; null until Google has processed the file. */
  video?: { durationMs: number; width: number; height: number } | null;
}
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
export const APP_PROPERTY = 'reelqueue';
// const FIELDS = 'id,name,mimeType,size,createdTime,modifiedTime,md5Checksum,parents,trashed,appProperties';
const FIELDS = 'id,name,mimeType,size,createdTime,modifiedTime,md5Checksum,parents,trashed,appProperties,videoMediaMetadata';
const ID = /^[A-Za-z0-9_-]{10,128}$/;

export function assertDriveId(id: string, what = 'file'): string {
  if (!ID.test(id)) throw new GoogleApiError('VALIDATION', `Invalid Drive ${what} id`);
  return id;
}

function parseVideo(v: unknown): { durationMs: number; width: number; height: number } | null {
  const m = (v ?? null) as Record<string, unknown> | null;
  if (!m || typeof m !== 'object') return null;
  const dur = typeof m.durationMillis === 'string' ? Number(m.durationMillis) : typeof m.durationMillis === 'number' ? m.durationMillis : NaN;
  const w = typeof m.width === 'number' ? m.width : NaN;
  const h = typeof m.height === 'number' ? m.height : NaN;
  return Number.isFinite(dur) && dur > 0 && Number.isInteger(w) && w > 0 && Number.isInteger(h) && h > 0 ? { durationMs: Math.round(dur), width: w, height: h } : null;
}

const GOOGLE_HOST = /^https:\/\/([a-z0-9-]+\.)*googleapis\.com\//;
const retryAll = (e: GoogleApiError) => e.kind === 'UNAVAILABLE' || e.kind === 'RATE_LIMITED';
const retryRateOnly = (e: GoogleApiError) => e.kind === 'RATE_LIMITED';

export class DriveClient {
  private readonly base: string; private readonly upload: string;
  constructor(private readonly cfg: DriveClientConfig, private readonly deps: { fetch?: GFetch; retry?: Partial<RetryOptions> } = {}) {
    this.base = cfg.baseUrl ?? 'https://www.googleapis.com/drive/v3'; this.upload = cfg.uploadUrl ?? 'https://www.googleapis.com/upload/drive/v3';
  }
  private get f(): GFetch { return this.deps.fetch ?? defaultFetch; }
  private get retry(): RetryOptions { return { ...DEFAULT_RETRY, ...this.deps.retry }; }

  private async json(token: string, method: string, url: string, o: { body?: unknown; retry?: (e: GoogleApiError) => boolean; extraHeaders?: Record<string, string> } = {}): Promise<{ json: unknown; headers: GFetchHeaders }> {
    return withRetry(this.retry, o.retry ?? retryAll, async () => {
      const headers: Record<string, string> = { authorization: `Bearer ${token}`, accept: 'application/json', ...o.extraHeaders };
      if (o.body !== undefined) headers['content-type'] = 'application/json; charset=UTF-8';
      const { res, text } = await send(this.f, this.cfg.requestTimeoutMs, url, { method, headers, ...(o.body !== undefined ? { body: JSON.stringify(o.body) } : {}) });
      if (res.status < 200 || res.status >= 300) throw classify(res.status, parseJson(text), res.headers.get('retry-after'));
      return { json: parseJson(text), headers: res.headers };
    });
  }

  static mapFile(j: unknown): DriveFile {
    const r = (j ?? {}) as Record<string, unknown>;
    if (typeof r.id !== 'string' || typeof r.name !== 'string') throw new GoogleApiError('UNKNOWN', 'Google returned an unexpected file shape');
    const mime = typeof r.mimeType === 'string' ? r.mimeType : 'application/octet-stream';
    const size = typeof r.size === 'string' && /^\d+$/.test(r.size) ? Number(r.size) : typeof r.size === 'number' ? r.size : null;
    return {
      id: r.id, name: r.name, mimeType: mime, sizeBytes: size, createdTime: typeof r.createdTime === 'string' ? r.createdTime : null, modifiedTime: typeof r.modifiedTime === 'string' ? r.modifiedTime : null,
      md5Checksum: typeof r.md5Checksum === 'string' ? r.md5Checksum : null, parents: Array.isArray(r.parents) ? r.parents.map(String) : [], trashed: r.trashed === true, isFolder: mime === FOLDER_MIME,
      createdByApp: (r.appProperties as Record<string, unknown> | undefined)?.[APP_PROPERTY] === '1',
      video: parseVideo(r.videoMediaMetadata),
    };
  }

  async aboutUser(token: string): Promise<{ permissionId: string | null }> {
    const { json } = await this.json(token, 'GET', `${this.base}/about?fields=${encodeURIComponent('user(permissionId)')}`);
    const id = (json as { user?: { permissionId?: unknown } } | null)?.user?.permissionId;
    return { permissionId: typeof id === 'string' ? id : null };
  }

  async getFile(token: string, fileId: string): Promise<DriveFile> {
    const { json } = await this.json(token, 'GET', `${this.base}/files/${assertDriveId(fileId)}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=false`);
    return DriveClient.mapFile(json);
  }

  async exists(token: string, fileId: string): Promise<boolean> {
    try { return !(await this.getFile(token, fileId)).trashed; } catch (e) { if (e instanceof GoogleApiError && e.kind === 'NOT_FOUND') return false; throw e; }
  }

  async listFiles(token: string, o: { pageToken?: string; pageSize: number; parentId?: string; includeFolders?: boolean }): Promise<{ files: DriveFile[]; nextPageToken: string | null }> {
    const q = [`trashed = false`, ...(o.includeFolders ? [] : [`mimeType != '${FOLDER_MIME}'`]), ...(o.parentId ? [`'${assertDriveId(o.parentId, 'folder')}' in parents`] : [])].join(' and ');
    const p = new URLSearchParams({ q, pageSize: String(Math.min(Math.max(o.pageSize, 1), 100)), fields: `nextPageToken,files(${FIELDS})`, orderBy: 'modifiedTime desc', spaces: 'drive' });
    if (o.pageToken) { if (!/^[\x21-\x7e]{1,2048}$/.test(o.pageToken)) throw new GoogleApiError('VALIDATION', 'Invalid page token'); p.set('pageToken', o.pageToken); }
    const { json } = await this.json(token, 'GET', `${this.base}/files?${p.toString()}`);
    const r = (json ?? {}) as { files?: unknown[]; nextPageToken?: unknown };
    return { files: (r.files ?? []).map(DriveClient.mapFile), nextPageToken: typeof r.nextPageToken === 'string' ? r.nextPageToken : null };
  }

  async findAppFolder(token: string, name: string): Promise<DriveFile | null> {
    const esc = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = `mimeType = '${FOLDER_MIME}' and trashed = false and name = '${esc}' and appProperties has { key='${APP_PROPERTY}' and value='root' }`;
    const { json } = await this.json(token, 'GET', `${this.base}/files?${new URLSearchParams({ q, pageSize: '1', fields: `files(${FIELDS})` }).toString()}`);
    const f = ((json as { files?: unknown[] } | null)?.files ?? [])[0];
    return f ? DriveClient.mapFile(f) : null;
  }

  async createFolder(token: string, name: string): Promise<DriveFile> {
    const { json } = await this.json(token, 'POST', `${this.base}/files?fields=${encodeURIComponent(FIELDS)}`, { body: { name, mimeType: FOLDER_MIME, appProperties: { [APP_PROPERTY]: 'root' } }, retry: retryRateOnly });
    return DriveClient.mapFile(json);
  }

  /**
   * Starts a resumable upload and returns the session URI.
   * NOTE (CHANGED): The browser should NOT PUT bytes to this URI directly — Google's resumable upload endpoint
   * does not reliably return CORS headers, causing "Network error" in the browser. The session URI should be
   * handed back to the backend, which calls `uploadToSession` below to push the file bytes server-to-server.
   */
  async startResumableUpload(token: string, o: { name: string; mimeType: string; sizeBytes: number; parentId: string; origin?: string }): Promise<{ sessionUri: string }> {
    if (this.cfg.maxFileBytes !== undefined && o.sizeBytes > this.cfg.maxFileBytes) throw new GoogleApiError('VALIDATION', 'File is larger than the allowed size');
    if (!Number.isInteger(o.sizeBytes) || o.sizeBytes < 0) throw new GoogleApiError('VALIDATION', 'Invalid file size');
    // CHANGED: `origin` is still forwarded for diagnostics, but we no longer rely on it for CORS success.
    const extra: Record<string, string> = { 'x-upload-content-type': o.mimeType, 'x-upload-content-length': String(o.sizeBytes), ...(o.origin ? { origin: o.origin } : {}) };
    const { headers } = await this.json(token, 'POST', `${this.upload}/files?uploadType=resumable&fields=${encodeURIComponent(FIELDS)}`, {
      body: { name: o.name, mimeType: o.mimeType, parents: [assertDriveId(o.parentId, 'folder')], appProperties: { [APP_PROPERTY]: '1' } }, extraHeaders: extra, retry: retryAll,
    });
    const loc = headers.get('location');
    if (!loc || !GOOGLE_HOST.test(loc)) throw new GoogleApiError('UNKNOWN', 'Google did not return a valid upload session');
    return { sessionUri: loc };
  }

  /**
   * NEW METHOD (CHANGED): Pushes the actual file bytes to a resumable upload session, server-to-server.
   * This avoids the browser CORS problem entirely because it is not a cross-origin request.
   * For small files (< 5 MB), a single PUT with the whole body is sufficient (Google allows this).
   * For larger files, chunked uploads with Content-Range headers would be needed; that can be added later
   * if the app starts uploading big videos.
   */
  async uploadToSession(
    sessionUri: string,
    body: Uint8Array,
    contentType: string,
  ): Promise<DriveFile> {
    // CHANGED: Validate the session URI host — never PUT to an arbitrary URL.
    if (!GOOGLE_HOST.test(sessionUri)) throw new GoogleApiError('VALIDATION', 'Invalid upload session URI');
    return withRetry(this.retry, retryAll, async () => {
      const { res, text } = await send(this.f, this.cfg.requestTimeoutMs, sessionUri, {
        method: 'PUT',
        headers: {
          'content-type': contentType,
          'content-length': String(body.byteLength),
        },
        body, // CHANGED: pass the actual Uint8Array to fetch; do not coerce binary data to a string.
      }); 
      if (res.status < 200 || res.status >= 300) {
        throw classify(res.status, parseJson(text), res.headers.get('retry-after'));
      }
      return DriveClient.mapFile(parseJson(text));
    });
  }

  async download(token: string, fileId: string): Promise<{ stream: AsyncIterable<Uint8Array>; contentLength: number | null; contentType: string | null }> {
    const url = `${this.base}/files/${assertDriveId(fileId)}?alt=media&supportsAllDrives=false`;
    const { res, text } = await withRetry(this.retry, retryAll, async () => {
      const r = await send(this.f, this.cfg.requestTimeoutMs, url, { method: 'GET', headers: { authorization: `Bearer ${token}` } }, { stream: true });
      if (r.res.status < 200 || r.res.status >= 300) throw classify(r.res.status, parseJson(r.text), r.res.headers.get('retry-after'));
      return r;
    });
    void text;
    if (!res.body) throw new GoogleApiError('UNKNOWN', 'Google returned no content stream');
    const cl = res.headers.get('content-length');
    return { stream: res.body, contentLength: cl && /^\d+$/.test(cl) ? Number(cl) : null, contentType: res.headers.get('content-type') };
  }

  async deleteFile(token: string, fileId: string): Promise<void> {
    try { await this.json(token, 'DELETE', `${this.base}/files/${assertDriveId(fileId)}?supportsAllDrives=false`); }
    catch (e) { if (e instanceof GoogleApiError && e.kind === 'NOT_FOUND') return; throw e; }
  }
}
type GFetchHeaders = { get(name: string): string | null };