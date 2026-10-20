import { randomUUID } from 'node:crypto';
import { hashToken, parseCookies, serializeCookie, clearCookie, type Clock, type RateLimiter } from '@reelqueue/core';
import type { UserRow } from '@reelqueue/db';
import {
  AccountService, AuthService, CycleService, InstagramConnectService, MeService, ReadService, SettingsService, UploadFlow, UploadService, type SessionTokens,
} from '@reelqueue/services';
import { API_ERROR_STATUS, AUTH_COOKIES, AppError, type ApiErrorBody, type UserDto } from '@reelqueue/shared';
import { json, type HttpRequest, type HttpResponse } from './http';
import { Router, type Principal, type RouteDef } from './router';
import { Fields, queryEnum, queryInt, uuidParam } from './validate';

export interface ApiConfig {
  /** Exact origins of the web app (e.g. https://app.example.com). Cross-origin requests from anywhere else are refused. */
  allowedOrigins: readonly string[];
  secureCookies: boolean;
  sameSite: 'Lax' | 'Strict' | 'None';
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  /** Per-IP ceiling across all routes. */
  globalPerMinute: number;
  /** Where the OAuth callback sends the browser afterwards (the web app origin). Defaults to the first allowed origin. */
  webBaseUrl?: string;
}
export interface ApiLogger { info(o: Record<string, unknown>, msg: string): void; error(o: Record<string, unknown>, msg: string): void }
export interface ApiDeps {
  auth: AuthService; uploads: UploadService; flow: UploadFlow; read: ReadService; settings: SettingsService; accounts: AccountService;
  cycles: CycleService; me: MeService; limiter: RateLimiter; clock: Clock; config: ApiConfig; logger: ApiLogger;
  checks: { database(): Promise<boolean>; redis(): Promise<boolean> };
  /** Present only when INSTAGRAM_PROVIDER=meta. Without it the connect routes behave as not enabled. */
  instagramConnect?: InstagramConnectService;
}

const toUserDto = (u: UserRow): UserDto => ({
  id: u.id, email: u.email, role: u.role, status: u.status, emailVerified: u.emailVerifiedAt !== null, createdAt: u.createdAt.toISOString(),
  deletionRequestedAt: u.deletionRequestedAt ? u.deletionRequestedAt.toISOString() : null,
});
const errorBody = (code: ApiErrorBody['error']['code'], message: string, requestId: string, details?: { field: string; message: string }[]): ApiErrorBody =>
  ({ error: { code, message, requestId, ...(details ? { details } : {}) } });
const MIN = 60_000, HOUR = 3_600_000;
const emailKey = (req: HttpRequest): string | undefined => {
  const b = req.body as { email?: unknown } | undefined;
  return typeof b?.email === 'string' ? hashToken(b.email.trim().toLowerCase()).slice(0, 24) : undefined;
};

export function createApi(d: ApiDeps): (req: HttpRequest) => Promise<HttpResponse> {
  const { config: cfg } = d;
  const router = new Router();
  const user = (r: Omit<RouteDef, 'auth'>): void => void router.add({ ...r, auth: 'user' });
  const open = (r: Omit<RouteDef, 'auth'>): void => void router.add({ ...r, auth: 'none' });

  const setSession = (res: HttpResponse, t: SessionTokens): HttpResponse => {
    const base = { secure: cfg.secureCookies, sameSite: cfg.sameSite, httpOnly: true } as const;
    d.logger.info({
      event: 'auth.cookies.issued',
      cookies: [
        {
          name: AUTH_COOKIES.access,
          secure: cfg.secureCookies,
          sameSite: cfg.sameSite,
          httpOnly: true,
          path: '/',
        },
        {
          name: AUTH_COOKIES.refresh,
          secure: cfg.secureCookies,
          sameSite: cfg.sameSite,
          httpOnly: true,
          path: '/v1/auth',
        },
      ],
    }, 'auth cookies issued');
    res.cookies.push(
      serializeCookie(AUTH_COOKIES.access, t.accessToken, { ...base, path: '/', maxAgeSeconds: cfg.accessTtlSeconds }),
      // The refresh cookie is only ever sent to the auth endpoints.
      serializeCookie(AUTH_COOKIES.refresh, t.refreshToken, { ...base, path: '/v1/auth', maxAgeSeconds: cfg.refreshTtlSeconds }),
    );
    return res;
  };
  const clearSession = (res: HttpResponse): HttpResponse => {
    const base = { secure: cfg.secureCookies, sameSite: cfg.sameSite, httpOnly: true } as const;
    res.cookies.push(clearCookie(AUTH_COOKIES.access, { ...base, path: '/' }), clearCookie(AUTH_COOKIES.refresh, { ...base, path: '/v1/auth' }));
    return res;
  };
  const cookieOf = (req: HttpRequest, name: string): string | undefined => parseCookies(req.headers.cookie)[name];
  const clientCtx = (req: HttpRequest) => ({ userAgent: req.headers['user-agent'] ?? null, ipHash: hashToken(`ip:${req.ip}`).slice(0, 32) });

  /* ------------------------------------------------------------------ auth */
  open({ method: 'POST', pattern: '/v1/auth/register', limits: [{ name: 'register', limit: 10, windowMs: HOUR }], handler: async ({ req }) => {
    const f = new Fields(req.body); const email = f.str('email', { max: 320 }); const password = f.str('password', { max: 256 }); f.done();
    await d.auth.signup(email, password);
    return json(202, { status: 'VERIFICATION_SENT' });
  } });
  open({ method: 'POST', pattern: '/v1/auth/verify-email', limits: [{ name: 'verify', limit: 20, windowMs: HOUR }], handler: async ({ req }) => {
    const f = new Fields(req.body); const token = f.str('token', { max: 200 }); f.done();
    await d.auth.verifyEmail(token);
    return json(204);
  } });
  open({ method: 'POST', pattern: '/v1/auth/login', limits: [{ name: 'login-ip', limit: 30, windowMs: 10 * MIN }, { name: 'login-email', limit: 10, windowMs: 10 * MIN, by: emailKey }], handler: async ({ req }) => {
    const f = new Fields(req.body); const email = f.str('email', { max: 320 }); const password = f.str('password', { max: 256 }); f.done();
    const t = await d.auth.login(email, password, clientCtx(req));
    return setSession(json(200, { user: toUserDto(t.user) }), t);
  } });
  open({ method: 'POST', pattern: '/v1/auth/refresh', limits: [{ name: 'refresh', limit: 120, windowMs: MIN }], handler: async ({ req }) => {
    const raw = cookieOf(req, AUTH_COOKIES.refresh);
      d.logger.info({
        event: 'auth.refresh.cookie',
        present: Boolean(raw),
      }, 'refresh cookie received');
    if (!raw) return clearSession(errRes(new AppError('UNAUTHENTICATED', 'Session expired. Sign in again.'), 'refresh'));
    try {
      const t = await d.auth.refresh(raw, clientCtx(req));
      return setSession(json(200, { user: toUserDto(t.user) }), t);
    } catch (e) {
      if (e instanceof AppError && e.code === 'UNAUTHENTICATED') return clearSession(errRes(e, 'refresh')); // a dead session must not linger in the browser
      throw e;
    }
  } });
  open({ method: 'POST', pattern: '/v1/auth/logout', handler: async ({ req }) => {
    await d.auth.logout(cookieOf(req, AUTH_COOKIES.refresh));
    return clearSession(json(204));
  } });
  open({ method: 'POST', pattern: '/v1/auth/forgot-password', limits: [{ name: 'forgot-ip', limit: 10, windowMs: HOUR }, { name: 'forgot-email', limit: 3, windowMs: HOUR, by: emailKey }], handler: async ({ req }) => {
    const f = new Fields(req.body); const email = f.str('email', { max: 320 }); f.done();
    await d.auth.requestPasswordReset(email);
    return json(204); // identical for known and unknown addresses
  } });
  open({ method: 'POST', pattern: '/v1/auth/reset-password', limits: [{ name: 'reset', limit: 10, windowMs: HOUR }], handler: async ({ req }) => {
    const f = new Fields(req.body); const token = f.str('token', { max: 200 }); const password = f.str('password', { max: 256 }); f.done();
    await d.auth.resetPassword(token, password);
    return clearSession(json(204));
  } });

  /* -------------------------------------------------------------------- me */
  user({ method: 'GET', pattern: '/v1/me', handler: async ({ principal }) => json(200, toUserDto(await d.auth.getUser(principal!.userId))) });
  user({ method: 'PATCH', pattern: '/v1/me/password', limits: [{ name: 'chpw', limit: 10, windowMs: HOUR }], handler: async ({ req, principal }) => {
    const f = new Fields(req.body); const cur = f.str('currentPassword', { max: 256 }); const next = f.str('newPassword', { max: 256 }); f.done();
    await d.auth.changePassword(principal!.userId, cur, next);
    return clearSession(json(204)); // every session was revoked
  } });
  user({ method: 'DELETE', pattern: '/v1/me', limits: [{ name: 'delacct', limit: 5, windowMs: HOUR }], handler: async ({ req, principal }) => {
    const f = new Fields(req.body); const password = f.str('password', { max: 256 }); f.done();
    return clearSession(json(200, toUserDto(await d.me.deleteAccount(principal!.userId, password))));
  } });
  user({ method: 'POST', pattern: '/v1/me/cancel-deletion', handler: async ({ principal }) => json(200, toUserDto(await d.auth.cancelDeletion(principal!.userId))) });
  user({ method: 'GET', pattern: '/v1/settings', handler: async ({ principal }) => json(200, await d.settings.get(principal!.userId)) });
  user({ method: 'PATCH', pattern: '/v1/settings', handler: async ({ req, principal }) => {
    const f = new Fields(req.body);
    const tz = f.optStr('timezone', { max: 64 }); const batchSize = f.optInt('batchSize'); const intervalMinutes = f.optInt('intervalMinutes');
    const cycleDurationHours = f.optInt('cycleDurationHours'); const loopEnabled = f.optBool('loopEnabled');
    const acct = (req.body as { defaultInstagramAccountId?: unknown } | undefined)?.defaultInstagramAccountId;
    let defaultAccount: string | null | undefined;
    if (acct === null) defaultAccount = null; else if (acct !== undefined) defaultAccount = uuidParam(typeof acct === 'string' ? acct : '', 'Instagram account');
    f.done();
    return json(200, await d.settings.update(principal!.userId, {
      ...(tz !== undefined ? { timezone: tz } : {}), ...(batchSize !== undefined ? { batchSize } : {}), ...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
      ...(cycleDurationHours !== undefined ? { cycleDurationHours } : {}), ...(loopEnabled !== undefined ? { loopEnabled } : {}),
      ...(defaultAccount !== undefined ? { defaultInstagramAccountId: defaultAccount } : {}),
    }));
  } });

  /* ------------------------------------------------------------- instagram */
  user({ method: 'GET', pattern: '/v1/instagram/accounts', handler: async ({ principal }) => json(200, await d.accounts.list(principal!.userId)) });
  user({ method: 'POST', pattern: '/v1/instagram/mock-connect', handler: async ({ req, principal }) => {
    const f = new Fields(req.body); const username = f.str('username', { max: 30 }); f.done();
    return json(201, await d.accounts.mockConnect(principal!.userId, username));
  } });
  const OAUTH_COOKIE = 'rq_oauth';
  const oauthCookieOpts = { path: '/v1/instagram', httpOnly: true, secure: cfg.secureCookies, sameSite: 'Lax' } as const; // Lax: Meta redirects the browser back with a top-level GET
  user({ method: 'POST', pattern: '/v1/instagram/connect', limits: [{ name: 'ig-connect', limit: 20, windowMs: HOUR, by: (r) => r.ip }], handler: async ({ principal }) => {
    if (!d.instagramConnect) throw new AppError('NOT_FOUND', 'Instagram connection is not enabled.');
    const { authorizationUrl, nonce } = d.instagramConnect.start(principal!.userId);
    const res = json(200, { authorizationUrl });
    res.cookies.push(serializeCookie(OAUTH_COOKIE, nonce, { ...oauthCookieOpts, maxAgeSeconds: 600 }));
    return res;
  } });
  // Browser redirect from Meta. The session is authenticated INSIDE the handler so every outcome is a redirect to the web app
  // (never a JSON 401 page). The outcome code is one of a fixed set; Meta-provided text is never echoed.
  open({ method: 'GET', pattern: '/v1/instagram/callback', limits: [{ name: 'ig-callback', limit: 30, windowMs: HOUR }], handler: async ({ req }) => {
    const base = (cfg.webBaseUrl ?? cfg.allowedOrigins[0] ?? '').replace(/\/+$/, '');
    const back = (q: string): HttpResponse => {
      const r = json(302); r.headers.location = `${base}/accounts?${q}`;
      r.cookies.push(clearCookie(OAUTH_COOKIE, oauthCookieOpts)); return r;
    };
    if (!d.instagramConnect) return back('error=NOT_ENABLED');
    if (req.query.error !== undefined) return back('error=ACCESS_DENIED'); // the user declined (or Meta refused); details are not shown
    const code = req.query.code, state = req.query.state, nonce = cookieOf(req, OAUTH_COOKIE);
    if (!code || !state || !nonce || code.length > 2048 || state.length > 1024) return back('error=STATE_INVALID');
    let p: Principal;
    try { p = await d.auth.authenticate(cookieOf(req, AUTH_COOKIES.access)); } catch { return back('error=SESSION'); }
    const r = await d.instagramConnect.complete({ userId: p.userId, code, state, nonce });
    return back(r.ok ? 'connected=1' : `error=${r.reason}`);
  } });
  user({ method: 'POST', pattern: '/v1/instagram/accounts/:id/disconnect', handler: async ({ params, principal }) => json(200, await d.accounts.disconnect(principal!.userId, uuidParam(params.id, 'Instagram account'))) });
  user({ method: 'POST', pattern: '/v1/instagram/accounts/:id/refresh-quota', limits: [{ name: 'quota', limit: 30, windowMs: HOUR }], handler: async ({ params, principal }) => json(200, await d.accounts.refreshQuota(principal!.userId, uuidParam(params.id, 'Instagram account'))) });

  /* --------------------------------------------------------------- uploads */
  user({ method: 'POST', pattern: '/v1/uploads/init', limits: [{ name: 'upload-init', limit: 60, windowMs: HOUR }], handler: async ({ req, principal }) => {
    const f = new Fields(req.body);
    const files = f.objects('files', { min: 1, max: 500 }).map((x) => ({ filename: x.str('filename', { max: 255 }), contentType: x.str('contentType', { max: 100 }), sizeBytes: x.int('sizeBytes', { min: 0, max: Number.MAX_SAFE_INTEGER }) }));
    f.done();
    const r = await d.uploads.createBatch(principal!.userId, files);
    if (!r.batchId || !r.expiresAt) throw new AppError('VALIDATION_FAILED', 'None of the files can be uploaded.', r.rejected.map((x) => ({ field: `files[${x.index}]`, message: x.message })));
    return json(200, { batchId: r.batchId, expiresAt: r.expiresAt.toISOString(), targets: r.uploads.map((u) => ({ index: u.index, videoId: u.videoId, uploadUrl: u.url, headers: u.headers })), rejected: r.rejected });
  } });
  user({ method: 'POST', pattern: '/v1/uploads/:batchId/complete', handler: async ({ req, params, principal }) => {
    const f = new Fields(req.body); const uploaded = f.stringArray('uploaded', { max: 500, itemMax: 40 }); const failed = f.optStringArray('failed', { max: 500 }); f.done();
    return json(200, await d.flow.completeBatch(principal!.userId, uuidParam(params.batchId, 'Upload batch'), { uploaded: uploaded.map((x) => uuidParam(x, 'Video')), ...(failed ? { failed: failed.map((x) => uuidParam(x, 'Video')) } : {}) }));
  } });
  user({ method: 'GET', pattern: '/v1/videos', handler: async ({ req, principal }) => json(200, await d.read.listVideos(principal!.userId, {
    ...(queryEnum(req.query, 'status', ['PENDING_UPLOAD', 'VALIDATING', 'READY', 'REJECTED', 'FAILED'] as const) ? { status: queryEnum(req.query, 'status', ['PENDING_UPLOAD', 'VALIDATING', 'READY', 'REJECTED', 'FAILED'] as const)! } : {}),
    ...(queryInt(req.query, 'page', { min: 1, max: 100000 }) !== undefined ? { page: queryInt(req.query, 'page', { min: 1, max: 100000 })! } : {}),
    ...(queryInt(req.query, 'pageSize', { min: 1, max: 100 }) !== undefined ? { pageSize: queryInt(req.query, 'pageSize', { min: 1, max: 100 })! } : {}),
  })) });
  user({ method: 'PUT', pattern: '/v1/videos/order', handler: async ({ req, principal }) => {
    const f = new Fields(req.body); const ids = f.stringArray('videoIds', { max: 5000, itemMax: 40 }); f.done();
    await d.uploads.reorder(principal!.userId, ids.map((x) => uuidParam(x, 'Video')));
    return json(204);
  } });
  user({ method: 'PATCH', pattern: '/v1/videos/:id', handler: async ({ req, params, principal }) => {
    const f = new Fields(req.body); const caption = f.nullableStr('caption', 2200); f.done();
    const v = await d.uploads.updateCaption(principal!.userId, uuidParam(params.id, 'Video'), caption ?? null);
    return json(200, (await d.read.videoDtos(principal!.userId, [v]))[0]);
  } });
  user({ method: 'DELETE', pattern: '/v1/videos/:id', handler: async ({ params, principal }) => { await d.uploads.deleteVideo(principal!.userId, uuidParam(params.id, 'Video')); return json(204); } });
  user({ method: 'GET', pattern: '/v1/videos/:id/preview', handler: async ({ params, principal }) => {
    const p = await d.uploads.preview(principal!.userId, uuidParam(params.id, 'Video'));
    return json(200, { url: p.url, expiresAt: p.expiresAt.toISOString() });
  } });
  user({ method: 'GET', pattern: '/v1/storage', handler: async ({ principal }) => json(200, await d.read.storage(principal!.userId)) });

  /* ---------------------------------------------------------------- cycles */
  user({ method: 'GET', pattern: '/v1/cycles/current', handler: async ({ principal }) => json(200, await d.read.currentCycle(principal!.userId)) });
  user({ method: 'GET', pattern: '/v1/cycles', handler: async ({ req, principal }) => json(200, await d.read.listCycles(principal!.userId, {
    ...(queryInt(req.query, 'page', { min: 1, max: 100000 }) !== undefined ? { page: queryInt(req.query, 'page', { min: 1, max: 100000 })! } : {}),
    ...(queryInt(req.query, 'pageSize', { min: 1, max: 100 }) !== undefined ? { pageSize: queryInt(req.query, 'pageSize', { min: 1, max: 100 })! } : {}),
  })) });
  user({ method: 'POST', pattern: '/v1/cycles', limits: [{ name: 'cycle-start', limit: 30, windowMs: HOUR }], handler: async ({ req, principal }) => {
    const f = new Fields(req.body);
    const id = f.str('instagramAccountId', { max: 40 }); const batchSize = f.optInt('batchSize'); const intervalMinutes = f.optInt('intervalMinutes');
    const loopEnabled = f.optBool('loopEnabled'); const durationHours = f.optInt('durationHours'); f.done();
    return json(201, await d.cycles.start(principal!.userId, {
      instagramAccountId: uuidParam(id, 'Instagram account'), ...(batchSize !== undefined ? { batchSize } : {}), ...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
      ...(loopEnabled !== undefined ? { loopEnabled } : {}), ...(durationHours !== undefined ? { durationHours } : {}),
    }));
  } });
  user({ method: 'POST', pattern: '/v1/cycles/:id/pause', handler: async ({ params, principal }) => json(200, await d.cycles.pause(principal!.userId, uuidParam(params.id, 'Cycle'))) });
  user({ method: 'POST', pattern: '/v1/cycles/:id/resume', handler: async ({ params, principal }) => json(200, await d.cycles.resume(principal!.userId, uuidParam(params.id, 'Cycle'))) });
  user({ method: 'POST', pattern: '/v1/cycles/:id/stop', handler: async ({ params, principal }) => json(200, await d.cycles.stop(principal!.userId, uuidParam(params.id, 'Cycle'))) });
  user({ method: 'PATCH', pattern: '/v1/cycles/:id', handler: async ({ req, params, principal }) => {
    const f = new Fields(req.body); const loop = f.bool('loopEnabled'); f.done();
    return json(200, await d.cycles.setLoop(principal!.userId, uuidParam(params.id, 'Cycle'), loop));
  } });

  /* ------------------------------------------------------------------ jobs */
  user({ method: 'GET', pattern: '/v1/jobs/upcoming', handler: async ({ principal }) => json(200, await d.read.upcomingJobs(principal!.userId)) });
  user({ method: 'GET', pattern: '/v1/jobs', handler: async ({ req, principal }) => {
    const page = queryInt(req.query, 'page', { min: 1, max: 100000 }); const pageSize = queryInt(req.query, 'pageSize', { min: 1, max: 100 });
    const status = queryEnum(req.query, 'status', ['SCHEDULED', 'DEFERRED', 'RETRY_WAIT', 'CREATING_CONTAINER', 'PROCESSING_MEDIA', 'PUBLISH_REQUESTED', 'ACCEPTED', 'CONFIRMED', 'SIMULATED', 'FAILED', 'CANCELLED', 'EXPIRED'] as const);
    const cycleId = req.query.cycleId !== undefined ? uuidParam(req.query.cycleId, 'Cycle') : undefined;
    return json(200, await d.read.listJobs(principal!.userId, {
      ...(page !== undefined ? { page } : {}), ...(pageSize !== undefined ? { pageSize } : {}), ...(status ? { status } : {}), ...(cycleId ? { cycleId } : {}),
      ...(req.query.from !== undefined ? { from: req.query.from } : {}), ...(req.query.to !== undefined ? { to: req.query.to } : {}),
    }));
  } });
  user({ method: 'POST', pattern: '/v1/jobs/:id/retry', limits: [{ name: 'job-retry', limit: 60, windowMs: HOUR }], handler: async ({ params, principal }) => json(200, await d.cycles.retryJob(principal!.userId, uuidParam(params.id, 'Job'))) });
  user({ method: 'GET', pattern: '/v1/dashboard', handler: async ({ principal }) => json(200, await d.read.dashboard(principal!.userId)) });

  /* ---------------------------------------------------------------- health */
  open({ method: 'GET', pattern: '/health/live', handler: async () => json(200, { status: 'ok' }) });
  open({ method: 'GET', pattern: '/health/ready', handler: async () => {
    const [db, redis] = await Promise.all([d.checks.database().catch(() => false), d.checks.redis().catch(() => false)]);
    return json(db && redis ? 200 : 503, { status: db && redis ? 'ok' : 'degraded', database: db ? 'up' : 'down', redis: redis ? 'up' : 'down' });
  } });

  /* ------------------------------------------------------------- pipeline */
  function errRes(e: unknown, requestId: string): HttpResponse {
    if (e instanceof AppError) {
      const res = json(API_ERROR_STATUS[e.code], errorBody(e.code, e.message, requestId, e.details ? [...e.details] : undefined));
      return res;
    }
    d.logger.error({ requestId, err: e instanceof Error ? { name: e.name, message: e.message } : 'unknown' }, 'unhandled error');
    return json(500, errorBody('INTERNAL', 'Something went wrong.', requestId)); // never leaks internals
  }

  const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
  return async function handle(req: HttpRequest): Promise<HttpResponse> {
    const started = Date.now();
    const incoming = req.headers['x-request-id'];
    const requestId = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
    let principal: Principal | null = null;
    let res: HttpResponse;
    try {
      res = await (async () => {
        const origin = req.headers.origin;
        const originAllowed = origin !== undefined && cfg.allowedOrigins.includes(origin);
        if (req.method === 'OPTIONS') {
          const pre = json(204);
          if (originAllowed) { pre.headers['access-control-allow-methods'] = 'GET,POST,PUT,PATCH,DELETE,OPTIONS'; pre.headers['access-control-allow-headers'] = 'content-type,x-request-id'; pre.headers['access-control-max-age'] = '600'; }
          return pre;
        }
        // CSRF: a browser always sends Origin on cross-site state-changing requests; anything not on the allow-list is refused.
        if (!SAFE.has(req.method) && origin !== undefined && !originAllowed) throw new AppError('FORBIDDEN', 'Origin not allowed.');
        const g = await d.limiter.check(`g:${req.ip}`, cfg.globalPerMinute, MIN);
        if (!g.allowed) return rateLimited(g.retryAfterSeconds, requestId);
        const m = router.match(req.method, req.path);
        if (!('route' in m)) {
          const r = m.status === 405 ? json(405, errorBody('NOT_FOUND', 'Method not allowed.', requestId)) : json(404, errorBody('NOT_FOUND', 'Not found.', requestId));
          if (m.status === 405) r.headers.allow = m.allow.join(', ');
          return r;
        }
        for (const rule of m.route.limits ?? []) {
          const by = rule.by ? rule.by(req) : undefined;
          const dec = await d.limiter.check(`${rule.name}:${by ?? req.ip}`, rule.limit, rule.windowMs);
          if (!dec.allowed) return rateLimited(dec.retryAfterSeconds, requestId);
        }

        if (m.route.auth !== 'none') {
          const accessToken = cookieOf(req, AUTH_COOKIES.access);

          d.logger.info({
            event: 'auth.cookie.received',
            requestId,
            path: req.path,
            cookieName: AUTH_COOKIES.access,
            present: Boolean(accessToken),
          }, 'auth cookie received');

          try {
            principal = await d.auth.authenticate(accessToken);

            d.logger.info({
              event: 'auth.validation',
              requestId,
              path: req.path,
              valid: true,
            }, 'auth validation result');

          } catch (e) {
            d.logger.info({
              event: 'auth.validation',
              requestId,
              path: req.path,
              valid: false,
              reason: e instanceof AppError
                ? e.code
                : 'UNEXPECTED_ERROR',
            }, 'auth validation result');

            throw e;
          }

          if (m.route.auth === 'admin' && principal.role !== 'ADMIN') {
            throw new AppError('FORBIDDEN', 'Forbidden.');
          }
      }

        return m.route.handler({ req, params: m.params, principal, requestId });
      })();
    } catch (e) {
      res = errRes(e, requestId);
    }
    res.headers['x-request-id'] = requestId;
    res.headers['x-content-type-options'] = 'nosniff';
    res.headers['cache-control'] = 'no-store';
    res.headers['referrer-policy'] = 'no-referrer';
    res.headers['x-frame-options'] = 'DENY';
    if (cfg.secureCookies) res.headers['strict-transport-security'] = 'max-age=63072000; includeSubDomains';
    const origin = req.headers.origin;
    if (origin !== undefined && cfg.allowedOrigins.includes(origin)) {
      res.headers['access-control-allow-origin'] = origin;
      res.headers['access-control-allow-credentials'] = 'true';
      res.headers.vary = 'Origin';
    }
    d.logger.info({ requestId, method: req.method, path: req.path, status: res.status, ms: Date.now() - started, ...(principal ? { userId: (principal as Principal).userId } : {}) }, 'request');
    return res;
  };

  function rateLimited(retryAfterSeconds: number, requestId: string): HttpResponse {
    const r = json(429, errorBody('RATE_LIMITED', 'Too many requests. Please slow down.', requestId));
    r.headers['retry-after'] = String(retryAfterSeconds);
    return r;
  }
}
