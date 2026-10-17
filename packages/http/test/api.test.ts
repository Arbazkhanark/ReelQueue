import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, MB, PW, WEB_ORIGIN, startStack, signedInUser, type Stack } from './helpers/stack';
import { T0, MIN } from '../../services/test/helpers/sim';

let st: Stack | null;
before(async () => { st = await startStack(); });
after(() => st?.close());

/** init + PUT (simulated) + complete. Returns video ids. */
async function uploadVideos(c: Client, names: string[], sizeMb = 10): Promise<string[]> {
  const init = await c.post('/v1/uploads/init', { files: names.map((n) => ({ filename: n, contentType: 'video/mp4', sizeBytes: sizeMb * MB })) });
  assert.equal(init.status, 200, JSON.stringify(init.body));
  for (const t of init.body.targets) {
    const key = (await st!.pool.executor().query(`SELECT storage_key FROM videos WHERE id = $1`, [t.videoId]))[0]!.storage_key as string;
    st!.storage.put(key, sizeMb * MB);
  }
  const done = await c.post(`/v1/uploads/${init.body.batchId}/complete`, { uploaded: init.body.targets.map((t: { videoId: string }) => t.videoId) });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.ok(done.body.videos.every((v: { status: string }) => v.status === 'READY'));
  return init.body.targets.map((t: { videoId: string }) => t.videoId);
}
/** Advances virtual time by `min` minutes FROM NOW (the clock is shared across tests) and refreshes the sessions like a browser would. */
async function adv(min: number, ...clients: Client[]): Promise<void> {
  await st!.sim.advance(Math.ceil((st!.sim.clock.now().getTime() - T0.getTime()) / MIN) + min);
  for (const c of clients) assert.equal((await c.post('/v1/auth/refresh')).status, 200);
}
const skip = (t: { skip: (m: string) => void }) => { if (!st) { t.skip('no PostgreSQL'); return true; } return false; };

describe('HTTP API (real server, real PostgreSQL, mock Instagram, virtual time)', () => {
  it('health, unknown routes, wrong methods, malformed/oversized/non-JSON bodies', async (t) => {
    if (skip(t)) return;
    const c = new Client(st!.url);
    assert.deepEqual((await c.get('/health/live')).body, { status: 'ok' });
    assert.deepEqual((await c.get('/health/ready')).body, { status: 'ok', database: 'up', redis: 'up' });
    const nf = await c.get('/v1/nope');
    assert.equal(nf.status, 404); assert.equal(nf.body.error.code, 'NOT_FOUND'); assert.match(nf.body.error.requestId, /^[0-9a-f-]{36}$/);
    const mm = await c.req('DELETE', '/v1/auth/login');
    assert.equal(mm.status, 405); assert.equal(mm.headers.get('allow'), 'POST');
    assert.equal((await c.req('POST', '/v1/auth/login', '{not json', { 'content-type': 'application/json' })).status, 400);
    const ct = await fetch(`${st!.url}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' });
    assert.equal(ct.status, 415);
    assert.equal((await c.req('POST', '/v1/auth/login', { email: 'a@b.co', password: 'x'.repeat(70_000) })).status, 413);
    for (const h of ['x-content-type-options', 'cache-control', 'x-frame-options', 'strict-transport-security', 'referrer-policy']) assert.ok(nf.headers.get(h), h);
  });

  it('auth: register is enumeration-safe, cookies are hardened, verify gate, me, refresh rotation, logout', async (t) => {
    if (skip(t)) return;
    const c = new Client(st!.url);
    const r1 = await c.post('/v1/auth/register', { email: 'Auth1@Example.test', password: PW });
    const r2 = await c.post('/v1/auth/register', { email: 'auth1@example.test', password: PW });
    assert.deepEqual([r1.status, r1.body], [202, { status: 'VERIFICATION_SENT' }]);
    assert.deepEqual([r2.status, r2.body], [202, { status: 'VERIFICATION_SENT' }], 'taken address looks identical');
    assert.equal((await c.post('/v1/auth/login', { email: 'auth1@example.test', password: PW })).body.error.code, 'EMAIL_NOT_VERIFIED');
    await c.post('/v1/auth/verify-email', { token: st!.mails.filter((m) => m.to === 'auth1@example.test').pop()!.token });
    const login = await c.post('/v1/auth/login', { email: 'auth1@example.test', password: PW });
    assert.equal(login.status, 200); assert.equal(login.body.user.email, 'auth1@example.test'); assert.equal(login.body.user.emailVerified, true);
    assert.ok(!JSON.stringify(login.body).includes('password'), 'no hash in responses');
    const [at, rt] = login.setCookies;
    assert.match(at!, /^rq_at=.+; Path=\/; Max-Age=900; HttpOnly; Secure; SameSite=Lax$/);
    assert.match(rt!, /^rq_rt=.+; Path=\/v1\/auth; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
    assert.equal((await c.get('/v1/me')).body.email, 'auth1@example.test');

    st!.sim.clock.advanceMs(16 * 60_000); // access token expired
    assert.equal((await c.get('/v1/me')).status, 401);
    const old = c.jar.get('rq_rt')!;
    const ref = await c.post('/v1/auth/refresh');
    assert.equal(ref.status, 200); assert.notEqual(c.jar.get('rq_rt'), old);
    assert.equal((await c.get('/v1/me')).status, 200);
    // replaying the rotated-away token (outside the grace window) is theft: the family dies and the cookie is cleared
    st!.sim.clock.advanceMs(60_000);
    const thief = new Client(st!.url); thief.jar.set('rq_rt', old);
    const stolen = await thief.post('/v1/auth/refresh');
    assert.equal(stolen.status, 401); assert.ok(stolen.setCookies.some((x) => x.startsWith('rq_rt=;')));
    assert.equal((await c.post('/v1/auth/refresh')).status, 401, 'victim session was revoked too');
    const again = await c.post('/v1/auth/login', { email: 'auth1@example.test', password: PW });
    assert.equal(again.status, 200);
    assert.equal((await c.post('/v1/auth/logout')).status, 204);
    assert.equal((await c.get('/v1/me')).status, 401);
    assert.equal((await new Client(st!.url).post('/v1/auth/refresh')).status, 401);
  });

  it('unauthenticated and tampered requests are refused on every protected route', async (t) => {
    if (skip(t)) return;
    const c = new Client(st!.url);
    for (const [m, p] of [['GET', '/v1/me'], ['GET', '/v1/videos'], ['GET', '/v1/dashboard'], ['POST', '/v1/cycles'], ['GET', '/v1/jobs'], ['POST', '/v1/uploads/init'], ['GET', '/v1/storage'], ['GET', '/v1/settings'], ['GET', '/v1/instagram/accounts']] as const) {
      const r = await c.req(m, p, m === 'POST' ? {} : undefined);
      assert.equal(r.status, 401, `${m} ${p}`); assert.equal(r.body.error.code, 'UNAUTHENTICATED');
    }
    const u = await signedInUser(st!);
    const tampered = new Client(st!.url); tampered.jar.set('rq_at', u.c.jar.get('rq_at')!.slice(0, -3) + 'abc');
    assert.equal((await tampered.get('/v1/me')).status, 401);
  });

  it('validation: field-level details, ignored unknown fields, malformed ids are 404, no internals leak', async (t) => {
    if (skip(t)) return;
    const c = new Client(st!.url);
    const bad = await c.post('/v1/auth/register', { email: 'nope', password: 'short' });
    assert.equal(bad.status, 400); assert.equal(bad.body.error.code, 'VALIDATION_FAILED');
    assert.ok(bad.body.error.details.some((d: { field: string }) => d.field === 'email') && bad.body.error.details.some((d: { field: string }) => d.field === 'password'));
    assert.equal((await c.post('/v1/auth/register', { email: 'x@y.zz', password: 12345 })).body.error.details[0].field, 'password');
    const reg = await c.post('/v1/auth/register', { email: 'mass@example.test', password: PW, role: 'ADMIN', status: 'ACTIVE', emailVerified: true });
    assert.equal(reg.status, 202);
    const row = (await st!.pool.executor().query(`SELECT role, email_verified_at FROM users WHERE email = 'mass@example.test'`))[0]!;
    assert.deepEqual([row.role, row.email_verified_at], ['USER', null], 'mass-assignment is impossible');
    const u = await signedInUser(st!);
    assert.equal((await u.c.del('/v1/videos/not-a-uuid')).status, 404);
    assert.equal((await u.c.get('/v1/jobs?status=BOGUS')).body.error.code, 'VALIDATION_FAILED');
    assert.equal((await u.c.get('/v1/jobs?pageSize=1000')).status, 400);
    assert.equal((await u.c.patch('/v1/settings', { batchSize: 999 })).body.error.details[0].field, 'batchSize');
    assert.equal((await u.c.patch('/v1/settings', { intervalMinutes: 1 })).status, 400);
    assert.equal((await u.c.patch('/v1/settings', { timezone: 'Mars/Olympus' })).status, 400);
    assert.ok(!JSON.stringify(bad.body).match(/at .*\.ts|node_modules|SELECT |Error:/), 'no stack traces or SQL');
  });

  it('settings: defaults (20-minute interval, 24 h, batch 1), update, bounds, defaults feed cycle start', async (t) => {
    if (skip(t)) return;
    const u = await signedInUser(st!);
    const s = (await u.c.get('/v1/settings')).body;
    assert.deepEqual([s.batchSize, s.intervalMinutes, s.cycleDurationHours, s.loopEnabled], [1, 20, 24, false]);
    assert.deepEqual(s.limits.intervalMinutes, { min: 5, max: 1440 });
    const up = await u.c.patch('/v1/settings', { batchSize: 3, intervalMinutes: 30, loopEnabled: true, timezone: 'Asia/Kolkata' });
    assert.deepEqual([up.body.batchSize, up.body.intervalMinutes, up.body.loopEnabled, up.body.timezone], [3, 30, true, 'Asia/Kolkata']);
    assert.equal((await u.c.get('/v1/settings')).body.intervalMinutes, 30);
  });

  it('FULL JOURNEY: connect mock account -> upload -> start cycle -> scheduler publishes SIMULATED (never "published") -> pause/resume/stop', async (t) => {
    if (skip(t)) return;
    const u = await signedInUser(st!);
    const acc = await u.c.post('/v1/instagram/mock-connect', { username: 'demo_account' });
    assert.equal(acc.status, 201); assert.equal(acc.body.isMock, true); assert.equal(acc.body.provider, 'MOCK');
    assert.ok(!JSON.stringify(acc.body).match(/access_token|accessToken|token_enc|mock:no-token|v1:/), 'no token material in account DTOs');
    assert.equal((await u.c.post('/v1/cycles', { instagramAccountId: acc.body.id })).body.error.code, 'QUEUE_EMPTY');

    const ids = await uploadVideos(u.c, ['a.mp4', 'b.mp4', 'c.mp4', 'd.mp4', 'e.mp4']);
    const list = await u.c.get('/v1/videos');
    assert.deepEqual(list.body.items.map((v: { filename: string; position: number }) => [v.filename, v.position]), [['a.mp4', 0], ['b.mp4', 1], ['c.mp4', 2], ['d.mp4', 3], ['e.mp4', 4]]);
    assert.equal(list.body.total, 5);
    assert.deepEqual([(await u.c.get('/v1/storage')).body.bytesUsed, (await u.c.get('/v1/storage')).body.videoCount], [50 * MB, 5]);

    const start = await u.c.post('/v1/cycles', { instagramAccountId: acc.body.id, batchSize: 2, intervalMinutes: 20, durationHours: 24 });
    assert.equal(start.status, 201, JSON.stringify(start.body));
    const cyc = start.body;
    assert.deepEqual([cyc.status, cyc.batchSize, cyc.intervalMinutes, cyc.isMock, cyc.loopEnabled], ['ACTIVE', 2, 20, true, false]);
    assert.ok(cyc.warnings.some((w: { code: string }) => w.code === 'MOCK_MODE'));
    assert.equal(Date.parse(cyc.endsAt) - Date.parse(cyc.startedAt), 24 * 3600_000);
    assert.equal((await u.c.post('/v1/cycles', { instagramAccountId: acc.body.id })).body.error.code, 'CYCLE_ALREADY_ACTIVE');
    assert.equal((await u.c.get('/v1/cycles/current')).body.id, cyc.id);

    await adv(25, u.c); // first batch at t0, second at t+20
    const jobs = (await u.c.get(`/v1/jobs?cycleId=${cyc.id}&pageSize=50`)).body;
    assert.equal(jobs.total, 4, 'two batches of two');
    assert.ok(jobs.items.every((j: { status: string; isMock: boolean }) => j.status === 'SIMULATED' && j.isMock), 'mock output is SIMULATED and flagged, never ACCEPTED/CONFIRMED');
    const dash = (await u.c.get('/v1/dashboard')).body;
    assert.deepEqual([dash.totals.simulated, dash.totals.published, dash.mockMode], [4, 0, true]);
    assert.equal(dash.currentCycle.counts.simulated, 4); assert.equal(dash.currentCycle.counts.queued, 1);
    assert.equal(st!.sim.provider.publications.length, 4);

    const paused = await u.c.post(`/v1/cycles/${cyc.id}/pause`);
    assert.deepEqual([paused.status, paused.body.status, paused.body.pauseReason], [200, 'PAUSED', 'USER']);
    assert.equal((await u.c.post(`/v1/cycles/${cyc.id}/pause`)).body.error.code, 'CYCLE_NOT_ACTIVE');
    await adv(70, u.c);
    assert.equal(st!.sim.provider.publications.length, 4, 'nothing publishes while paused');
    assert.equal((await u.c.post(`/v1/cycles/${cyc.id}/resume`)).body.status, 'ACTIVE');
    assert.equal((await u.c.patch(`/v1/cycles/${cyc.id}`, { loopEnabled: true })).body.loopEnabled, true);
    await adv(100, u.c);
    assert.ok(st!.sim.provider.publications.length >= 5, 'resumed and looping');
    const stopped = await u.c.post(`/v1/cycles/${cyc.id}/stop`);
    assert.deepEqual([stopped.body.status, stopped.body.endReason], ['STOPPED', 'USER_STOPPED']);
    const frozen = st!.sim.provider.publications.length;
    await adv(300, u.c);
    assert.equal(st!.sim.provider.publications.length, frozen, 'nothing publishes after stop');
    assert.equal((await u.c.get('/v1/cycles/current')).body, null);
    assert.equal((await u.c.get('/v1/cycles')).body.total, 1);
    assert.equal((await u.c.get('/v1/jobs/upcoming')).body.length, 0);
    assert.ok(ids.length === 5);
  });

  it('cycle start validates settings, account state and ownership', async (t) => {
    if (skip(t)) return;
    const u = await signedInUser(st!); const other = await signedInUser(st!);
    const acc = (await u.c.post('/v1/instagram/mock-connect', { username: 'acc1' })).body;
    await uploadVideos(u.c, ['x.mp4']);
    assert.equal((await u.c.post('/v1/cycles', { instagramAccountId: acc.id, batchSize: 0 })).body.error.details[0].field, 'batchSize');
    assert.equal((await u.c.post('/v1/cycles', { instagramAccountId: acc.id, intervalMinutes: 4 })).status, 400);
    assert.equal((await u.c.post('/v1/cycles', { instagramAccountId: acc.id, durationHours: 500 })).body.error.details[0].field, 'durationHours');
    assert.equal((await u.c.post('/v1/cycles', { instagramAccountId: '00000000-0000-4000-8000-000000000000' })).status, 404);
    assert.equal((await other.c.post('/v1/cycles', { instagramAccountId: acc.id })).status, 404, "another tenant's account looks nonexistent");
    st!.sim.provider.eligibility = { eligible: false, reason: 'NOT_PROFESSIONAL_ACCOUNT', message: 'Switch to a professional account.' };
    const inel = await u.c.post('/v1/cycles', { instagramAccountId: acc.id });
    assert.deepEqual([inel.status, inel.body.error.code], [422, 'INSTAGRAM_ACCOUNT_INELIGIBLE']);
    st!.sim.provider.eligibility = { eligible: true };
    const disc = await u.c.post(`/v1/instagram/accounts/${acc.id}/disconnect`);
    assert.equal(disc.body.status, 'DISCONNECTED');
    assert.equal((await u.c.post('/v1/cycles', { instagramAccountId: acc.id })).body.error.code, 'INSTAGRAM_NOT_CONNECTED');
    assert.equal((await u.c.get('/v1/instagram/accounts')).body.length, 0);
  });

  it('TENANT ISOLATION: every resource id of another user behaves as nonexistent, and nothing leaks into lists', async (t) => {
    if (skip(t)) return;
    const a = await signedInUser(st!); const b = await signedInUser(st!);
    const acc = (await a.c.post('/v1/instagram/mock-connect', { username: 'owner_a' })).body;
    const [vid] = await uploadVideos(a.c, ['secret.mp4']);
    const init = await a.c.post('/v1/uploads/init', { files: [{ filename: 'pending.mp4', contentType: 'video/mp4', sizeBytes: MB }] });
    const cyc = (await a.c.post('/v1/cycles', { instagramAccountId: acc.id, batchSize: 1 })).body;
    await adv(5, a.c, b.c);
    const job = (await a.c.get('/v1/jobs')).body.items[0];
    assert.ok(job);

    const attempts: [string, string, unknown?][] = [
      ['GET', `/v1/videos/${vid}/preview`], ['DELETE', `/v1/videos/${vid}`], ['PATCH', `/v1/videos/${vid}`, { caption: 'pwned' }],
      ['POST', `/v1/uploads/${init.body.batchId}/complete`, { uploaded: [init.body.targets[0].videoId] }],
      ['POST', `/v1/cycles/${cyc.id}/pause`], ['POST', `/v1/cycles/${cyc.id}/resume`], ['POST', `/v1/cycles/${cyc.id}/stop`], ['PATCH', `/v1/cycles/${cyc.id}`, { loopEnabled: true }],
      ['POST', `/v1/jobs/${job.id}/retry`], ['POST', `/v1/instagram/accounts/${acc.id}/disconnect`], ['POST', `/v1/instagram/accounts/${acc.id}/refresh-quota`],
      ['POST', '/v1/cycles', { instagramAccountId: acc.id }], ['PATCH', '/v1/settings', { defaultInstagramAccountId: acc.id }],
    ];
    for (const [m, p, body] of attempts) {
      const r = await b.c.req(m, p, body ?? (m === 'POST' || m === 'PATCH' ? {} : undefined));
      assert.equal(r.status, 404, `${m} ${p} -> ${r.status} ${JSON.stringify(r.body)}`);
      assert.equal(r.body.error.code, 'NOT_FOUND');
    }
    assert.equal((await b.c.put('/v1/videos/order', { videoIds: [vid] })).status, 400, 'cannot reorder a stranger\'s video');
    for (const p of ['/v1/videos', '/v1/jobs', '/v1/cycles', '/v1/jobs/upcoming', '/v1/instagram/accounts']) {
      const r = (await b.c.get(p)).body;
      assert.deepEqual(Array.isArray(r) ? r : r.items, [], p);
    }
    assert.equal((await b.c.get(`/v1/jobs?cycleId=${cyc.id}`)).body.total, 0);
    assert.equal((await b.c.get('/v1/cycles/current')).body, null);
    const d = (await b.c.get('/v1/dashboard')).body;
    assert.deepEqual([d.totals, d.storage.videoCount, d.accounts.length], [{ readyVideos: 0, published: 0, simulated: 0, failed: 0 }, 0, 0]);
    // and A is untouched
    assert.equal((await a.c.get('/v1/videos')).body.items[0].caption, null);
    assert.equal((await a.c.get('/v1/cycles/current')).body.status, 'ACTIVE');
  });

  it('videos: caption, preview (READY only), reorder, delete rules (in-use blocks), quota feedback', async (t) => {
    if (skip(t)) return;
    const u = await signedInUser(st!);
    const [v1, v2, v3] = await uploadVideos(u.c, ['1.mp4', '2.mp4', '3.mp4']) as [string, string, string];
    assert.equal((await u.c.patch(`/v1/videos/${v1}`, { caption: 'Hello #reels' })).body.caption, 'Hello #reels');
    assert.equal((await u.c.patch(`/v1/videos/${v1}`, { caption: 'x'.repeat(2201) })).status, 400);
    assert.equal((await u.c.patch(`/v1/videos/${v1}`, { caption: null })).body.caption, null);
    const pv = await u.c.get(`/v1/videos/${v1}/preview`);
    assert.equal(pv.status, 200); assert.match(pv.body.url, /^https:\/\//);
    assert.equal((await u.c.put('/v1/videos/order', { videoIds: [v3, v1, v2] })).status, 204);
    assert.deepEqual((await u.c.get('/v1/videos')).body.items.map((v: { id: string }) => v.id), [v3, v1, v2]);
    assert.equal((await u.c.put('/v1/videos/order', { videoIds: [v1, v2] })).status, 400, 'must list every ready video');
    const acc = (await u.c.post('/v1/instagram/mock-connect', { username: 'del_acc' })).body;
    await u.c.post('/v1/cycles', { instagramAccountId: acc.id, batchSize: 1 });
    assert.equal((await u.c.put('/v1/videos/order', { videoIds: [v1, v2, v3] })).body.error.code, 'INVALID_STATE', 'no reorder during a live cycle');
    await adv(1, u.c); // first job is created for v3 (position 0)
    const flagged = (await u.c.get('/v1/videos')).body.items.find((v: { id: string }) => v.id === v3);
    assert.equal(flagged.publishedCount, 1);
    assert.equal((await u.c.del(`/v1/videos/${v2}`)).status, 204, 'unreferenced video can be deleted');
    const total = (await u.c.get('/v1/storage')).body;
    assert.deepEqual([total.videoCount, total.bytesUsed], [2, 20 * MB]);
    // all-rejected init is a validation error carrying the per-file reasons
    const rej = await u.c.post('/v1/uploads/init', { files: [{ filename: 'a.gif', contentType: 'image/gif', sizeBytes: 5 }] });
    assert.equal(rej.status, 400); assert.equal(rej.body.error.details[0].field, 'files[0]');
    const part = await u.c.post('/v1/uploads/init', { files: [{ filename: 'ok.mp4', contentType: 'video/mp4', sizeBytes: MB }, { filename: 'bad.gif', contentType: 'image/gif', sizeBytes: 5 }] });
    assert.deepEqual([part.body.targets.length, part.body.rejected.map((r: { code: string }) => r.code)], [1, ['UNSUPPORTED_MEDIA']]);
    await st!.pool.executor().exec(`UPDATE user_settings SET storage_quota_bytes = $2 WHERE user_id = $1`, [u.id, 25 * MB]);
    const over = await u.c.post('/v1/uploads/init', { files: [{ filename: 'huge.mp4', contentType: 'video/mp4', sizeBytes: 10 * MB }] });
    assert.deepEqual([over.status, over.body.error.code], [413, 'STORAGE_QUOTA_EXCEEDED']);
  });

  it('upload completion over HTTP: missing object stays pending, wrong size is rejected, client-reported failure frees quota', async (t) => {
    if (skip(t)) return;
    const u = await signedInUser(st!);
    const init = (await u.c.post('/v1/uploads/init', { files: ['a', 'b', 'c'].map((n) => ({ filename: `${n}.mp4`, contentType: 'video/mp4', sizeBytes: 5 * MB })) })).body;
    const [a, b, c] = init.targets.map((x: { videoId: string }) => x.videoId) as [string, string, string];
    const key = async (id: string) => (await st!.pool.executor().query(`SELECT storage_key FROM videos WHERE id = $1`, [id]))[0]!.storage_key as string;
    st!.storage.put(await key(b), 999 * MB); // wrong size
    const r = await u.c.post(`/v1/uploads/${init.batchId}/complete`, { uploaded: [a, b], failed: [c] });
    assert.equal(r.status, 200);
    const by = Object.fromEntries(r.body.videos.map((v: { id: string; status: string; rejectionReason: string }) => [v.id, [v.status, v.rejectionReason]]));
    assert.deepEqual(by[a], ['PENDING_UPLOAD', null]);
    assert.deepEqual(by[b], ['REJECTED', 'SIZE_MISMATCH']);
    assert.deepEqual(by[c], ['FAILED', 'CLIENT_UPLOAD_FAILED']);
    assert.equal((await u.c.get('/v1/storage')).body.bytesReserved, 5 * MB, 'only the still-pending file holds quota');
    st!.storage.put(await key(a), 5 * MB);
    const r2 = await u.c.post(`/v1/uploads/${init.batchId}/complete`, { uploaded: [a] });
    assert.equal(r2.body.batch.status, 'COMPLETED');
    assert.equal((await u.c.post(`/v1/uploads/${init.batchId}/complete`, { uploaded: ['00000000-0000-4000-8000-000000000001'] })).status, 400, 'foreign video id');
  });

  it('CSRF / CORS: untrusted Origin cannot mutate; trusted origin gets credentialed CORS; preflight works', async (t) => {
    if (skip(t)) return;
    const u = await signedInUser(st!);
    const evil = new Client(st!.url, 'https://evil.example'); evil.jar = new Map(u.c.jar);
    const r = await evil.post('/v1/cycles', { instagramAccountId: '00000000-0000-4000-8000-000000000000' });
    assert.deepEqual([r.status, r.body.error.code], [403, 'FORBIDDEN']);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    const ok = await u.c.get('/v1/me');
    assert.equal(ok.headers.get('access-control-allow-origin'), WEB_ORIGIN); assert.equal(ok.headers.get('access-control-allow-credentials'), 'true'); assert.equal(ok.headers.get('vary'), 'Origin');
    const pre = await fetch(`${st!.url}/v1/cycles`, { method: 'OPTIONS', headers: { origin: WEB_ORIGIN, 'access-control-request-method': 'POST' } });
    assert.equal(pre.status, 204); assert.match(pre.headers.get('access-control-allow-methods')!, /POST/);
    const preEvil = await fetch(`${st!.url}/v1/cycles`, { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } });
    assert.equal(preEvil.headers.get('access-control-allow-origin'), null);
  });

  it('rate limiting: login brute force is throttled per email, with Retry-After', async (t) => {
    if (skip(t)) return;
    const u = await signedInUser(st!);
    const c = new Client(st!.url);
    const codes: number[] = [];
    for (let i = 0; i < 12; i++) codes.push((await c.post('/v1/auth/login', { email: u.email, password: 'wrong-password-123' })).status);
    assert.ok(codes.includes(429), codes.join());
    const last = await c.post('/v1/auth/login', { email: u.email, password: PW });
    assert.equal(last.status, 429); assert.ok(Number(last.headers.get('retry-after')) >= 1); assert.equal(last.body.error.code, 'RATE_LIMITED');
    st!.sim.clock.advanceMs(11 * 60_000);
    assert.equal((await c.post('/v1/auth/login', { email: u.email, password: PW })).status, 423, 'rate window reset after 10 min but the 15-minute account lock still holds');
    st!.sim.clock.advanceMs(5 * 60_000);
    assert.equal((await c.post('/v1/auth/login', { email: u.email, password: PW })).status, 200);
  });

  it('password reset and change flows over HTTP revoke sessions', async (t) => {
    if (skip(t)) return;
    const u = await signedInUser(st!);
    assert.equal((await new Client(st!.url).post('/v1/auth/forgot-password', { email: 'ghost@example.test' })).status, 204);
    const before = st!.mails.length;
    await new Client(st!.url).post('/v1/auth/forgot-password', { email: u.email });
    assert.equal(st!.mails.length, before + 1);
    const tok = st!.mails.at(-1)!.token;
    assert.equal((await new Client(st!.url).post('/v1/auth/reset-password', { token: tok, password: 'brand-new-passphrase-77' })).status, 204);
    assert.equal((await u.c.post('/v1/auth/refresh')).status, 401, 'old sessions died');
    assert.equal((await new Client(st!.url).post('/v1/auth/reset-password', { token: tok, password: 'another-passphrase-88' })).body.error.code, 'TOKEN_INVALID');
    const c2 = new Client(st!.url);
    assert.equal((await c2.post('/v1/auth/login', { email: u.email, password: 'brand-new-passphrase-77' })).status, 200);
    assert.equal((await c2.patch('/v1/me/password', { currentPassword: 'wrong', newPassword: 'whatever-long-passphrase-1' })).body.error.code, 'INVALID_CREDENTIALS');
    assert.equal((await c2.patch('/v1/me/password', { currentPassword: 'brand-new-passphrase-77', newPassword: 'whatever-long-passphrase-1' })).status, 204);
    assert.equal((await c2.get('/v1/me')).status, 401, 'cookies cleared');
  });

  it('account deletion: password required, live cycles stopped, grace period, cancellable', async (t) => {
    if (skip(t)) return;
    const u = await signedInUser(st!);
    const acc = (await u.c.post('/v1/instagram/mock-connect', { username: 'bye_acc' })).body;
    await uploadVideos(u.c, ['z.mp4']);
    const cyc = (await u.c.post('/v1/cycles', { instagramAccountId: acc.id })).body;
    assert.equal((await u.c.del('/v1/me', { password: 'wrong-password-xx' })).body.error.code, 'INVALID_CREDENTIALS');
    assert.equal((await u.c.get('/v1/cycles/current')).body.id, cyc.id, 'wrong password changed nothing');
    const del = await u.c.del('/v1/me', { password: PW });
    assert.deepEqual([del.status, del.body.status], [200, 'PENDING_DELETION']); assert.ok(del.body.deletionRequestedAt);
    assert.equal((await st!.pool.executor().query(`SELECT status FROM publishing_cycles WHERE id = $1`, [cyc.id]))[0]!.status, 'STOPPED');
    const back = await u.c.post('/v1/auth/login', { email: u.email, password: PW });
    assert.equal(back.status, 200);
    assert.equal((await u.c.post('/v1/me/cancel-deletion')).body.status, 'ACTIVE');
  });
});

describe('HTTP API with the mock gate closed (INSTAGRAM_PROVIDER != mock)', () => {
  it('mock-connect is unavailable', async (t) => {
    const s2 = await startStack({ mockMode: false });
    if (!s2) return t.skip('no PostgreSQL');
    try {
      const u = await signedInUser(s2);
      const r = await u.c.post('/v1/instagram/mock-connect', { username: 'x' });
      assert.deepEqual([r.status, r.body.error.code], [404, 'MOCK_ONLY']);
      assert.equal((await u.c.get('/v1/dashboard')).body.mockMode, false);
    } finally { await s2.close(); }
  });
});
