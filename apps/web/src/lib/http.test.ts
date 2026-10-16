import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiError, buildPath, buildQuery, buildUrl, createHttpClient, errorMessage, fieldErrors, toApiError } from './http';
import type { BaseSpec } from './http';

const GET_ME: BaseSpec = { method: 'GET', path: '/v1/me', auth: 'user' };
const LOGIN: BaseSpec = { method: 'POST', path: '/v1/auth/login', auth: 'none' };
const REFRESH: BaseSpec = { method: 'POST', path: '/v1/auth/refresh', auth: 'none' };
const STOP: BaseSpec = { method: 'POST', path: '/v1/cycles/:id/stop', auth: 'user' };

const json = (status: number, body?: unknown) =>
  new Response(body === undefined ? null : JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

test('buildPath substitutes and encodes params', () => {
  assert.equal(buildPath('/v1/cycles/:id/stop', { id: 'a b/c' }), '/v1/cycles/a%20b%2Fc/stop');
  assert.equal(buildPath('/v1/uploads/:batchId/complete', { batchId: 7 }), '/v1/uploads/7/complete');
  assert.equal(buildPath('/v1/me'), '/v1/me');
});
test('buildPath throws on missing param', () => {
  assert.throws(() => buildPath('/v1/videos/:id', {}), /Missing path param "id"/);
  assert.throws(() => buildPath('/v1/videos/:id', { id: '' }), /Missing path param/);
});
test('buildQuery skips empties, repeats arrays, encodes', () => {
  assert.equal(buildQuery(), '');
  assert.equal(buildQuery({ a: undefined, b: null, c: '' }), '');
  assert.equal(buildQuery({ page: 2, pageSize: 25, status: 'FAILED' }), '?page=2&pageSize=25&status=FAILED');
  assert.equal(buildQuery({ flag: false, n: 0 }), '?flag=false&n=0');
  assert.equal(buildQuery({ q: 'a b&c' }), '?q=a+b%26c');
  assert.equal(buildQuery({ s: ['x', 'y'] }), '?s=x&s=y');
  assert.equal(buildQuery({ from: new Date('2026-01-02T03:04:05.000Z') }), '?from=2026-01-02T03%3A04%3A05.000Z');
});
test('buildUrl joins base without double slash', () => {
  assert.equal(buildUrl('http://x:4000/', STOP, { id: '1' }, { a: 1 }), 'http://x:4000/v1/cycles/1/stop?a=1');
});

test('toApiError reads the ApiErrorBody and falls back by status', () => {
  const e = toApiError(409, { error: { code: 'VIDEO_IN_USE', message: 'in use', requestId: 'r1', details: [{ field: 'x', message: 'bad' }] } });
  assert.ok(e instanceof ApiError);
  assert.equal(e.code, 'VIDEO_IN_USE');
  assert.equal(e.requestId, 'r1');
  assert.equal(e.status, 409);
  assert.equal(toApiError(502, '<html>').code, 'INTERNAL');
  assert.equal(toApiError(429, undefined).code, 'RATE_LIMITED');
  assert.equal(toApiError(418, { nope: 1 }).code, 'UNEXPECTED_RESPONSE');
});
test('errorMessage prefers friendly text for known codes, API text otherwise, includes request id', () => {
  assert.match(errorMessage(new ApiError({ code: 'NETWORK_ERROR', message: 'x', status: 0 })), /Cannot reach/);
  assert.equal(errorMessage(new ApiError({ code: 'CONFLICT', message: 'Already there', status: 409 })), 'Already there');
  assert.equal(errorMessage(new ApiError({ code: 'CONFLICT', message: 'Already there', status: 409, requestId: 'abc' })), 'Already there (ref abc)');
  assert.equal(errorMessage(new Error('boom')), 'boom');
  assert.equal(errorMessage(42), 'Something went wrong.');
});
test('fieldErrors maps details by field, first wins', () => {
  const e = new ApiError({ code: 'VALIDATION_FAILED', message: 'bad', status: 400, details: [{ field: 'email', message: 'a' }, { field: 'email', message: 'b' }, { field: 'password', message: 'c' }] });
  assert.deepEqual(fieldErrors(e), { email: 'a', password: 'c' });
  assert.deepEqual(fieldErrors(new Error('x')), {});
});

function harness(handler: (url: string, init: RequestInit, n: number) => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  let unauth = 0;
  const client = createHttpClient({
    baseUrl: 'http://api.test',
    refreshRoute: REFRESH,
    onUnauthenticated: () => {
      unauth++;
    },
    fetchImpl: (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return handler(url, init, calls.length);
    }) as unknown as typeof fetch,
  });
  return { client, calls, unauth: () => unauth };
}

test('request sends credentials include, JSON body and parses JSON', async () => {
  const h = harness(() => json(200, { id: 'u1' }));
  const res = await h.client.request<{ id: string }>(LOGIN, { body: { email: 'a@b.c', password: 'x' } });
  assert.deepEqual(res, { id: 'u1' });
  const c = h.calls[0]!;
  assert.equal(c.url, 'http://api.test/v1/auth/login');
  assert.equal(c.init.credentials, 'include');
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.body, JSON.stringify({ email: 'a@b.c', password: 'x' }));
  assert.equal((c.init.headers as Record<string, string>)['Content-Type'], 'application/json');
});
test('204 and empty bodies resolve to undefined', async () => {
  const h = harness(() => new Response(null, { status: 204 }));
  assert.equal(await h.client.request(STOP, { params: { id: '1' } }), undefined);
});
test('error responses throw ApiError with code', async () => {
  const h = harness(() => json(401, { error: { code: 'INVALID_CREDENTIALS', message: 'nope' } }));
  await assert.rejects(h.client.request(LOGIN, { body: {} }), (e: unknown) => e instanceof ApiError && e.code === 'INVALID_CREDENTIALS');
  assert.equal(h.calls.length, 1, 'auth:none route must not trigger a refresh');
  assert.equal(h.unauth(), 0);
});
test('401 on a user route: refresh once, retry once, success', async () => {
  const h = harness((url, _i, n) => {
    if (url.endsWith('/v1/auth/refresh')) return json(200, { user: {} });
    return n === 1 ? json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } }) : json(200, { id: 'me' });
  });
  assert.deepEqual(await h.client.request(GET_ME), { id: 'me' });
  assert.deepEqual(h.calls.map((c) => c.url.replace('http://api.test', '')), ['/v1/me', '/v1/auth/refresh', '/v1/me']);
  assert.equal(h.unauth(), 0);
});
test('401 and refresh fails: calls onUnauthenticated once and throws', async () => {
  const h = harness((url) =>
    url.endsWith('/v1/auth/refresh') ? json(401, { error: { code: 'UNAUTHENTICATED', message: 'no' } }) : json(401, { error: { code: 'UNAUTHENTICATED', message: 'expired' } }),
  );
  await assert.rejects(h.client.request(GET_ME), (e: unknown) => e instanceof ApiError && e.code === 'UNAUTHENTICATED');
  assert.equal(h.unauth(), 1);
  assert.equal(h.calls.length, 2, 'no retry after failed refresh');
});
test('401 again after a successful refresh: no infinite loop (exactly one retry)', async () => {
  const h = harness((url) => (url.endsWith('/v1/auth/refresh') ? json(200, {}) : json(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } })));
  await assert.rejects(h.client.request(GET_ME));
  assert.equal(h.calls.length, 3);
  assert.equal(h.unauth(), 1);
});
test('noAuthRedirect suppresses onUnauthenticated', async () => {
  const h = harness(() => json(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } }));
  await assert.rejects(h.client.request(GET_ME, { noAuthRedirect: true }));
  assert.equal(h.unauth(), 0);
});
test('concurrent 401s share a single refresh call', async () => {
  let refreshes = 0;
  const seen = new Set<string>();
  const h = harness(async (url, init) => {
    if (url.endsWith('/v1/auth/refresh')) {
      refreshes++;
      await new Promise((r) => setTimeout(r, 10));
      return json(200, {});
    }
    const key = `${init.method}${url}`;
    if (!seen.has(key)) {
      seen.add(key);
      return json(401, { error: { code: 'UNAUTHENTICATED', message: 'x' } });
    }
    return json(200, { ok: true });
  });
  const a: BaseSpec = { method: 'GET', path: '/v1/a', auth: 'user' };
  const b: BaseSpec = { method: 'GET', path: '/v1/b', auth: 'user' };
  const [ra, rb] = await Promise.all([h.client.request(a), h.client.request(b)]);
  assert.deepEqual([ra, rb], [{ ok: true }, { ok: true }]);
  assert.equal(refreshes, 1);
});
test('network failure becomes NETWORK_ERROR', async () => {
  const client = createHttpClient({
    baseUrl: 'http://x',
    refreshRoute: REFRESH,
    fetchImpl: (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch,
  });
  await assert.rejects(client.request(GET_ME), (e: unknown) => e instanceof ApiError && e.code === 'NETWORK_ERROR');
});
test('invalid JSON on 200 is UNEXPECTED_RESPONSE', async () => {
  const h = harness(() => new Response('<html>', { status: 200 }));
  await assert.rejects(h.client.request(GET_ME), (e: unknown) => e instanceof ApiError && e.code === 'UNEXPECTED_RESPONSE');
});
