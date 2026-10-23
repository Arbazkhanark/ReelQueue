import { classify, defaultFetch, DEFAULT_RETRY, GoogleApiError, parseJson, send, withRetry, type GFetch, type RetryOptions } from './common';

/**
 * Google Drive API v3 client: only the operations ReelQueue's storage lifecycle needs. Written from Drive's public REST
 * documentation as known to the author; NEVER exercised against Google from this workspace (UNVERIFIED, docs/GOOGLE_DRIVE.md).
 * The caller passes a valid access token per call (token refresh lives in the service layer).
 */
export interface DriveClientConfig { requestTimeoutMs: number; maxFileBytes?: number; baseUrl?: string; uploadUrl?: string }
export interface DriveFile {
  id: string; name: string; mimeType: string; sizeBytes: number | null; createdTime: string | null; modifiedTime: string | null;
  md5Checksum: string | null; parents: string[]; trashed: boolean; isFolder: boolean; createdByApp: boolean;
}
export const FOLDER_MIME = 'application/vnd.google-apps.folder';
/** Property stamped on everything ReelQueue creates, so deletes can be limited to files this app manages. */
export const APP_PROPERTY = 'reelqueue';
const FIELDS = 'id,name,mimeType,size,createdTime,modifiedTime,md5Checksum,parents,trashed,appProperties';
const ID = /^[A-Za-z0-9_-]{10,128}$/;

/** Drive ids are interpolated into URLs and queries: only this alphabet is ever accepted. */
export function assertDriveId(id: string, what = 'file'): string {
  if (!ID.test(id)) throw new GoogleApiError('VALIDATION', `Invalid Drive ${what} id`);
  return id;
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
    };
  }

  /** The user's stable Drive identifier (permissionId). Used only to detect "a different Google account was connected". */
  async aboutUser(token: string): Promise<{ permissionId: string | null }> {
    const { json } = await this.json(token, 'GET', `${this.base}/about?fields=${encodeURIComponent('user(permissionId)')}`);
    const id = (json as { user?: { permissionId?: unknown } } | null)?.user?.permissionId;
    return { permissionId: typeof id === 'string' ? id : null };
  }

  async getFile(token: string, fileId: string): Promise<DriveFile> {
    const { json } = await this.json(token, 'GET', `${this.base}/files/${assertDriveId(fileId)}?fields=${encodeURIComponent(FIELDS)}&supportsAllDrives=false`);
    return DriveClient.mapFile(json);
  }
  /** "Exists or is accessible": false for missing OR not accessible to this token (Drive answers 404 for both); trashed files count as gone. */
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

  /** Finds the app folder created earlier by this app (by the app property, not only the name). */
  async findAppFolder(token: string, name: string): Promise<DriveFile | null> {
    const esc = name.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
    const q = `mimeType = '${FOLDER_MIME}' and trashed = false and name = '${esc}' and appProperties has { key='${APP_PROPERTY}' and value='root' }`;
    const { json } = await this.json(token, 'GET', `${this.base}/files?${new URLSearchParams({ q, pageSize: '1', fields: `files(${FIELDS})` }).toString()}`);
    const f = ((json as { files?: unknown[] } | null)?.files ?? [])[0];
    return f ? DriveClient.mapFile(f) : null;
  }
  /** Not retried on 5xx/timeouts (a retry could create a duplicate folder); retried only when Google says "slow down". */
  async createFolder(token: string, name: string): Promise<DriveFile> {
    const { json } = await this.json(token, 'POST', `${this.base}/files?fields=${encodeURIComponent(FIELDS)}`, { body: { name, mimeType: FOLDER_MIME, appProperties: { [APP_PROPERTY]: 'root' } }, retry: retryRateOnly });
    return DriveClient.mapFile(json);
  }

  /**
   * Starts a resumable upload and returns the session URI. The file bytes never pass through this server: the browser (or any
   * client) PUTs them to the session URI, in chunks, and can resume after an interruption. `origin` is the web origin, sent so
   * Google can answer the browser's cross-origin requests (UNVERIFIED behaviour; see docs).
   */
  async startResumableUpload(token: string, o: { name: string; mimeType: string; sizeBytes: number; parentId: string; origin?: string }): Promise<{ sessionUri: string }> {
    if (this.cfg.maxFileBytes !== undefined && o.sizeBytes > this.cfg.maxFileBytes) throw new GoogleApiError('VALIDATION', 'File is larger than the allowed size');
    if (!Number.isInteger(o.sizeBytes) || o.sizeBytes < 0) throw new GoogleApiError('VALIDATION', 'Invalid file size');
    const extra: Record<string, string> = { 'x-upload-content-type': o.mimeType, 'x-upload-content-length': String(o.sizeBytes), ...(o.origin ? { origin: o.origin } : {}) };
    const { headers } = await this.json(token, 'POST', `${this.upload}/files?uploadType=resumable&fields=${encodeURIComponent(FIELDS)}`, {
      body: { name: o.name, mimeType: o.mimeType, parents: [assertDriveId(o.parentId, 'folder')], appProperties: { [APP_PROPERTY]: '1' } }, extraHeaders: extra, retry: retryAll,
    });
    const loc = headers.get('location');
    if (!loc || !GOOGLE_HOST.test(loc)) throw new GoogleApiError('UNKNOWN', 'Google did not return a valid upload session');
    return { sessionUri: loc };
  }

  /** Streams the file content. The returned body is never buffered here; the caller must consume or abandon it. Native Google documents (Docs, Sheets) cannot be downloaded this way. */
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

  /** Idempotent: a file that is already gone counts as deleted. */
  async deleteFile(token: string, fileId: string): Promise<void> {
    try { await this.json(token, 'DELETE', `${this.base}/files/${assertDriveId(fileId)}?supportsAllDrives=false`); }
    catch (e) { if (e instanceof GoogleApiError && e.kind === 'NOT_FOUND') return; throw e; }
  }
}
type GFetchHeaders = { get(name: string): string | null };