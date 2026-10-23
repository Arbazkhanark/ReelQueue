import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { GoogleOAuthClient, DriveClient, GoogleApiError, pkceChallenge, newPkceVerifier, assertDriveId, type GFetch, type GFetchResponse } from '../src';

type Reply = { status?: number; body?: unknown; raw?: string; headers?: Record<string, string>; stream?: AsyncIterable<Uint8Array> };
interface Call { url: string; method: string; headers: Record<string, string>; body?: string | Uint8Array }
function fake(replies: Reply[]) {
  const calls: Call[] = [];
  const fetch: GFetch = async (url, init) => {
    calls.push({ url, method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}) });
    const r = replies.shift() ?? { status: 599 };
    const h = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    const res: GFetchResponse = { status: r.status ?? 200, headers: { get: (n) => h[n.toLowerCase()] ?? null }, text: async () => r.raw ?? (r.body === undefined ? '' : JSON.stringify(r.body)), ...(r.stream ? { body: r.stream } : {}) };
    return res;
  };
  return { fetch, calls };
}
const NOW = new Date('2026-10-22T10:00:00Z');
const cfg = { clientId: 'CLIENT_ID', clientSecret: 'CLIENT_SECRET_VALUE', redirectUri: 'https://reelqueue-api.example/v1/google-drive/callback', scopes: ['https://www.googleapis.com/auth/drive.file'], requestTimeoutMs: 100 };
const sleeps: number[] = []; const retry = { sleep: async (ms: number) => { sleeps.push(ms); }, random: () => 0.5, baseDelayMs: 100, maxDelayMs: 1000 };
const oauth = (f: ReturnType<typeof fake>) => new GoogleOAuthClient(cfg, { now: () => NOW, fetch: f.fetch, retry });
const drive = (f: ReturnType<typeof fake>, o: { maxFileBytes?: number } = {}) => new DriveClient({ requestTimeoutMs: 100, ...o }, { fetch: f.fetch, retry });
const ID1 = 'file_ID-0123456789', FOLDER = 'folderID-0123456789';

describe('GoogleOAuthClient (fake HTTP only; Google endpoints UNVERIFIED)', () => {
  it('authorization URL: exact redirect URI, minimal scope, offline + consent, PKCE S256, no secret', () => {
    const u = new URL(oauth(fake([])).buildAuthorizationUrl('STATE', pkceChallenge('verifier')));
    assert.equal(u.origin + u.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
    assert.deepEqual(Object.fromEntries(u.searchParams), { client_id: 'CLIENT_ID', redirect_uri: cfg.redirectUri, response_type: 'code', scope: 'https://www.googleapis.com/auth/drive.file', state: 'STATE', access_type: 'offline', prompt: 'consent', code_challenge: pkceChallenge('verifier'), code_challenge_method: 'S256' });
    assert.ok(!u.toString().includes('CLIENT_SECRET_VALUE'));
    assert.match(newPkceVerifier(), /^[A-Za-z0-9_-]{43}$/); assert.equal(pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'), 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM', 'RFC 7636 test vector');
  });
  it('code exchange: secret + verifier in the POST body (never the URL); parses tokens, expiry and granted scopes', async () => {
    const f = fake([{ body: { access_token: 'AT', refresh_token: 'RT', expires_in: 3599, scope: 'https://www.googleapis.com/auth/drive.file', token_type: 'Bearer' } }]);
    const t = await oauth(f).exchangeCode('CODE', 'VERIFIER');
    assert.deepEqual([t.accessToken, t.refreshToken, t.expiresAt.getTime() - NOW.getTime(), t.scopes], ['AT', 'RT', 3_599_000, ['https://www.googleapis.com/auth/drive.file']]);
    const c = f.calls[0]!; assert.equal(c.method, 'POST'); assert.equal(c.url, 'https://oauth2.googleapis.com/token');
    assert.deepEqual(Object.fromEntries(new URLSearchParams(c.body)), { code: 'CODE', client_id: 'CLIENT_ID', client_secret: 'CLIENT_SECRET_VALUE', redirect_uri: cfg.redirectUri, grant_type: 'authorization_code', code_verifier: 'VERIFIER' });
    assert.ok(!c.url.includes('CODE') && !c.url.includes('SECRET'));
  });
  it('refresh grant; invalid_grant -> AUTH_EXPIRED; missing refresh_token on refresh is fine', async () => {
    const f = fake([{ body: { access_token: 'AT2', expires_in: 3600 } }, { status: 400, body: { error: 'invalid_grant', error_description: 'Token has been expired or revoked. REFRESH_SECRET' } }]);
    const o = oauth(f); const t = await o.refresh('RT');
    assert.deepEqual([t.accessToken, t.refreshToken], ['AT2', null]);
    assert.deepEqual(Object.fromEntries(new URLSearchParams(f.calls[0]!.body)), { refresh_token: 'RT', client_id: 'CLIENT_ID', client_secret: 'CLIENT_SECRET_VALUE', grant_type: 'refresh_token' });
    await assert.rejects(o.refresh('RT'), (e) => e instanceof GoogleApiError && e.kind === 'AUTH_EXPIRED' && !/REFRESH_SECRET|RT/.test(e.message));
  });
  it('transient 5xx / 429 are retried with backoff and Retry-After; success after retry; gives up after maxRetries', async () => {
    sleeps.length = 0;
    const f = fake([{ status: 503 }, { status: 429, headers: { 'retry-after': '2' } }, { body: { access_token: 'AT', expires_in: 10 } }]);
    assert.equal((await oauth(f).refresh('RT')).accessToken, 'AT'); assert.equal(f.calls.length, 3); assert.deepEqual(sleeps, [50, 1000]); // jitter 0.5*100, then Retry-After 2s capped at maxDelay
    const g = fake([{ status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);
    await assert.rejects(oauth(g).refresh('RT'), (e) => e instanceof GoogleApiError && e.kind === 'UNAVAILABLE'); assert.equal(g.calls.length, 4);
  });
  it('rejects unreadable/short responses and treats network failure as UNAVAILABLE; revoke tolerates empty body and already-invalid tokens', async () => {
    await assert.rejects(oauth(fake([{ body: { access_token: 'x' } }])).exchangeCode('c', 'v'), (e) => e instanceof GoogleApiError && e.kind === 'UNKNOWN');
    const boom: GFetch = async () => { throw new Error('ECONNRESET with SECRET'); };
    await assert.rejects(new GoogleOAuthClient(cfg, { now: () => NOW, fetch: boom, retry: { ...retry, maxRetries: 0 } }).refresh('RT'), (e) => e instanceof GoogleApiError && e.kind === 'UNAVAILABLE' && !/SECRET/.test(e.message));
    const f = fake([{ status: 200, raw: '' }, { status: 400, body: { error: 'invalid_token' } }, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 }]);
    const o = oauth(f); await o.revoke('RT'); await o.revoke('RT');
    assert.equal(f.calls[0]!.url, 'https://oauth2.googleapis.com/revoke'); assert.deepEqual(Object.fromEntries(new URLSearchParams(f.calls[0]!.body)), { token: 'RT' });
    await assert.rejects(o.revoke('RT'), (e) => e instanceof GoogleApiError && e.kind === 'UNAVAILABLE');
  });
});

describe('DriveClient (fake HTTP only; Drive behaviour UNVERIFIED)', () => {
  it('maps file metadata (size string -> number, folder flag, app-created flag) and rejects malformed ids before any request', async () => {
    const f = fake([{ body: { id: ID1, name: 'a.mp4', mimeType: 'video/mp4', size: '1048576', modifiedTime: '2026-10-01T00:00:00Z', createdTime: '2026-09-01T00:00:00Z', md5Checksum: 'abc', parents: [FOLDER], appProperties: { reelqueue: '1' } } }]);
    const m = await drive(f).getFile('TOKEN', ID1);
    assert.deepEqual([m.sizeBytes, m.isFolder, m.createdByApp, m.parents, m.trashed], [1_048_576, false, true, [FOLDER], false]);
    assert.equal(f.calls[0]!.headers.authorization, 'Bearer TOKEN'); assert.match(f.calls[0]!.url, /\/files\/file_ID-0123456789\?fields=/);
    const g = fake([]); const d = drive(g);
    for (const bad of ["x' or '1'='1", '../../etc', 'a/b', 'short', `${ID1}?alt=media`]) { await assert.rejects(d.getFile('T', bad), (e) => e instanceof GoogleApiError && e.kind === 'VALIDATION'); assert.throws(() => assertDriveId(bad)); }
    assert.equal(g.calls.length, 0, 'nothing was sent');
  });
  it('exists(): true / false on 404 or trashed; other errors propagate', async () => {
    const f = fake([{ body: { id: ID1, name: 'a', mimeType: 'x' } }, { status: 404, body: { error: { errors: [{ reason: 'notFound' }] } } }, { body: { id: ID1, name: 'a', mimeType: 'x', trashed: true } }, { status: 403, body: { error: { errors: [{ reason: 'forbidden' }] } } }]);
    const d = drive(f);
    assert.equal(await d.exists('T', ID1), true); assert.equal(await d.exists('T', ID1), false); assert.equal(await d.exists('T', ID1), false);
    await assert.rejects(d.exists('T', ID1), (e) => e instanceof GoogleApiError && e.kind === 'PERMISSION');
  });
  it('list: excludes trashed + folders, scopes to a folder, pages with tokens, clamps page size, validates tokens', async () => {
    const f = fake([{ body: { files: [{ id: ID1, name: 'a', mimeType: 'video/mp4', size: '5' }], nextPageToken: 'NEXT_1' } }, { body: { files: [] } }]);
    const d = drive(f);
    const p1 = await d.listFiles('T', { pageSize: 1000, parentId: FOLDER }); assert.deepEqual([p1.files.length, p1.nextPageToken], [1, 'NEXT_1']);
    const u1 = new URL(f.calls[0]!.url); assert.equal(u1.searchParams.get('pageSize'), '100');
    assert.equal(u1.searchParams.get('q'), `trashed = false and mimeType != 'application/vnd.google-apps.folder' and '${FOLDER}' in parents`);
    const p2 = await d.listFiles('T', { pageSize: 10, pageToken: p1.nextPageToken! }); assert.equal(p2.nextPageToken, null);
    assert.equal(new URL(f.calls[1]!.url).searchParams.get('pageToken'), 'NEXT_1');
    await assert.rejects(d.listFiles('T', { pageSize: 10, pageToken: 'bad token with spaces' }), (e) => e instanceof GoogleApiError && e.kind === 'VALIDATION');
  });
  it('folder: finds by app property; creation is NOT retried on 5xx (no duplicate folders) but is on rate limits', async () => {
    const f = fake([{ body: { files: [] } }, { status: 500 }]);
    const d = drive(f); assert.equal(await d.findAppFolder('T', "Reel'Queue"), null);
    assert.match(new URL(f.calls[0]!.url).searchParams.get('q')!, /name = 'Reel\\'Queue' and appProperties has \{ key='reelqueue' and value='root' \}/);
    await assert.rejects(d.createFolder('T', 'ReelQueue'), (e) => e instanceof GoogleApiError && e.kind === 'UNAVAILABLE'); assert.equal(f.calls.length, 2, 'single attempt');
    const g = fake([{ status: 429 }, { body: { id: FOLDER, name: 'ReelQueue', mimeType: 'application/vnd.google-apps.folder' } }]);
    assert.equal((await drive(g).createFolder('T', 'ReelQueue')).isFolder, true); assert.equal(g.calls.length, 2);
    assert.deepEqual(JSON.parse(g.calls[1]!.body!).appProperties, { reelqueue: 'root' });
  });
  it('resumable upload: metadata + headers, parent folder, app property, size limit, Location must be a Google URL', async () => {
    const loc = 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=SESSION';
    const f = fake([{ headers: { Location: loc }, body: {} }, { headers: { Location: 'https://evil.example/steal' }, body: {} }, { body: {} }]);
    const d = drive(f, { maxFileBytes: 1000 });
    assert.deepEqual(await d.startResumableUpload('T', { name: 'clip.mp4', mimeType: 'video/mp4', sizeBytes: 900, parentId: FOLDER, origin: 'https://app.example.com' }), { sessionUri: loc });
    const c = f.calls[0]!; assert.equal(c.method, 'POST');
    assert.deepEqual([c.headers['x-upload-content-type'], c.headers['x-upload-content-length'], c.headers.origin], ['video/mp4', '900', 'https://app.example.com']);
    assert.deepEqual(JSON.parse(c.body!), { name: 'clip.mp4', mimeType: 'video/mp4', parents: [FOLDER], appProperties: { reelqueue: '1' } });
    await assert.rejects(d.startResumableUpload('T', { name: 'a', mimeType: 'video/mp4', sizeBytes: 10, parentId: FOLDER }), /valid upload session/);
    await assert.rejects(d.startResumableUpload('T', { name: 'a', mimeType: 'video/mp4', sizeBytes: 10, parentId: FOLDER }), /valid upload session/, 'missing Location');
    await assert.rejects(d.startResumableUpload('T', { name: 'a', mimeType: 'video/mp4', sizeBytes: 1001, parentId: FOLDER }), (e) => e instanceof GoogleApiError && e.kind === 'VALIDATION');
  });
  it('download streams lazily: no chunk is pulled by the client, content-length comes from headers, errors never expose the token', async () => {
    let pulled = 0;
    async function* body() { for (let i = 0; i < 1000; i++) { pulled++; yield new Uint8Array(1024); } }
    const f = fake([{ headers: { 'content-length': '1024000', 'content-type': 'video/mp4' }, stream: body() }, { status: 403, body: { error: { errors: [{ reason: 'downloadQuotaExceeded' }], message: 'secret TOKEN123' } } }]);
    const d = drive(f); const r = await d.download('TOKEN123', ID1);
    assert.equal(pulled, 0, 'nothing was buffered by the client'); assert.deepEqual([r.contentLength, r.contentType], [1_024_000, 'video/mp4']);
    let n = 0; for await (const chunk of r.stream) { n += chunk.length; if (n >= 2048) break; } assert.equal(pulled, 2, 'consumers pull chunk by chunk');
    await assert.rejects(d.download('TOKEN123', ID1), (e) => e instanceof GoogleApiError && e.kind === 'PERMISSION' && !/TOKEN123|secret/.test(e.message));
  });
  it('error classification: 401, rate-limit 403, storage full, 404, 5xx; rate limits retried then surfaced; delete is idempotent', async () => {
    const mk = (status: number, reason?: string, headers: Record<string, string> = {}) => ({ status, headers, body: reason ? { error: { errors: [{ reason }] } } : {} });
    const kinds: [Reply, string][] = [[mk(401), 'AUTH_EXPIRED'], [mk(403, 'userRateLimitExceeded'), 'RATE_LIMITED'], [mk(403, 'storageQuotaExceeded'), 'STORAGE_FULL'], [mk(403, 'insufficientFilePermissions'), 'PERMISSION'], [mk(404), 'NOT_FOUND'], [mk(400), 'VALIDATION']];
    for (const [r, kind] of kinds) {
      await assert.rejects(new DriveClient({ requestTimeoutMs: 100 }, { fetch: fake([r]).fetch, retry: { ...retry, maxRetries: 0 } }).getFile('T', ID1), (e) => e instanceof GoogleApiError && e.kind === kind, kind);
    }
    sleeps.length = 0; const f = fake([mk(429, undefined, { 'retry-after': '1' }), mk(429), mk(429), mk(429)]);
    await assert.rejects(drive(f).getFile('T', ID1), (e) => e instanceof GoogleApiError && e.kind === 'RATE_LIMITED'); assert.equal(f.calls.length, 4); assert.equal(sleeps[0], 1000);
    const g = fake([{ status: 404 }, { status: 204 }]); const d = drive(g); await d.deleteFile('T', ID1); await d.deleteFile('T', ID1); assert.equal(g.calls[0]!.method, 'DELETE');
    const to: GFetch = (_u, init) => new Promise((_res, rej) => { init.signal?.addEventListener('abort', () => rej(new Error('aborted'))); });
    await assert.rejects(new DriveClient({ requestTimeoutMs: 20 }, { fetch: to, retry: { ...retry, maxRetries: 0 } }).getFile('T', ID1), (e) => e instanceof GoogleApiError && e.kind === 'UNAVAILABLE');
  });
});