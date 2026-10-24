// // packages/http/src/app.ts
// import { randomUUID } from 'node:crypto';
// import { hashToken, parseCookies, serializeCookie, clearCookie, type Clock, type RateLimiter } from '@reelqueue/core';
// import type { UserRow } from '@reelqueue/db';
// import {
//   AccountService, AuthService, CycleService, InstagramConnectService, MeService, ReadService, SettingsService, UploadFlow, UploadService, type SessionTokens
// } from '@reelqueue/services';
// import { API_ERROR_STATUS, AUTH_COOKIES, AppError, type ApiErrorBody, type UserDto } from '@reelqueue/shared';
// import { json, type HttpRequest, type HttpResponse } from './http';
// import { Router, type Principal, type RouteDef } from './router';
// import { Fields, queryEnum, queryInt, uuidParam } from './validate';
// import { GoogleDriveService } from '@reelqueue/services'

// export interface ApiConfig {
//   /** Exact origins of the web app (e.g. https://app.example.com). Cross-origin requests from anywhere else are refused. */
//   allowedOrigins: readonly string[];
//   secureCookies: boolean;
//   sameSite: 'Lax' | 'Strict' | 'None';
//   accessTtlSeconds: number;
//   refreshTtlSeconds: number;
//   /** Per-IP ceiling across all routes. */
//   globalPerMinute: number;
//   /** Where the OAuth callback sends the browser afterwards (the web app origin). Defaults to the first allowed origin. */
//   webBaseUrl?: string;
// }
// export interface ApiLogger { info(o: Record<string, unknown>, msg: string): void; error(o: Record<string, unknown>, msg: string): void }
// export interface ApiDeps {
//   auth: AuthService; uploads: UploadService; flow: UploadFlow; read: ReadService; settings: SettingsService; accounts: AccountService;
//   cycles: CycleService; me: MeService; limiter: RateLimiter; clock: Clock; config: ApiConfig; logger: ApiLogger;
//   checks: { database(): Promise<boolean>; redis(): Promise<boolean> };
//   /** Present only when INSTAGRAM_PROVIDER=meta. Without it the connect routes behave as not enabled. */
//   instagramConnect?: InstagramConnectService;

//   // Google Drive Connect
//   /** Present only when GOOGLE_DRIVE_* is configured. Without it every Drive route except /status behaves as not enabled. */
//   googleDrive?: GoogleDriveService;
// }

// const toUserDto = (u: UserRow): UserDto => ({
//   id: u.id, email: u.email, role: u.role, status: u.status, emailVerified: u.emailVerifiedAt !== null, createdAt: u.createdAt.toISOString(),
//   deletionRequestedAt: u.deletionRequestedAt ? u.deletionRequestedAt.toISOString() : null,
// });
// const errorBody = (code: ApiErrorBody['error']['code'], message: string, requestId: string, details?: { field: string; message: string }[]): ApiErrorBody =>
//   ({ error: { code, message, requestId, ...(details ? { details } : {}) } });
// const MIN = 60_000, HOUR = 3_600_000;
// const emailKey = (req: HttpRequest): string | undefined => {
//   const b = req.body as { email?: unknown } | undefined;
//   return typeof b?.email === 'string' ? hashToken(b.email.trim().toLowerCase()).slice(0, 24) : undefined;
// };

// export function createApi(d: ApiDeps): (req: HttpRequest) => Promise<HttpResponse> {
//   const { config: cfg } = d;
//   const router = new Router();
//   const user = (r: Omit<RouteDef, 'auth'>): void => void router.add({ ...r, auth: 'user' });
//   const open = (r: Omit<RouteDef, 'auth'>): void => void router.add({ ...r, auth: 'none' });

//   const setSession = (res: HttpResponse, t: SessionTokens): HttpResponse => {
//     const base = { secure: cfg.secureCookies, sameSite: cfg.sameSite, httpOnly: true } as const;
//     d.logger.info({
//       event: 'auth.cookies.issued',
//       cookies: [
//         {
//           name: AUTH_COOKIES.access,
//           secure: cfg.secureCookies,
//           sameSite: cfg.sameSite,
//           httpOnly: true,
//           path: '/',
//         },
//         {
//           name: AUTH_COOKIES.refresh,
//           secure: cfg.secureCookies,
//           sameSite: cfg.sameSite,
//           httpOnly: true,
//           path: '/v1/auth',
//         },
//       ],
//     }, 'auth cookies issued');
//     res.cookies.push(
//       serializeCookie(AUTH_COOKIES.access, t.accessToken, { ...base, path: '/', maxAgeSeconds: cfg.accessTtlSeconds }),
//       // The refresh cookie is only ever sent to the auth endpoints.
//       serializeCookie(AUTH_COOKIES.refresh, t.refreshToken, { ...base, path: '/v1/auth', maxAgeSeconds: cfg.refreshTtlSeconds }),
//     );
//     return res;
//   };
//   const clearSession = (res: HttpResponse): HttpResponse => {
//     const base = { secure: cfg.secureCookies, sameSite: cfg.sameSite, httpOnly: true } as const;
//     res.cookies.push(clearCookie(AUTH_COOKIES.access, { ...base, path: '/' }), clearCookie(AUTH_COOKIES.refresh, { ...base, path: '/v1/auth' }));
//     return res;
//   };
//   const cookieOf = (req: HttpRequest, name: string): string | undefined => parseCookies(req.headers.cookie)[name];
//   const clientCtx = (req: HttpRequest) => ({ userAgent: req.headers['user-agent'] ?? null, ipHash: hashToken(`ip:${req.ip}`).slice(0, 32) });

//   /* ------------------------------------------------------------------ auth */
//   open({ method: 'POST', pattern: '/v1/auth/register', limits: [{ name: 'register', limit: 10, windowMs: HOUR }], handler: async ({ req }) => {
//     const f = new Fields(req.body); const email = f.str('email', { max: 320 }); const password = f.str('password', { max: 256 }); f.done();
//     await d.auth.signup(email, password);
//     return json(202, { status: 'VERIFICATION_SENT' });
//   } });
//   open({ method: 'POST', pattern: '/v1/auth/verify-email', limits: [{ name: 'verify', limit: 20, windowMs: HOUR }], handler: async ({ req }) => {
//     const f = new Fields(req.body); const token = f.str('token', { max: 200 }); f.done();
//     await d.auth.verifyEmail(token);
//     return json(204);
//   } });
//   open({ method: 'POST', pattern: '/v1/auth/login', limits: [{ name: 'login-ip', limit: 30, windowMs: 10 * MIN }, { name: 'login-email', limit: 10, windowMs: 10 * MIN, by: emailKey }], handler: async ({ req }) => {
//     const f = new Fields(req.body); const email = f.str('email', { max: 320 }); const password = f.str('password', { max: 256 }); f.done();
//     const t = await d.auth.login(email, password, clientCtx(req));
//     return setSession(json(200, { user: toUserDto(t.user) }), t);
//   } });
//   open({ method: 'POST', pattern: '/v1/auth/refresh', limits: [{ name: 'refresh', limit: 120, windowMs: MIN }], handler: async ({ req }) => {
//     const raw = cookieOf(req, AUTH_COOKIES.refresh);
//       d.logger.info({
//         event: 'auth.refresh.cookie',
//         present: Boolean(raw),
//       }, 'refresh cookie received');
//     if (!raw) return clearSession(errRes(new AppError('UNAUTHENTICATED', 'Session expired. Sign in again.'), 'refresh'));
//     try {
//       const t = await d.auth.refresh(raw, clientCtx(req));
//       return setSession(json(200, { user: toUserDto(t.user) }), t);
//     } catch (e) {
//       if (e instanceof AppError && e.code === 'UNAUTHENTICATED') return clearSession(errRes(e, 'refresh')); // a dead session must not linger in the browser
//       throw e;
//     }
//   } });
//   open({ method: 'POST', pattern: '/v1/auth/logout', handler: async ({ req }) => {
//     await d.auth.logout(cookieOf(req, AUTH_COOKIES.refresh));
//     return clearSession(json(204));
//   } });
//   open({ method: 'POST', pattern: '/v1/auth/forgot-password', limits: [{ name: 'forgot-ip', limit: 10, windowMs: HOUR }, { name: 'forgot-email', limit: 3, windowMs: HOUR, by: emailKey }], handler: async ({ req }) => {
//     const f = new Fields(req.body); const email = f.str('email', { max: 320 }); f.done();
//     await d.auth.requestPasswordReset(email);
//     return json(204); // identical for known and unknown addresses
//   } });
//   open({ method: 'POST', pattern: '/v1/auth/reset-password', limits: [{ name: 'reset', limit: 10, windowMs: HOUR }], handler: async ({ req }) => {
//     const f = new Fields(req.body); const token = f.str('token', { max: 200 }); const password = f.str('password', { max: 256 }); f.done();
//     await d.auth.resetPassword(token, password);
//     return clearSession(json(204));
//   } });

//   /* -------------------------------------------------------------------- me */
//   user({ method: 'GET', pattern: '/v1/me', handler: async ({ principal }) => json(200, toUserDto(await d.auth.getUser(principal!.userId))) });
//   user({ method: 'PATCH', pattern: '/v1/me/password', limits: [{ name: 'chpw', limit: 10, windowMs: HOUR }], handler: async ({ req, principal }) => {
//     const f = new Fields(req.body); const cur = f.str('currentPassword', { max: 256 }); const next = f.str('newPassword', { max: 256 }); f.done();
//     await d.auth.changePassword(principal!.userId, cur, next);
//     return clearSession(json(204)); // every session was revoked
//   } });
//   user({ method: 'DELETE', pattern: '/v1/me', limits: [{ name: 'delacct', limit: 5, windowMs: HOUR }], handler: async ({ req, principal }) => {
//     const f = new Fields(req.body); const password = f.str('password', { max: 256 }); f.done();
//     return clearSession(json(200, toUserDto(await d.me.deleteAccount(principal!.userId, password))));
//   } });
//   user({ method: 'POST', pattern: '/v1/me/cancel-deletion', handler: async ({ principal }) => json(200, toUserDto(await d.auth.cancelDeletion(principal!.userId))) });
//   user({ method: 'GET', pattern: '/v1/settings', handler: async ({ principal }) => json(200, await d.settings.get(principal!.userId)) });
//   user({ method: 'PATCH', pattern: '/v1/settings', handler: async ({ req, principal }) => {
//     const f = new Fields(req.body);
//     const tz = f.optStr('timezone', { max: 64 }); const batchSize = f.optInt('batchSize'); const intervalMinutes = f.optInt('intervalMinutes');
//     const cycleDurationHours = f.optInt('cycleDurationHours'); const loopEnabled = f.optBool('loopEnabled');
//     const acct = (req.body as { defaultInstagramAccountId?: unknown } | undefined)?.defaultInstagramAccountId;
//     let defaultAccount: string | null | undefined;
//     if (acct === null) defaultAccount = null; else if (acct !== undefined) defaultAccount = uuidParam(typeof acct === 'string' ? acct : '', 'Instagram account');
//     f.done();
//     return json(200, await d.settings.update(principal!.userId, {
//       ...(tz !== undefined ? { timezone: tz } : {}), ...(batchSize !== undefined ? { batchSize } : {}), ...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
//       ...(cycleDurationHours !== undefined ? { cycleDurationHours } : {}), ...(loopEnabled !== undefined ? { loopEnabled } : {}),
//       ...(defaultAccount !== undefined ? { defaultInstagramAccountId: defaultAccount } : {}),
//     }));
//   } });

//   /* ------------------------------------------------------------- instagram */
//   user({ method: 'GET', pattern: '/v1/instagram/accounts', handler: async ({ principal }) => json(200, await d.accounts.list(principal!.userId)) });
//   user({ method: 'POST', pattern: '/v1/instagram/mock-connect', handler: async ({ req, principal }) => {
//     const f = new Fields(req.body); const username = f.str('username', { max: 30 }); f.done();
//     return json(201, await d.accounts.mockConnect(principal!.userId, username));
//   } });
//   const OAUTH_COOKIE = 'rq_oauth';
//   const oauthCookieOpts = { path: '/v1/instagram', httpOnly: true, secure: true, sameSite: 'None' } as const; // Lax: Meta redirects the browser back with a top-level GET
//   // user({ method: 'POST', pattern: '/v1/instagram/connect', limits: [{ name: 'ig-connect', limit: 20, windowMs: HOUR, by: (r) => r.ip }], handler: async ({ principal }) => {
//   //   if (!d.instagramConnect) throw new AppError('NOT_FOUND', 'Instagram connection is not enabled.');
//   //   const { authorizationUrl, nonce } = d.instagramConnect.start(principal!.userId);
//   //   const res = json(200, { authorizationUrl });
//   //   res.cookies.push(serializeCookie(OAUTH_COOKIE, nonce, { ...oauthCookieOpts, maxAgeSeconds: 600 }));
//   //   return res;
//   // } });
//   user({
//     method: 'POST',
//     pattern: '/v1/instagram/connect',
//     limits: [
//       {
//         name: 'ig-connect',
//         limit: 20,
//         windowMs: HOUR,
//         by: (r) => r.ip,
//       },
//     ],
//     handler: async ({ principal, requestId }) => {
//       d.logger.info({
//         event: "instagram.oauth.cookie.set",
//         requestId,
//         cookieName: OAUTH_COOKIE,
//         cookiePath: "/v1/instagram",
//         userId: principal!.userId,
//         providerEnabled: Boolean(d.instagramConnect),
//         secure: cfg.secureCookies,
//         sameSite: "Lax",
//         maxAgeSeconds: 600,
//         setCookieAddedToResponse: true,
//       }, "Instagram OAuth cookie added to response");

//       if (!d.instagramConnect) {
//         d.logger.error({
//           event: 'instagram.oauth.connect.disabled',
//           requestId,
//         }, 'Instagram OAuth provider is disabled');

//         throw new AppError(
//           'NOT_FOUND',
//           'Instagram connection is not enabled.',
//         );
//       }

//       const { authorizationUrl, nonce } =
//         d.instagramConnect.start(principal!.userId);

//       d.logger.info({
//         event: 'instagram.oauth.connect.state_created',
//         requestId,
//         nonceCreated: Boolean(nonce),
//         authorizationUrlCreated: Boolean(authorizationUrl),
//         cookieName: OAUTH_COOKIE,
//         cookiePath: oauthCookieOpts.path,
//         cookieSecure: oauthCookieOpts.secure,
//         cookieSameSite: oauthCookieOpts.sameSite,
//         cookieHttpOnly: oauthCookieOpts.httpOnly,
//         cookieMaxAgeSeconds: 600,
//       }, 'Instagram OAuth state and cookie prepared');

//       const res = json(200, { authorizationUrl });

//       res.cookies.push(
//         serializeCookie(OAUTH_COOKIE, nonce, {
//           ...oauthCookieOpts,
//           maxAgeSeconds: 600,
//         }),
//       );

//       return res;
//     },
//   });
//   // Browser redirect from Meta. The session is authenticated INSIDE the handler so every outcome is a redirect to the web app
//   // (never a JSON 401 page). The outcome code is one of a fixed set; Meta-provided text is never echoed.
//   // open({ method: 'GET', pattern: '/v1/instagram/callback', limits: [{ name: 'ig-callback', limit: 30, windowMs: HOUR }], handler: async ({ req }) => {
//   //   const base = (cfg.webBaseUrl ?? cfg.allowedOrigins[0] ?? '').replace(/\/+$/, '');
//   //   const back = (q: string): HttpResponse => {
//   //     const r = json(302); r.headers.location = `${base}/accounts?${q}`;
//   //     r.cookies.push(clearCookie(OAUTH_COOKIE, oauthCookieOpts)); return r;
//   //   };
//   //   if (!d.instagramConnect) return back('error=NOT_ENABLED');
//   //   if (req.query.error !== undefined) return back('error=ACCESS_DENIED'); // the user declined (or Meta refused); details are not shown
//   //   const code = req.query.code, state = req.query.state, nonce = cookieOf(req, OAUTH_COOKIE);
//   //   if (!code || !state || !nonce || code.length > 2048 || state.length > 1024) return back('error=STATE_INVALID');
//   //   let p: Principal;
//   //   try { p = await d.auth.authenticate(cookieOf(req, AUTH_COOKIES.access)); } catch { return back('error=SESSION'); }
//   //   const r = await d.instagramConnect.complete({ userId: p.userId, code, state, nonce });
//   //   return back(r.ok ? 'connected=1' : `error=${r.reason}`);
//   // } });
//   open({
//     method: 'GET',
//     pattern: '/v1/instagram/callback',
//     limits: [
//       { name: 'ig-callback', limit: 30, windowMs: HOUR },
//     ],
//     handler: async ({ req, requestId }) => {
//       const cookieHeader = req.headers.cookie ?? "";
//       const cookieNames = cookieHeader.split(";").map((part) => part.trim().split("=")[0]).filter(Boolean);

//       d.logger.info({
//         event: "instagram.oauth.cookie.callback_received",
//         requestId,
//         cookieNames,
//         hasOAuthCookie: cookieNames.includes(OAUTH_COOKIE),
//         hasAccessCookie: Boolean(cookieOf(req, AUTH_COOKIES.access)),
//       }, "Instagram OAuth callback cookie diagnostic");
//       const base = (
//         cfg.webBaseUrl ?? cfg.allowedOrigins[0] ?? ''
//       ).replace(/\/+$/, '');

//       const back = (q: string): HttpResponse => {
//         const res = json(302);
//         res.headers.location = `${base}/accounts?${q}`;
//         d.logger.info({
//           event: "instagram.oauth.cookie.clear",
//           requestId,
//           cookieName: OAUTH_COOKIE,
//           cookiePath: "/v1/instagram",
//           redirectQuery: q,
//         }, "Instagram OAuth cookie clear instructed");
//         res.cookies.push(clearCookie(OAUTH_COOKIE, oauthCookieOpts));
//         return res;
//       };

//       // Log 1: callback reached backend.
//       d.logger.info({
//         event: 'instagram.oauth.callback.received',
//         requestId,
//         providerEnabled: Boolean(d.instagramConnect),
//         hasCode: Boolean(req.query.code),
//         hasState: Boolean(req.query.state),
//         providerReturnedError: req.query.error !== undefined,
//         hasOAuthCookie: Boolean(cookieOf(req, OAUTH_COOKIE)),
//         hasAccessCookie: Boolean(cookieOf(req, AUTH_COOKIES.access)),
//         cookieHeaderPresent: Boolean(req.headers.cookie),
//         userAgentPresent: Boolean(req.headers['user-agent']),
//       }, 'Instagram OAuth callback received');

//       if (!d.instagramConnect) {
//         d.logger.error({
//           event: 'instagram.oauth.callback.rejected',
//           requestId,
//           reason: 'NOT_ENABLED',
//         }, 'Instagram OAuth callback rejected');

//         return back('error=NOT_ENABLED');
//       }

//       if (req.query.error !== undefined) {
//         d.logger.info({
//           event: 'instagram.oauth.callback.rejected',
//           requestId,
//           reason: 'ACCESS_DENIED',
//         }, 'Instagram OAuth provider returned an error');

//         return back('error=ACCESS_DENIED');
//       }

//       const code = req.query.code;
//       const state = req.query.state;
//       const nonce = cookieOf(req, OAUTH_COOKIE);

//       // Log 2: determine which required field is missing/invalid.
//       const missing = {
//         code: !code,
//         state: !state,
//         nonce: !nonce,
//       };

//       const tooLong = {
//         code: Boolean(code && code.length > 2048),
//         state: Boolean(state && state.length > 1024),
//       };

//       if (
//         !code || !state || !nonce ||
//         code.length > 2048 || state.length > 1024
//       ) {
//         d.logger.error({
//           event: 'instagram.oauth.callback.rejected',
//           requestId,
//           reason: 'STATE_INVALID',
//           missing,
//           tooLong,
//         }, 'Instagram OAuth callback missing required data');

//         return back('error=STATE_INVALID');
//       }

//       // Log 3: session authentication.
//       let p: Principal;

//       try {
//         p = await d.auth.authenticate(
//           cookieOf(req, AUTH_COOKIES.access),
//         );

//         d.logger.info({
//           event: 'instagram.oauth.callback.session_valid',
//           requestId,
//           userId: p.userId,
//         }, 'Instagram OAuth callback session validated');
//       } catch (e) {
//         d.logger.error({
//           event: 'instagram.oauth.callback.session_invalid',
//           requestId,
//           reason: e instanceof AppError ? e.code : 'UNEXPECTED_ERROR',
//         }, 'Instagram OAuth callback session validation failed');

//         return back('error=SESSION');
//       }

//       // Log 4: state verification and provider exchange happen inside service.
//       d.logger.info({
//         event: 'instagram.oauth.callback.completion_started',
//         requestId,
//         userId: p.userId,
//         codePresent: Boolean(code),
//         statePresent: Boolean(state),
//         noncePresent: Boolean(nonce),
//       }, 'Instagram OAuth completion started');

//       const result = await d.instagramConnect.complete({
//         userId: p.userId,
//         code,
//         state,
//         nonce,
//       });

//       d.logger.info({
//         event: 'instagram.oauth.callback.completion_finished',
//         requestId,
//         userId: p.userId,
//         success: result.ok,
//         reason: result.ok ? 'CONNECTED' : result.reason,
//       }, 'Instagram OAuth completion finished');

//       return back(
//         result.ok ? 'connected=1' : `error=${result.reason}`,
//       );
//     },
//   });
//   user({ method: 'POST', pattern: '/v1/instagram/accounts/:id/disconnect', handler: async ({ params, principal }) => json(200, await d.accounts.disconnect(principal!.userId, uuidParam(params.id, 'Instagram account'))) });
//   user({ method: 'POST', pattern: '/v1/instagram/accounts/:id/refresh-quota', limits: [{ name: 'quota', limit: 30, windowMs: HOUR }], handler: async ({ params, principal }) => json(200, await d.accounts.refreshQuota(principal!.userId, uuidParam(params.id, 'Instagram account'))) });



//   /* ------------------------------------------------------------GoogleDrive  */
//   /* ---------------------------------------------------------- google drive (optional) */
//   const gd = (): GoogleDriveService => { if (!d.googleDrive) throw new AppError('NOT_FOUND', 'Google Drive is not enabled.'); return d.googleDrive; };
//   const DRIVE_ID = /^[A-Za-z0-9_-]{10,128}$/;
//   const driveId = (v: string | undefined): string => { if (!v || !DRIVE_ID.test(v)) throw new AppError('NOT_FOUND', 'File not found.'); return v; };
//   user({ method: 'GET', pattern: '/v1/google-drive/status', handler: async ({ principal }) => json(200, d.googleDrive ? await d.googleDrive.status(principal!.userId) : { enabled: false, status: 'NOT_CONNECTED', scopes: [], connectedAt: null }) });
//   user({ method: 'POST', pattern: '/v1/google-drive/connect', limits: [{ name: 'gd-connect', limit: 20, windowMs: HOUR }], handler: async ({ principal }) => json(200, await gd().start(principal!.userId)) });
//   // Browser redirect from Google. The state (single use, hashed in the DB, bound to the user) AND the logged-in session must agree.
//   // Every outcome is a redirect to the web app with a code from a fixed set; Google-provided text is never echoed.
//   open({ method: 'GET', pattern: '/v1/google-drive/callback', limits: [{ name: 'gd-callback', limit: 30, windowMs: HOUR }], handler: async ({ req }) => {
//     const base = (cfg.webBaseUrl ?? cfg.allowedOrigins[0] ?? '').replace(/\/+$/, '');
//     const back = (q: string): HttpResponse => { const r = json(302); r.headers.location = `${base}/storage?${q}`; return r; };
//     if (!d.googleDrive) return back('error=NOT_ENABLED');
//     if (req.query.error !== undefined) return back('error=ACCESS_DENIED');
//     const code = req.query.code, state = req.query.state;
//     if (!code || !state || code.length > 2048 || state.length > 512) return back('error=STATE_INVALID');
//     let p: Principal;
//     try { p = await d.auth.authenticate(cookieOf(req, AUTH_COOKIES.access)); } catch { return back('error=SESSION'); }
//     const r = await d.googleDrive.complete({ sessionUserId: p.userId, code, state });
//     return back(r.ok ? 'connected=1' : `error=${r.reason}`);
//   } });
//   user({ method: 'GET', pattern: '/v1/google-drive/files', limits: [{ name: 'gd-list', limit: 600, windowMs: HOUR }], handler: async ({ req, principal }) => {
//     const size = queryInt(req.query, 'pageSize', { min: 1, max: 100 }); const tok = req.query.pageToken;
//     if (tok !== undefined && !/^[\x21-\x7e]{1,2048}$/.test(tok)) throw new AppError('VALIDATION_FAILED', 'Invalid input.', [{ field: 'pageToken', message: 'Invalid page token.' }]);
//     return json(200, await gd().list(principal!.userId, { ...(size !== undefined ? { pageSize: size } : {}), ...(tok ? { pageToken: tok } : {}) }));
//   } });
//   user({ method: 'GET', pattern: '/v1/google-drive/files/:id', limits: [{ name: 'gd-get', limit: 600, windowMs: HOUR }], handler: async ({ params, principal }) => json(200, await gd().get(principal!.userId, driveId(params.id))) });
//   user({ method: 'POST', pattern: '/v1/google-drive/uploads', limits: [{ name: 'gd-upload', limit: 60, windowMs: HOUR }], handler: async ({ req, principal }) => {
//     const f = new Fields(req.body); const filename = f.str('filename', { max: 255 }); const contentType = f.str('contentType', { max: 100 }); const sizeBytes = f.int('sizeBytes', { min: 1, max: Number.MAX_SAFE_INTEGER }); f.done();
//     return json(200, await gd().startUpload(principal!.userId, { filename, contentType, sizeBytes }));
//   } });
//   user({ method: 'GET', pattern: '/v1/google-drive/files/:id/content', limits: [{ name: 'gd-download', limit: 120, windowMs: HOUR }], handler: async ({ params, principal }) => {
//     const f = await gd().openDownload(principal!.userId, driveId(params.id));
//     const res = json(200); res.stream = f.stream;
//     // Always an opaque attachment: Drive content is user-controlled, so it must never render as a page in our origin.
//     res.headers['content-type'] = 'application/octet-stream';
//     res.headers['content-disposition'] = `attachment; filename="${f.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file'}"; filename*=UTF-8''${encodeURIComponent(f.name)}`;
//     if (f.sizeBytes !== null) res.headers['content-length'] = String(f.sizeBytes);
//     return res;
//   } });
//   user({ method: 'DELETE', pattern: '/v1/google-drive/files/:id', limits: [{ name: 'gd-delete', limit: 120, windowMs: HOUR }], handler: async ({ params, principal }) => { await gd().delete(principal!.userId, driveId(params.id)); return json(204); } });
//   user({ method: 'DELETE', pattern: '/v1/google-drive/connection', limits: [{ name: 'gd-disconnect', limit: 30, windowMs: HOUR }], handler: async ({ principal }) => { await gd().disconnect(principal!.userId); return json(204); } });

//   /* --------------------------------------------------------------- uploads */
//   user({ method: 'POST', pattern: '/v1/uploads/init', limits: [{ name: 'upload-init', limit: 60, windowMs: HOUR }], handler: async ({ req, principal }) => {
//     const f = new Fields(req.body);
//     const files = f.objects('files', { min: 1, max: 500 }).map((x) => ({ filename: x.str('filename', { max: 255 }), contentType: x.str('contentType', { max: 100 }), sizeBytes: x.int('sizeBytes', { min: 0, max: Number.MAX_SAFE_INTEGER }) }));
//     f.done();
//     const r = await d.uploads.createBatch(principal!.userId, files);
//     if (!r.batchId || !r.expiresAt) throw new AppError('VALIDATION_FAILED', 'None of the files can be uploaded.', r.rejected.map((x) => ({ field: `files[${x.index}]`, message: x.message })));
//     return json(200, { batchId: r.batchId, expiresAt: r.expiresAt.toISOString(), targets: r.uploads.map((u) => ({ index: u.index, videoId: u.videoId, uploadUrl: u.url, headers: u.headers })), rejected: r.rejected });
//   } });
//   user({ method: 'POST', pattern: '/v1/uploads/:batchId/complete', handler: async ({ req, params, principal }) => {
//     const f = new Fields(req.body); const uploaded = f.stringArray('uploaded', { max: 500, itemMax: 40 }); const failed = f.optStringArray('failed', { max: 500 }); f.done();
//     return json(200, await d.flow.completeBatch(principal!.userId, uuidParam(params.batchId, 'Upload batch'), { uploaded: uploaded.map((x) => uuidParam(x, 'Video')), ...(failed ? { failed: failed.map((x) => uuidParam(x, 'Video')) } : {}) }));
//   } });
//   user({ method: 'GET', pattern: '/v1/videos', handler: async ({ req, principal }) => json(200, await d.read.listVideos(principal!.userId, {
//     ...(queryEnum(req.query, 'status', ['PENDING_UPLOAD', 'VALIDATING', 'READY', 'REJECTED', 'FAILED'] as const) ? { status: queryEnum(req.query, 'status', ['PENDING_UPLOAD', 'VALIDATING', 'READY', 'REJECTED', 'FAILED'] as const)! } : {}),
//     ...(queryInt(req.query, 'page', { min: 1, max: 100000 }) !== undefined ? { page: queryInt(req.query, 'page', { min: 1, max: 100000 })! } : {}),
//     ...(queryInt(req.query, 'pageSize', { min: 1, max: 100 }) !== undefined ? { pageSize: queryInt(req.query, 'pageSize', { min: 1, max: 100 })! } : {}),
//   })) });
//   user({ method: 'PUT', pattern: '/v1/videos/order', handler: async ({ req, principal }) => {
//     const f = new Fields(req.body); const ids = f.stringArray('videoIds', { max: 5000, itemMax: 40 }); f.done();
//     await d.uploads.reorder(principal!.userId, ids.map((x) => uuidParam(x, 'Video')));
//     return json(204);
//   } });
//   user({ method: 'PATCH', pattern: '/v1/videos/:id', handler: async ({ req, params, principal }) => {
//     const f = new Fields(req.body); const caption = f.nullableStr('caption', 2200); f.done();
//     const v = await d.uploads.updateCaption(principal!.userId, uuidParam(params.id, 'Video'), caption ?? null);
//     return json(200, (await d.read.videoDtos(principal!.userId, [v]))[0]);
//   } });
//   user({ method: 'DELETE', pattern: '/v1/videos/:id', handler: async ({ params, principal }) => { await d.uploads.deleteVideo(principal!.userId, uuidParam(params.id, 'Video')); return json(204); } });
//   user({ method: 'GET', pattern: '/v1/videos/:id/preview', handler: async ({ params, principal }) => {
//     const p = await d.uploads.preview(principal!.userId, uuidParam(params.id, 'Video'));
//     return json(200, { url: p.url, expiresAt: p.expiresAt.toISOString() });
//   } });
//   user({ method: 'GET', pattern: '/v1/storage', handler: async ({ principal }) => json(200, await d.read.storage(principal!.userId)) });

//   /* ---------------------------------------------------------------- cycles */
//   user({ method: 'GET', pattern: '/v1/cycles/current', handler: async ({ principal }) => json(200, await d.read.currentCycle(principal!.userId)) });
//   user({ method: 'GET', pattern: '/v1/cycles', handler: async ({ req, principal }) => json(200, await d.read.listCycles(principal!.userId, {
//     ...(queryInt(req.query, 'page', { min: 1, max: 100000 }) !== undefined ? { page: queryInt(req.query, 'page', { min: 1, max: 100000 })! } : {}),
//     ...(queryInt(req.query, 'pageSize', { min: 1, max: 100 }) !== undefined ? { pageSize: queryInt(req.query, 'pageSize', { min: 1, max: 100 })! } : {}),
//   })) });
//   user({ method: 'POST', pattern: '/v1/cycles', limits: [{ name: 'cycle-start', limit: 30, windowMs: HOUR }], handler: async ({ req, principal }) => {
//     const f = new Fields(req.body);
//     const id = f.str('instagramAccountId', { max: 40 }); const batchSize = f.optInt('batchSize'); const intervalMinutes = f.optInt('intervalMinutes');
//     const loopEnabled = f.optBool('loopEnabled'); const durationHours = f.optInt('durationHours'); f.done();
//     return json(201, await d.cycles.start(principal!.userId, {
//       instagramAccountId: uuidParam(id, 'Instagram account'), ...(batchSize !== undefined ? { batchSize } : {}), ...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
//       ...(loopEnabled !== undefined ? { loopEnabled } : {}), ...(durationHours !== undefined ? { durationHours } : {}),
//     }));
//   } });
//   user({ method: 'POST', pattern: '/v1/cycles/:id/pause', handler: async ({ params, principal }) => json(200, await d.cycles.pause(principal!.userId, uuidParam(params.id, 'Cycle'))) });
//   user({ method: 'POST', pattern: '/v1/cycles/:id/resume', handler: async ({ params, principal }) => json(200, await d.cycles.resume(principal!.userId, uuidParam(params.id, 'Cycle'))) });
//   user({ method: 'POST', pattern: '/v1/cycles/:id/stop', handler: async ({ params, principal }) => json(200, await d.cycles.stop(principal!.userId, uuidParam(params.id, 'Cycle'))) });
//   user({ method: 'PATCH', pattern: '/v1/cycles/:id', handler: async ({ req, params, principal }) => {
//     const f = new Fields(req.body); const loop = f.bool('loopEnabled'); f.done();
//     return json(200, await d.cycles.setLoop(principal!.userId, uuidParam(params.id, 'Cycle'), loop));
//   } });

//   /* ------------------------------------------------------------------ jobs */
//   user({ method: 'GET', pattern: '/v1/jobs/upcoming', handler: async ({ principal }) => json(200, await d.read.upcomingJobs(principal!.userId)) });
//   user({ method: 'GET', pattern: '/v1/jobs', handler: async ({ req, principal }) => {
//     const page = queryInt(req.query, 'page', { min: 1, max: 100000 }); const pageSize = queryInt(req.query, 'pageSize', { min: 1, max: 100 });
//     const status = queryEnum(req.query, 'status', ['SCHEDULED', 'DEFERRED', 'RETRY_WAIT', 'CREATING_CONTAINER', 'PROCESSING_MEDIA', 'PUBLISH_REQUESTED', 'ACCEPTED', 'CONFIRMED', 'SIMULATED', 'FAILED', 'CANCELLED', 'EXPIRED'] as const);
//     const cycleId = req.query.cycleId !== undefined ? uuidParam(req.query.cycleId, 'Cycle') : undefined;
//     return json(200, await d.read.listJobs(principal!.userId, {
//       ...(page !== undefined ? { page } : {}), ...(pageSize !== undefined ? { pageSize } : {}), ...(status ? { status } : {}), ...(cycleId ? { cycleId } : {}),
//       ...(req.query.from !== undefined ? { from: req.query.from } : {}), ...(req.query.to !== undefined ? { to: req.query.to } : {}),
//     }));
//   } });
//   user({ method: 'POST', pattern: '/v1/jobs/:id/retry', limits: [{ name: 'job-retry', limit: 60, windowMs: HOUR }], handler: async ({ params, principal }) => json(200, await d.cycles.retryJob(principal!.userId, uuidParam(params.id, 'Job'))) });
//   user({ method: 'GET', pattern: '/v1/dashboard', handler: async ({ principal }) => json(200, await d.read.dashboard(principal!.userId)) });

//   /* ---------------------------------------------------------------- health */
//   open({ method: 'GET', pattern: '/health/live', handler: async () => json(200, { status: 'ok' }) });
//   open({ method: 'GET', pattern: '/health/ready', handler: async () => {
//     const [db, redis] = await Promise.all([d.checks.database().catch(() => false), d.checks.redis().catch(() => false)]);
//     return json(db && redis ? 200 : 503, { status: db && redis ? 'ok' : 'degraded', database: db ? 'up' : 'down', redis: redis ? 'up' : 'down' });
//   } });

//   /* ------------------------------------------------------------- pipeline */
//   function errRes(e: unknown, requestId: string): HttpResponse {
//     if (e instanceof AppError) {
//       const res = json(API_ERROR_STATUS[e.code], errorBody(e.code, e.message, requestId, e.details ? [...e.details] : undefined));
//       return res;
//     }
//     d.logger.error({ requestId, err: e instanceof Error ? { name: e.name, message: e.message } : 'unknown' }, 'unhandled error');
//     return json(500, errorBody('INTERNAL', 'Something went wrong.', requestId)); // never leaks internals
//   }

//   const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
//   return async function handle(req: HttpRequest): Promise<HttpResponse> {
//     const started = Date.now();
//     const incoming = req.headers['x-request-id'];
//     const requestId = incoming && /^[A-Za-z0-9._-]{8,64}$/.test(incoming) ? incoming : randomUUID();
//     let principal: Principal | null = null;
//     let res: HttpResponse;
//     try {
//       res = await (async () => {
//         const origin = req.headers.origin;
//         const originAllowed = origin !== undefined && cfg.allowedOrigins.includes(origin);
//         if (req.method === 'OPTIONS') {
//           const pre = json(204);
//           if (originAllowed) { pre.headers['access-control-allow-methods'] = 'GET,POST,PUT,PATCH,DELETE,OPTIONS'; pre.headers['access-control-allow-headers'] = 'content-type,x-request-id'; pre.headers['access-control-max-age'] = '600'; }
//           return pre;
//         }
//         // CSRF: a browser always sends Origin on cross-site state-changing requests; anything not on the allow-list is refused.
//         if (!SAFE.has(req.method) && origin !== undefined && !originAllowed) throw new AppError('FORBIDDEN', 'Origin not allowed.');
//         const g = await d.limiter.check(`g:${req.ip}`, cfg.globalPerMinute, MIN);
//         if (!g.allowed) return rateLimited(g.retryAfterSeconds, requestId);
//         const m = router.match(req.method, req.path);
//         if (!('route' in m)) {
//           const r = m.status === 405 ? json(405, errorBody('NOT_FOUND', 'Method not allowed.', requestId)) : json(404, errorBody('NOT_FOUND', 'Not found.', requestId));
//           if (m.status === 405) r.headers.allow = m.allow.join(', ');
//           return r;
//         }
//         for (const rule of m.route.limits ?? []) {
//           const by = rule.by ? rule.by(req) : undefined;
//           const dec = await d.limiter.check(`${rule.name}:${by ?? req.ip}`, rule.limit, rule.windowMs);
//           if (!dec.allowed) return rateLimited(dec.retryAfterSeconds, requestId);
//         }

//         if (m.route.auth !== 'none') {
//           const accessToken = cookieOf(req, AUTH_COOKIES.access);

//           d.logger.info({
//             event: 'auth.cookie.received',
//             requestId,
//             path: req.path,
//             cookieName: AUTH_COOKIES.access,
//             present: Boolean(accessToken),
//           }, 'auth cookie received');

//           try {
//             principal = await d.auth.authenticate(accessToken);

//             d.logger.info({
//               event: 'auth.validation',
//               requestId,
//               path: req.path,
//               valid: true,
//             }, 'auth validation result');

//           } catch (e) {
//             d.logger.info({
//               event: 'auth.validation',
//               requestId,
//               path: req.path,
//               valid: false,
//               reason: e instanceof AppError
//                 ? e.code
//                 : 'UNEXPECTED_ERROR',
//             }, 'auth validation result');

//             throw e;
//           }

//           if (m.route.auth === 'admin' && principal.role !== 'ADMIN') {
//             throw new AppError('FORBIDDEN', 'Forbidden.');
//           }
//       }

//         return m.route.handler({ req, params: m.params, principal, requestId });
//       })();
//     } catch (e) {
//       res = errRes(e, requestId);
//     }
//     res.headers['x-request-id'] = requestId;
//     res.headers['x-content-type-options'] = 'nosniff';
//     res.headers['cache-control'] = 'no-store';
//     res.headers['referrer-policy'] = 'no-referrer';
//     res.headers['x-frame-options'] = 'DENY';
//     if (cfg.secureCookies) res.headers['strict-transport-security'] = 'max-age=63072000; includeSubDomains';
//     const origin = req.headers.origin;
//     if (origin !== undefined && cfg.allowedOrigins.includes(origin)) {
//       res.headers['access-control-allow-origin'] = origin;
//       res.headers['access-control-allow-credentials'] = 'true';
//       res.headers.vary = 'Origin';
//     }
//     d.logger.info({ requestId, method: req.method, path: req.path, status: res.status, ms: Date.now() - started, ...(principal ? { userId: (principal as Principal).userId } : {}) }, 'request');
//     return res;
//   };

//   function rateLimited(retryAfterSeconds: number, requestId: string): HttpResponse {
//     const r = json(429, errorBody('RATE_LIMITED', 'Too many requests. Please slow down.', requestId));
//     r.headers['retry-after'] = String(retryAfterSeconds);
//     return r;
//   }
// }























// packages/http/src/app.ts
import { randomUUID } from 'node:crypto';
import { hashToken, parseCookies, serializeCookie, clearCookie, type Clock, type RateLimiter } from '@reelqueue/core';
import type { UserRow } from '@reelqueue/db';
import {
  AccountService, AuthService, CycleService, InstagramConnectService, MeService, ReadService, SettingsService, UploadFlow, UploadService, type SessionTokens
} from '@reelqueue/services';
import { API_ERROR_STATUS, AUTH_COOKIES, AppError, type ApiErrorBody, type UserDto } from '@reelqueue/shared';
import { json, type HttpRequest, type HttpResponse } from './http';
import { Router, type Principal, type RouteDef } from './router';
import { Fields, queryEnum, queryInt, uuidParam } from './validate';
import { GoogleDriveService } from '@reelqueue/services'
import { Readable } from 'node:stream';



// Safe diagnostics for the Drive import: never log or return URLs (presigned URLs carry a signature).
const redactUrls = (s: string): string => s.replace(/https?:\/\/\S+/gi, '[url]').slice(0, 300);
function describeError(e: unknown): { name: string; message: string; code?: string } {
  if (e instanceof Error) {
    const cause = (e as { cause?: unknown }).cause as { code?: unknown } | undefined;
    const own = (e as { code?: unknown }).code;
    const code = typeof own === 'string' ? own : cause && typeof cause.code === 'string' ? cause.code : undefined;
    return { name: e.name, message: redactUrls(e.message), ...(code ? { code } : {}) };
  }
  return { name: 'NonError', message: 'unknown' };
}
/** Collects a stream into one buffer and checks it has exactly the expected number of bytes. */
async function readAll(stream: AsyncIterable<Uint8Array>, expected: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let n = 0;
  for await (const c of stream) {
    n += c.byteLength;
    if (n > expected) throw new Error('Drive stream exceeds declared size');
    chunks.push(c);
  }
  if (n !== expected) throw new Error('Drive stream size mismatch');
  return Buffer.concat(chunks, n);
}
const IMPORT_BUFFER_LIMIT = 64 * 1024 * 1024; // up to 64 MiB is held in memory (S3 needs a known Content-Length); larger files are streamed

  // NEW: HTTP headers ko case-insensitive read karta hai.
  function getRequestHeader(
    headers: Record<string, string | undefined>,
    headerName: string,
  ): string | undefined {
    const target = headerName.toLowerCase();

    for (const [name, value] of Object.entries(headers)) {
      if (name.toLowerCase() === target) {
        return value;
      }
    }

    return undefined;
  }

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

  // Google Drive Connect
  /** Present only when GOOGLE_DRIVE_* is configured. Without it every Drive route except /status behaves as not enabled. */
  googleDrive?: GoogleDriveService;
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
  open({
    method: 'POST', pattern: '/v1/auth/register', limits: [{ name: 'register', limit: 10, windowMs: HOUR }], handler: async ({ req }) => {
      const f = new Fields(req.body); const email = f.str('email', { max: 320 }); const password = f.str('password', { max: 256 }); f.done();
      await d.auth.signup(email, password);
      return json(202, { status: 'VERIFICATION_SENT' });
    }
  });
  open({
    method: 'POST', pattern: '/v1/auth/verify-email', limits: [{ name: 'verify', limit: 20, windowMs: HOUR }], handler: async ({ req }) => {
      const f = new Fields(req.body); const token = f.str('token', { max: 200 }); f.done();
      await d.auth.verifyEmail(token);
      return json(204);
    }
  });
  open({
    method: 'POST', pattern: '/v1/auth/login', limits: [{ name: 'login-ip', limit: 30, windowMs: 10 * MIN }, { name: 'login-email', limit: 10, windowMs: 10 * MIN, by: emailKey }], handler: async ({ req }) => {
      const f = new Fields(req.body); const email = f.str('email', { max: 320 }); const password = f.str('password', { max: 256 }); f.done();
      const t = await d.auth.login(email, password, clientCtx(req));
      return setSession(json(200, { user: toUserDto(t.user) }), t);
    }
  });
  open({
    method: 'POST', pattern: '/v1/auth/refresh', limits: [{ name: 'refresh', limit: 120, windowMs: MIN }], handler: async ({ req }) => {
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
    }
  });
  open({
    method: 'POST', pattern: '/v1/auth/logout', handler: async ({ req }) => {
      await d.auth.logout(cookieOf(req, AUTH_COOKIES.refresh));
      return clearSession(json(204));
    }
  });
  open({
    method: 'POST', pattern: '/v1/auth/forgot-password', limits: [{ name: 'forgot-ip', limit: 10, windowMs: HOUR }, { name: 'forgot-email', limit: 3, windowMs: HOUR, by: emailKey }], handler: async ({ req }) => {
      const f = new Fields(req.body); const email = f.str('email', { max: 320 }); f.done();
      await d.auth.requestPasswordReset(email);
      return json(204); // identical for known and unknown addresses
    }
  });
  open({
    method: 'POST', pattern: '/v1/auth/reset-password', limits: [{ name: 'reset', limit: 10, windowMs: HOUR }], handler: async ({ req }) => {
      const f = new Fields(req.body); const token = f.str('token', { max: 200 }); const password = f.str('password', { max: 256 }); f.done();
      await d.auth.resetPassword(token, password);
      return clearSession(json(204));
    }
  });

  /* -------------------------------------------------------------------- me */
  user({ method: 'GET', pattern: '/v1/me', handler: async ({ principal }) => json(200, toUserDto(await d.auth.getUser(principal!.userId))) });
  user({
    method: 'PATCH', pattern: '/v1/me/password', limits: [{ name: 'chpw', limit: 10, windowMs: HOUR }], handler: async ({ req, principal }) => {
      const f = new Fields(req.body); const cur = f.str('currentPassword', { max: 256 }); const next = f.str('newPassword', { max: 256 }); f.done();
      await d.auth.changePassword(principal!.userId, cur, next);
      return clearSession(json(204)); // every session was revoked
    }
  });
  user({
    method: 'DELETE', pattern: '/v1/me', limits: [{ name: 'delacct', limit: 5, windowMs: HOUR }], handler: async ({ req, principal }) => {
      const f = new Fields(req.body); const password = f.str('password', { max: 256 }); f.done();
      return clearSession(json(200, toUserDto(await d.me.deleteAccount(principal!.userId, password))));
    }
  });
  user({ method: 'POST', pattern: '/v1/me/cancel-deletion', handler: async ({ principal }) => json(200, toUserDto(await d.auth.cancelDeletion(principal!.userId))) });
  user({ method: 'GET', pattern: '/v1/settings', handler: async ({ principal }) => json(200, await d.settings.get(principal!.userId)) });
  user({
    method: 'PATCH', pattern: '/v1/settings', handler: async ({ req, principal }) => {
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
    }
  });

  /* ------------------------------------------------------------- instagram */
  user({ method: 'GET', pattern: '/v1/instagram/accounts', handler: async ({ principal }) => json(200, await d.accounts.list(principal!.userId)) });
  user({
    method: 'POST', pattern: '/v1/instagram/mock-connect', handler: async ({ req, principal }) => {
      const f = new Fields(req.body); const username = f.str('username', { max: 30 }); f.done();
      return json(201, await d.accounts.mockConnect(principal!.userId, username));
    }
  });
  const OAUTH_COOKIE = 'rq_oauth';
  const oauthCookieOpts = { path: '/v1/instagram', httpOnly: true, secure: true, sameSite: 'None' } as const; // Lax: Meta redirects the browser back with a top-level GET
  // user({ method: 'POST', pattern: '/v1/instagram/connect', limits: [{ name: 'ig-connect', limit: 20, windowMs: HOUR, by: (r) => r.ip }], handler: async ({ principal }) => {
  //   if (!d.instagramConnect) throw new AppError('NOT_FOUND', 'Instagram connection is not enabled.');
  //   const { authorizationUrl, nonce } = d.instagramConnect.start(principal!.userId);
  //   const res = json(200, { authorizationUrl });
  //   res.cookies.push(serializeCookie(OAUTH_COOKIE, nonce, { ...oauthCookieOpts, maxAgeSeconds: 600 }));
  //   return res;
  // } });
  user({
    method: 'POST',
    pattern: '/v1/instagram/connect',
    limits: [
      {
        name: 'ig-connect',
        limit: 20,
        windowMs: HOUR,
        by: (r) => r.ip,
      },
    ],
    handler: async ({ principal, requestId }) => {
      d.logger.info({
        event: "instagram.oauth.cookie.set",
        requestId,
        cookieName: OAUTH_COOKIE,
        cookiePath: "/v1/instagram",
        userId: principal!.userId,
        providerEnabled: Boolean(d.instagramConnect),
        secure: cfg.secureCookies,
        sameSite: "Lax",
        maxAgeSeconds: 600,
        setCookieAddedToResponse: true,
      }, "Instagram OAuth cookie added to response");

      if (!d.instagramConnect) {
        d.logger.error({
          event: 'instagram.oauth.connect.disabled',
          requestId,
        }, 'Instagram OAuth provider is disabled');

        throw new AppError(
          'NOT_FOUND',
          'Instagram connection is not enabled.',
        );
      }

      const { authorizationUrl, nonce } =
        d.instagramConnect.start(principal!.userId);

      d.logger.info({
        event: 'instagram.oauth.connect.state_created',
        requestId,
        nonceCreated: Boolean(nonce),
        authorizationUrlCreated: Boolean(authorizationUrl),
        cookieName: OAUTH_COOKIE,
        cookiePath: oauthCookieOpts.path,
        cookieSecure: oauthCookieOpts.secure,
        cookieSameSite: oauthCookieOpts.sameSite,
        cookieHttpOnly: oauthCookieOpts.httpOnly,
        cookieMaxAgeSeconds: 600,
      }, 'Instagram OAuth state and cookie prepared');

      const res = json(200, { authorizationUrl });

      res.cookies.push(
        serializeCookie(OAUTH_COOKIE, nonce, {
          ...oauthCookieOpts,
          maxAgeSeconds: 600,
        }),
      );

      return res;
    },
  });
  // Browser redirect from Meta. The session is authenticated INSIDE the handler so every outcome is a redirect to the web app
  // (never a JSON 401 page). The outcome code is one of a fixed set; Meta-provided text is never echoed.
  // open({ method: 'GET', pattern: '/v1/instagram/callback', limits: [{ name: 'ig-callback', limit: 30, windowMs: HOUR }], handler: async ({ req }) => {
  //   const base = (cfg.webBaseUrl ?? cfg.allowedOrigins[0] ?? '').replace(/\/+$/, '');
  //   const back = (q: string): HttpResponse => {
  //     const r = json(302); r.headers.location = `${base}/accounts?${q}`;
  //     r.cookies.push(clearCookie(OAUTH_COOKIE, oauthCookieOpts)); return r;
  //   };
  //   if (!d.instagramConnect) return back('error=NOT_ENABLED');
  //   if (req.query.error !== undefined) return back('error=ACCESS_DENIED'); // the user declined (or Meta refused); details are not shown
  //   const code = req.query.code, state = req.query.state, nonce = cookieOf(req, OAUTH_COOKIE);
  //   if (!code || !state || !nonce || code.length > 2048 || state.length > 1024) return back('error=STATE_INVALID');
  //   let p: Principal;
  //   try { p = await d.auth.authenticate(cookieOf(req, AUTH_COOKIES.access)); } catch { return back('error=SESSION'); }
  //   const r = await d.instagramConnect.complete({ userId: p.userId, code, state, nonce });
  //   return back(r.ok ? 'connected=1' : `error=${r.reason}`);
  // } });
  open({
    method: 'GET',
    pattern: '/v1/instagram/callback',
    limits: [
      { name: 'ig-callback', limit: 30, windowMs: HOUR },
    ],
    handler: async ({ req, requestId }) => {
      const cookieHeader = req.headers.cookie ?? "";
      const cookieNames = cookieHeader.split(";").map((part) => part.trim().split("=")[0]).filter(Boolean);

      d.logger.info({
        event: "instagram.oauth.cookie.callback_received",
        requestId,
        cookieNames,
        hasOAuthCookie: cookieNames.includes(OAUTH_COOKIE),
        hasAccessCookie: Boolean(cookieOf(req, AUTH_COOKIES.access)),
      }, "Instagram OAuth callback cookie diagnostic");
      const base = (
        cfg.webBaseUrl ?? cfg.allowedOrigins[0] ?? ''
      ).replace(/\/+$/, '');

      const back = (q: string): HttpResponse => {
        const res = json(302);
        res.headers.location = `${base}/accounts?${q}`;
        d.logger.info({
          event: "instagram.oauth.cookie.clear",
          requestId,
          cookieName: OAUTH_COOKIE,
          cookiePath: "/v1/instagram",
          redirectQuery: q,
        }, "Instagram OAuth cookie clear instructed");
        res.cookies.push(clearCookie(OAUTH_COOKIE, oauthCookieOpts));
        return res;
      };

      // Log 1: callback reached backend.
      d.logger.info({
        event: 'instagram.oauth.callback.received',
        requestId,
        providerEnabled: Boolean(d.instagramConnect),
        hasCode: Boolean(req.query.code),
        hasState: Boolean(req.query.state),
        providerReturnedError: req.query.error !== undefined,
        hasOAuthCookie: Boolean(cookieOf(req, OAUTH_COOKIE)),
        hasAccessCookie: Boolean(cookieOf(req, AUTH_COOKIES.access)),
        cookieHeaderPresent: Boolean(req.headers.cookie),
        userAgentPresent: Boolean(req.headers['user-agent']),
      }, 'Instagram OAuth callback received');

      if (!d.instagramConnect) {
        d.logger.error({
          event: 'instagram.oauth.callback.rejected',
          requestId,
          reason: 'NOT_ENABLED',
        }, 'Instagram OAuth callback rejected');

        return back('error=NOT_ENABLED');
      }

      if (req.query.error !== undefined) {
        d.logger.info({
          event: 'instagram.oauth.callback.rejected',
          requestId,
          reason: 'ACCESS_DENIED',
        }, 'Instagram OAuth provider returned an error');

        return back('error=ACCESS_DENIED');
      }

      const code = req.query.code;
      const state = req.query.state;
      const nonce = cookieOf(req, OAUTH_COOKIE);

      // Log 2: determine which required field is missing/invalid.
      const missing = {
        code: !code,
        state: !state,
        nonce: !nonce,
      };

      const tooLong = {
        code: Boolean(code && code.length > 2048),
        state: Boolean(state && state.length > 1024),
      };

      if (
        !code || !state || !nonce ||
        code.length > 2048 || state.length > 1024
      ) {
        d.logger.error({
          event: 'instagram.oauth.callback.rejected',
          requestId,
          reason: 'STATE_INVALID',
          missing,
          tooLong,
        }, 'Instagram OAuth callback missing required data');

        return back('error=STATE_INVALID');
      }

      // Log 3: session authentication.
      let p: Principal;

      try {
        p = await d.auth.authenticate(
          cookieOf(req, AUTH_COOKIES.access),
        );

        d.logger.info({
          event: 'instagram.oauth.callback.session_valid',
          requestId,
          userId: p.userId,
        }, 'Instagram OAuth callback session validated');
      } catch (e) {
        d.logger.error({
          event: 'instagram.oauth.callback.session_invalid',
          requestId,
          reason: e instanceof AppError ? e.code : 'UNEXPECTED_ERROR',
        }, 'Instagram OAuth callback session validation failed');

        return back('error=SESSION');
      }

      // Log 4: state verification and provider exchange happen inside service.
      d.logger.info({
        event: 'instagram.oauth.callback.completion_started',
        requestId,
        userId: p.userId,
        codePresent: Boolean(code),
        statePresent: Boolean(state),
        noncePresent: Boolean(nonce),
      }, 'Instagram OAuth completion started');

      const result = await d.instagramConnect.complete({
        userId: p.userId,
        code,
        state,
        nonce,
      });

      d.logger.info({
        event: 'instagram.oauth.callback.completion_finished',
        requestId,
        userId: p.userId,
        success: result.ok,
        reason: result.ok ? 'CONNECTED' : result.reason,
      }, 'Instagram OAuth completion finished');

      return back(
        result.ok ? 'connected=1' : `error=${result.reason}`,
      );
    },
  });
  user({ method: 'POST', pattern: '/v1/instagram/accounts/:id/disconnect', handler: async ({ params, principal }) => json(200, await d.accounts.disconnect(principal!.userId, uuidParam(params.id, 'Instagram account'))) });
  user({ method: 'POST', pattern: '/v1/instagram/accounts/:id/refresh-quota', limits: [{ name: 'quota', limit: 30, windowMs: HOUR }], handler: async ({ params, principal }) => json(200, await d.accounts.refreshQuota(principal!.userId, uuidParam(params.id, 'Instagram account'))) });



  /* ------------------------------------------------------------GoogleDrive  */
  /* ---------------------------------------------------------- google drive (optional) */
  const gd = (): GoogleDriveService => { if (!d.googleDrive) throw new AppError('NOT_FOUND', 'Google Drive is not enabled.'); return d.googleDrive; };
  const DRIVE_ID = /^[A-Za-z0-9_-]{10,128}$/;
  const driveId = (v: string | undefined): string => { if (!v || !DRIVE_ID.test(v)) throw new AppError('NOT_FOUND', 'File not found.'); return v; };
  user({ method: 'GET', pattern: '/v1/google-drive/status', handler: async ({ principal }) => json(200, d.googleDrive ? await d.googleDrive.status(principal!.userId) : { enabled: false, status: 'NOT_CONNECTED', scopes: [], connectedAt: null }) });
  user({ method: 'POST', pattern: '/v1/google-drive/connect', limits: [{ name: 'gd-connect', limit: 20, windowMs: HOUR }], handler: async ({ principal }) => json(200, await gd().start(principal!.userId)) });
  // Browser redirect from Google. The state (single use, hashed in the DB, bound to the user) AND the logged-in session must agree.
  // Every outcome is a redirect to the web app with a code from a fixed set; Google-provided text is never echoed.
  open({
    method: 'GET', pattern: '/v1/google-drive/callback', limits: [{ name: 'gd-callback', limit: 30, windowMs: HOUR }], handler: async ({ req }) => {
      const base = (cfg.webBaseUrl ?? cfg.allowedOrigins[0] ?? '').replace(/\/+$/, '');
      const back = (q: string): HttpResponse => { const r = json(302); r.headers.location = `${base}/storage?${q}`; return r; };
      if (!d.googleDrive) return back('error=NOT_ENABLED');
      if (req.query.error !== undefined) return back('error=ACCESS_DENIED');
      const code = req.query.code, state = req.query.state;
      if (!code || !state || code.length > 2048 || state.length > 512) return back('error=STATE_INVALID');
      let p: Principal;
      try { p = await d.auth.authenticate(cookieOf(req, AUTH_COOKIES.access)); } catch { return back('error=SESSION'); }
      const r = await d.googleDrive.complete({ sessionUserId: p.userId, code, state });
      return back(r.ok ? 'connected=1' : `error=${r.reason}`);
    }
  });
  user({
    method: 'GET', pattern: '/v1/google-drive/files', limits: [{ name: 'gd-list', limit: 600, windowMs: HOUR }], handler: async ({ req, principal }) => {
      const size = queryInt(req.query, 'pageSize', { min: 1, max: 100 }); const tok = req.query.pageToken;
      if (tok !== undefined && !/^[\x21-\x7e]{1,2048}$/.test(tok)) throw new AppError('VALIDATION_FAILED', 'Invalid input.', [{ field: 'pageToken', message: 'Invalid page token.' }]);
      return json(200, await gd().list(principal!.userId, { ...(size !== undefined ? { pageSize: size } : {}), ...(tok ? { pageToken: tok } : {}) }));
    }
  });
  user({ method: 'GET', pattern: '/v1/google-drive/files/:id', limits: [{ name: 'gd-get', limit: 600, windowMs: HOUR }], handler: async ({ params, principal }) => json(200, await gd().get(principal!.userId, driveId(params.id))) });

  //   user({
  //   method: 'POST',
  //   pattern: '/v1/google-drive/files/:id/import',
  //   limits: [{ name: 'gd-import', limit: 500, windowMs: HOUR }],
  //   handler: async ({ params, principal, requestId }) => {
  //     const userId = principal!.userId;
  //     const fileId = driveId(params.id);

  //     // Read metadata first; only regular MP4/MOV video files are supported.
  //     const file = await gd().get(userId, fileId);
  //     const allowedTypes = new Set(['video/mp4', 'video/quicktime']);
  //     const contentType = file.mimeType.toLowerCase().trim();
  //     const sizeBytes = file.sizeBytes;

  //     if (file.isFolder || !allowedTypes.has(contentType)) {
  //       throw new AppError('VALIDATION_FAILED', 'Only MP4 and MOV video files can be imported.');
  //     }
  //     if (typeof sizeBytes !== 'number' || !Number.isSafeInteger(sizeBytes) || sizeBytes <= 0 || sizeBytes > 1024 ** 3) {
  //       throw new AppError('VALIDATION_FAILED', 'The video has a missing, invalid, or unsupported file size.');
  //     }

  //     // Reserve quota and create the normal ReelQueue video record.
  //     const batch = await d.uploads.createBatch(userId, [{ filename: file.name, contentType, sizeBytes }]);
  //     const target = batch.uploads[0];
  //     if (!target) {
  //       throw new AppError('VALIDATION_FAILED', batch.rejected[0]?.message ?? 'The video cannot be imported.');
  //     }

  //     let stage = 'drive-download';
  //     let targetHost: string | undefined;
  //     let transferredBytes = 0;
  //     const startedAt = Date.now();

  //     // Never log the full signed URL, query parameters, tokens, or headers.
  //     const logInfo = (event: string, extra: Record<string, unknown> = {}) => {
  //       d.logger.info(
  //         {
  //           event,
  //           requestId,
  //           userId,
  //           driveFileId: fileId,
  //           videoId: target.videoId,
  //           stage,
  //           elapsedMs: Date.now() - startedAt,
  //           ...extra,
  //         },
  //         event,
  //       );
  //     };
  //     try {
  //       logInfo('drive.import.started', {
  //         filename: file.name,
  //         contentType,
  //         sizeBytes,
  //       });

  //       logInfo('drive.import.download.started');
  //       const source = await gd().openDownload(userId, fileId);

  //       logInfo('drive.import.download.opened', {
  //         sourceSizeBytes: source.sizeBytes,
  //       });
  //       if (source.sizeBytes !== null && source.sizeBytes !== sizeBytes) {
  //         throw new AppError('VALIDATION_FAILED', 'Google Drive file size changed. Please try again.');
  //       }

  //       let body: Uint8Array | ReadableStream<Uint8Array>;;
  //       let streaming = false;
  //       if (sizeBytes <= IMPORT_BUFFER_LIMIT) {
  //         // body = (await readAll(source.stream, sizeBytes)) as unknown as BodyInit; // known length: S3/R2 accept this
  //         body = await readAll(source.stream, sizeBytes);
  //         logInfo('drive.import.download.buffered', {
  //           transferredBytes,
  //         });
  //       } else {
  //         streaming = true;
  //         const iterator = source.stream[Symbol.asyncIterator]();
  //         let transferred = 0;
  //         body = new ReadableStream<Uint8Array>({
  //           async pull(controller) {
  //             try {
  //               const next = await iterator.next();
  //               if (next.done) {
  //                 if (transferred !== sizeBytes) { controller.error(new Error('Drive stream size mismatch')); return; }
  //                 controller.close();
  //                 return;
  //               }
  //               transferred += next.value.byteLength;
  //               if (transferred > sizeBytes) { controller.error(new Error('Drive stream exceeds declared size')); return; }
  //               controller.enqueue(next.value);
  //             } catch (error) { controller.error(error); }
  //           },
  //           async cancel() { await iterator.return?.(); },
  //         });
  //       }

  //       logInfo('drive.import.download.streaming', {
  //           expectedBytes: sizeBytes,
  //       });

  //       stage = 'storage-upload';
  //       try {
  //         targetHost = new URL(target.url).host;
  //       } catch {
  //         targetHost = 'invalid-target-url';
  //       }

  //       logInfo('drive.import.storage-upload.started', {
  //         targetHost,
  //         streaming,
  //         expectedBytes: sizeBytes,
  //         bufferedBytes: streaming ? undefined : transferredBytes,
  //       });

  //       let response: Response;

  //       try {
  //         response = await fetch(target.url, {
  //           method: 'PUT',
  //           headers: streaming
  //             ? {
  //                 ...target.headers,
  //                 'content-length': String(sizeBytes),
  //               }
  //             : target.headers,
  //           body,
  //           ...(streaming ? { duplex: 'half' } : {}),
  //         } as RequestInit);
  //       } catch (error) {
  //         const info = describeError(error);
  //         d.logger.error(
  //           {
  //             event: 'drive.import.storage-upload.connection-failed',
  //             requestId,
  //             userId,
  //             driveFileId: fileId,
  //             videoId: target.videoId,
  //             stage,
  //             targetHost,
  //             streaming,
  //             expectedBytes: sizeBytes,
  //             transferredBytes,
  //             elapsedMs: Date.now() - startedAt,
  //             errName: info.name,
  //             errCode: info.code,
  //             errMessage: info.message,
  //             cause: error instanceof Error && error.cause instanceof Error
  //               ? {
  //                   name: error.cause.name,
  //                   code: 'code' in error.cause
  //                     ? error.cause.code
  //                     : undefined,
  //                   message: error.cause.message,
  //                 }
  //               : undefined,
  //           },
  //           'Google Drive import: storage upload request failed',
  //         );
  //         throw error;
  //       }

  //       logInfo('drive.import.storage-upload.response', {
  //         targetHost,
  //         status: response.status,
  //         ok: response.ok,
  //       });


  //       if (!response.ok) {
  //         const text = await response.text().catch(() => '');
  //         const s3Code = /<Code>([A-Za-z0-9_]{1,64})<\/Code>/.exec(text)?.[1];

  //         // Do not log the raw response body; it may contain sensitive data.
  //         d.logger.error(
  //           {
  //             event: 'drive.import.storage-upload.rejected',
  //             requestId,
  //             targetHost,
  //             status: response.status,
  //             storageErrorCode: s3Code,
  //           },
  //           'Storage rejected the video upload',
  //         );

  //         throw new AppError(
  //           'INTERNAL',
  //           `Storage rejected the upload (HTTP ${response.status}${s3Code ? `, ${s3Code}` : ''}). Check the configured storage settings.`,
  //         );
  //       }

  //       // response = await fetch(target.url, {
  //       //   method: 'PUT',
  //       //   headers: streaming ? { ...target.headers, 'content-length': String(sizeBytes) } : target.headers,
  //       //   body,
  //       //   ...(streaming ? { duplex: 'half' } : {}),
  //       // } as RequestInit);
  //       // if (!response.ok) {
  //       //   const text = await response.text().catch(() => '');
  //       //   const s3Code = /<Code>([A-Za-z0-9_]{1,64})<\/Code>/.exec(text)?.[1];
  //       //   throw new AppError('INTERNAL', `Storage rejected the upload (HTTP ${response.status}${s3Code ? `, ${s3Code}` : ''}). Check the S3_* settings on the API.`);
  //       // }

  //       // Existing service verifies object size/type and probes the real media.
  //       stage = 'verify';
  //       logInfo('drive.import.verify.started');
  //       let result;
  //       try {
  //         result = await d.uploads.complete(userId, target.videoId);
  //         logInfo('drive.import.verify.completed', {
  //           status: result.status,
  //           reason: result.reason,
  //           durationMs: result.video.durationMs,
  //           width: result.video.width,
  //           height: result.video.height,
  //         });
  //       } catch (e) {
  //         if (e instanceof AppError) throw e;
  //         const info = describeError(e);
  //         d.logger.error(
  //           {
  //             event: 'drive.import.verify.failed',
  //             requestId,
  //             userId,
  //             driveFileId: fileId,
  //             videoId: target.videoId,
  //             stage,
  //             errName: info.name,
  //             errCode: info.code,
  //             errMessage: info.message,
  //             elapsedMs: Date.now() - startedAt,
  //           },
  //           'Video verification failed',
  //         );
  //         if (e instanceof AppError) throw e;

  //         throw new AppError(
  //           'INTERNAL',
  //           `Video verification failed (${info.code ?? info.name}). Check server logs.`,
  //         );
  //       }

  //       if (result.status !== 'READY') {
  //         throw new AppError(
  //           'VALIDATION_FAILED',
  //           result.reason ?? 'The imported file did not pass video validation.',
  //         );
  //       }
  //       //   throw new AppError('INTERNAL', `The video was copied but could not be checked (${info.code ?? info.name}). If this says ENOENT, ffprobe is not installed on the API server.`);
  //       // }
  //       // if (result.status !== 'READY') {
  //       //   throw new AppError('VALIDATION_FAILED', result.reason ?? 'The imported file did not pass video validation.');
  //       // }

  //       logInfo('drive.import.succeeded', {
  //         status: result.status,
  //         transferredBytes,
  //       });
  //       return json(201, { video: (await d.read.videoDtos(userId, [result.video]))[0] });
  //     } catch (error) {
  //       const info = describeError(error);

  //       d.logger.error(
  //         {
  //           event: 'drive.import.failed',
  //           requestId,
  //           userId,
  //           driveFileId: fileId,
  //           videoId: target.videoId,
  //           stage,
  //           targetHost,
  //           transferredBytes,
  //           expectedBytes: sizeBytes,
  //           elapsedMs: Date.now() - startedAt,
  //           errName: info.name,
  //           errCode: info.code,
  //           errMessage: info.message,
  //           cause: error instanceof Error && error.cause instanceof Error
  //             ? {
  //                 name: error.cause.name,
  //                 code: 'code' in error.cause
  //                   ? error.cause.code
  //                   : undefined,
  //                 message: error.cause.message,
  //               }
  //             : undefined,
  //         },
  //         'Google Drive import failed',
  //       );

  //       // Release reservation and clean up any partial upload.
  //       await d.uploads.failClientUpload(userId, target.videoId).catch(
  //         (cleanupError) => {
  //           const cleanupInfo = describeError(cleanupError);

  //           d.logger.error(
  //             {
  //               event: 'drive.import.cleanup.failed',
  //               requestId,
  //               videoId: target.videoId,
  //               errName: cleanupInfo.name,
  //               errCode: cleanupInfo.code,
  //               errMessage: cleanupInfo.message,
  //             },
  //             'Failed to clean up the unsuccessful import',
  //           );
  //         },
  //       );

  //       if (error instanceof AppError) throw error;

  //       throw new AppError(
  //         'INTERNAL',
  //         `Import failed at "${stage}" (${info.code ?? info.name}).`,
  //       );
        
  //       // // Release the reservation and remove any partial object on failure.
  //       // await d.uploads.failClientUpload(userId, target.videoId).catch(() => undefined);
  //       // if (error instanceof AppError) throw error;
  //       // const info = describeError(error);
  //       // d.logger.error({ event: 'drive.import.failed', requestId, stage, errName: info.name, errCode: info.code, errMessage: info.message }, 'google drive import failed');
  //       // throw new AppError('INTERNAL', `Import failed at "${stage}" (${info.code ?? info.name}).`);
  //     }
  //   },
  // });

  

  // CHANGED: Google Drive binary upload route.
  
  
    // Registers a Google Drive video as a ReelQueue video. No bytes are copied: the video stays in the user's Drive and is
  // streamed on demand through the signed media route below.
  user({
    method: 'POST', pattern: '/v1/google-drive/files/:id/import', limits: [{ name: 'gd-import', limit: 500, windowMs: HOUR }],
    handler: async ({ params, principal, requestId }) => {
      const userId = principal!.userId;
      const fileId = driveId(params.id);
      const file = await gd().getForImport(userId, fileId);
      const contentType = file.mimeType.toLowerCase().trim();
      if (file.isFolder || (contentType !== 'video/mp4' && contentType !== 'video/quicktime')) {
        throw new AppError('VALIDATION_FAILED', 'Only MP4 and MOV video files can be imported.');
      }
      if (file.sizeBytes === null || !Number.isSafeInteger(file.sizeBytes) || file.sizeBytes <= 0 || file.sizeBytes > 1024 ** 3) {
        throw new AppError('VALIDATION_FAILED', 'The video has a missing, invalid, or unsupported file size.');
      }
      if (!file.video) {
        throw new AppError('INVALID_STATE', 'Google Drive has not finished processing this video yet (no duration available). Try again in a few minutes.');
      }
      const video = await d.uploads.importDriveVideo(userId, { driveFileId: fileId, filename: file.name, contentType, sizeBytes: file.sizeBytes, ...file.video });
      d.logger.info({ event: 'drive.import.succeeded', requestId, userId, driveFileId: fileId, videoId: video.id }, 'google drive video imported');
      return json(201, { video: (await d.read.videoDtos(userId, [video]))[0] });
    },
  });

  // Signed media URL for videos that live in Google Drive: used by the dashboard player and fetched by Instagram.
  // No session cookie: the HMAC signature (video id + expiry) is the credential. Every failure looks like a 404.
  for (const method of ['GET', 'HEAD'] as const) {
    open({
      method, pattern: '/v1/media/drive/:videoId', limits: [{ name: 'drive-media', limit: 600, windowMs: HOUR }],
      handler: async ({ req, params }) => {
        const src = await d.uploads.resolveDriveMedia(uuidParam(params.videoId, 'Video'), req.query.exp, req.query.sig);
        const res = json(200);
        res.headers['content-type'] = src.contentType;
        res.headers['content-length'] = String(src.sizeBytes);
        res.headers['accept-ranges'] = 'none';
        if (req.method === 'HEAD') return res;
        res.stream = (await gd().openDownload(src.userId, src.fileId)).stream;
        return res;
      },
    });
  }

  user({
    method: 'POST',
    pattern: '/v1/google-drive/uploads',
    limits: [
      {
        name: 'gd-upload',
        limit: 60,
        windowMs: HOUR,
      },
    ],
    handler: async ({ req, principal }) => {
      const filename = req.query.filename;
      const contentType = req.query.contentType;

      // CHANGED: Read Content-Length case-insensitively.
      const contentLengthHeader = getRequestHeader(
        req.headers,
        'content-length',
      );

      if (
        !contentLengthHeader ||
        !/^\d+$/.test(contentLengthHeader)
      ) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Missing or invalid Content-Length.',
        );
      }

      const sizeBytes = Number(contentLengthHeader);

      if (
        !Number.isSafeInteger(sizeBytes) ||
        sizeBytes <= 0
      ) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Missing or invalid Content-Length.',
        );
      }

      // NEW: Raw video bytes must reach the route.
      if (!req.rawBody) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Missing binary upload body.',
        );
      }

      // NEW: Confirm declared size matches received bytes.
      if (req.rawBody.byteLength !== sizeBytes) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Uploaded byte count does not match Content-Length.',
        );
      }

      if (
        !filename ||
        filename.length > 255
      ) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Invalid filename.',
        );
      }

      if (
        !contentType ||
        contentType.length > 100
      ) {
        throw new AppError(
          'VALIDATION_FAILED',
          'Invalid content type.',
        );
      }

      // NEW: Upload bytes through the backend to Google Drive.
      return json(
        201,
        await gd().uploadFile(
          principal!.userId,
          {
            filename,
            contentType,
            sizeBytes,
          },
          req.rawBody,
        ),
      );
    },
  });
  user({
    method: 'GET', pattern: '/v1/google-drive/files/:id/content', limits: [{ name: 'gd-download', limit: 120, windowMs: HOUR }], handler: async ({ params, principal }) => {
      const f = await gd().openDownload(principal!.userId, driveId(params.id));
      const res = json(200); res.stream = f.stream;
      // Always an opaque attachment: Drive content is user-controlled, so it must never render as a page in our origin.
      res.headers['content-type'] = 'application/octet-stream';
      res.headers['content-disposition'] = `attachment; filename="${f.name.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 120) || 'file'}"; filename*=UTF-8''${encodeURIComponent(f.name)}`;
      if (f.sizeBytes !== null) res.headers['content-length'] = String(f.sizeBytes);
      return res;
    }
  });
  user({ method: 'DELETE', pattern: '/v1/google-drive/files/:id', limits: [{ name: 'gd-delete', limit: 120, windowMs: HOUR }], handler: async ({ params, principal }) => { await gd().delete(principal!.userId, driveId(params.id)); return json(204); } });
  user({ method: 'DELETE', pattern: '/v1/google-drive/connection', limits: [{ name: 'gd-disconnect', limit: 30, windowMs: HOUR }], handler: async ({ principal }) => { await gd().disconnect(principal!.userId); return json(204); } });

  /* --------------------------------------------------------------- uploads */
  user({
    method: 'POST', pattern: '/v1/uploads/init', limits: [{ name: 'upload-init', limit: 60, windowMs: HOUR }], handler: async ({ req, principal }) => {
      const f = new Fields(req.body);
      const files = f.objects('files', { min: 1, max: 500 }).map((x) => ({ filename: x.str('filename', { max: 255 }), contentType: x.str('contentType', { max: 100 }), sizeBytes: x.int('sizeBytes', { min: 0, max: Number.MAX_SAFE_INTEGER }) }));
      f.done();
      const r = await d.uploads.createBatch(principal!.userId, files);
      if (!r.batchId || !r.expiresAt) throw new AppError('VALIDATION_FAILED', 'None of the files can be uploaded.', r.rejected.map((x) => ({ field: `files[${x.index}]`, message: x.message })));
      return json(200, { batchId: r.batchId, expiresAt: r.expiresAt.toISOString(), targets: r.uploads.map((u) => ({ index: u.index, videoId: u.videoId, uploadUrl: u.url, headers: u.headers })), rejected: r.rejected });
    }
  });
  user({
    method: 'POST', pattern: '/v1/uploads/:batchId/complete', handler: async ({ req, params, principal }) => {
      const f = new Fields(req.body); const uploaded = f.stringArray('uploaded', { max: 500, itemMax: 40 }); const failed = f.optStringArray('failed', { max: 500 }); f.done();
      return json(200, await d.flow.completeBatch(principal!.userId, uuidParam(params.batchId, 'Upload batch'), { uploaded: uploaded.map((x) => uuidParam(x, 'Video')), ...(failed ? { failed: failed.map((x) => uuidParam(x, 'Video')) } : {}) }));
    }
  });
  user({
    method: 'GET', pattern: '/v1/videos', handler: async ({ req, principal }) => json(200, await d.read.listVideos(principal!.userId, {
      ...(queryEnum(req.query, 'status', ['PENDING_UPLOAD', 'VALIDATING', 'READY', 'REJECTED', 'FAILED'] as const) ? { status: queryEnum(req.query, 'status', ['PENDING_UPLOAD', 'VALIDATING', 'READY', 'REJECTED', 'FAILED'] as const)! } : {}),
      ...(queryInt(req.query, 'page', { min: 1, max: 100000 }) !== undefined ? { page: queryInt(req.query, 'page', { min: 1, max: 100000 })! } : {}),
      ...(queryInt(req.query, 'pageSize', { min: 1, max: 100 }) !== undefined ? { pageSize: queryInt(req.query, 'pageSize', { min: 1, max: 100 })! } : {}),
    }))
  });
  user({
    method: 'PUT', pattern: '/v1/videos/order', handler: async ({ req, principal }) => {
      const f = new Fields(req.body); const ids = f.stringArray('videoIds', { max: 5000, itemMax: 40 }); f.done();
      await d.uploads.reorder(principal!.userId, ids.map((x) => uuidParam(x, 'Video')));
      return json(204);
    }
  });
  user({
    method: 'PATCH', pattern: '/v1/videos/:id', handler: async ({ req, params, principal }) => {
      const f = new Fields(req.body); const caption = f.nullableStr('caption', 2200); f.done();
      const v = await d.uploads.updateCaption(principal!.userId, uuidParam(params.id, 'Video'), caption ?? null);
      return json(200, (await d.read.videoDtos(principal!.userId, [v]))[0]);
    }
  });
  user({ method: 'DELETE', pattern: '/v1/videos/:id', handler: async ({ params, principal }) => { await d.uploads.deleteVideo(principal!.userId, uuidParam(params.id, 'Video')); return json(204); } });
  user({
    method: 'GET', pattern: '/v1/videos/:id/preview', handler: async ({ params, principal }) => {
      const p = await d.uploads.preview(principal!.userId, uuidParam(params.id, 'Video'));
      return json(200, { url: p.url, expiresAt: p.expiresAt.toISOString() });
    }
  });
  user({ method: 'GET', pattern: '/v1/storage', handler: async ({ principal }) => json(200, await d.read.storage(principal!.userId)) });

  /* ---------------------------------------------------------------- cycles */
  user({ method: 'GET', pattern: '/v1/cycles/current', handler: async ({ principal }) => json(200, await d.read.currentCycle(principal!.userId)) });
  user({
    method: 'GET', pattern: '/v1/cycles', handler: async ({ req, principal }) => json(200, await d.read.listCycles(principal!.userId, {
      ...(queryInt(req.query, 'page', { min: 1, max: 100000 }) !== undefined ? { page: queryInt(req.query, 'page', { min: 1, max: 100000 })! } : {}),
      ...(queryInt(req.query, 'pageSize', { min: 1, max: 100 }) !== undefined ? { pageSize: queryInt(req.query, 'pageSize', { min: 1, max: 100 })! } : {}),
    }))
  });
  user({
    method: 'POST', pattern: '/v1/cycles', limits: [{ name: 'cycle-start', limit: 30, windowMs: HOUR }], handler: async ({ req, principal }) => {
      const f = new Fields(req.body);
      const id = f.str('instagramAccountId', { max: 40 }); const batchSize = f.optInt('batchSize'); const intervalMinutes = f.optInt('intervalMinutes');
      const loopEnabled = f.optBool('loopEnabled'); const durationHours = f.optInt('durationHours'); f.done();
      return json(201, await d.cycles.start(principal!.userId, {
        instagramAccountId: uuidParam(id, 'Instagram account'), ...(batchSize !== undefined ? { batchSize } : {}), ...(intervalMinutes !== undefined ? { intervalMinutes } : {}),
        ...(loopEnabled !== undefined ? { loopEnabled } : {}), ...(durationHours !== undefined ? { durationHours } : {}),
      }));
    }
  });
  user({ method: 'POST', pattern: '/v1/cycles/:id/pause', handler: async ({ params, principal }) => json(200, await d.cycles.pause(principal!.userId, uuidParam(params.id, 'Cycle'))) });
  user({ method: 'POST', pattern: '/v1/cycles/:id/resume', handler: async ({ params, principal }) => json(200, await d.cycles.resume(principal!.userId, uuidParam(params.id, 'Cycle'))) });
  user({ method: 'POST', pattern: '/v1/cycles/:id/stop', handler: async ({ params, principal }) => json(200, await d.cycles.stop(principal!.userId, uuidParam(params.id, 'Cycle'))) });
  user({
    method: 'PATCH', pattern: '/v1/cycles/:id', handler: async ({ req, params, principal }) => {
      const f = new Fields(req.body); const loop = f.bool('loopEnabled'); f.done();
      return json(200, await d.cycles.setLoop(principal!.userId, uuidParam(params.id, 'Cycle'), loop));
    }
  });

  /* ------------------------------------------------------------------ jobs */
  user({ method: 'GET', pattern: '/v1/jobs/upcoming', handler: async ({ principal }) => json(200, await d.read.upcomingJobs(principal!.userId)) });
  user({
    method: 'GET', pattern: '/v1/jobs', handler: async ({ req, principal }) => {
      const page = queryInt(req.query, 'page', { min: 1, max: 100000 }); const pageSize = queryInt(req.query, 'pageSize', { min: 1, max: 100 });
      const status = queryEnum(req.query, 'status', ['SCHEDULED', 'DEFERRED', 'RETRY_WAIT', 'CREATING_CONTAINER', 'PROCESSING_MEDIA', 'PUBLISH_REQUESTED', 'ACCEPTED', 'CONFIRMED', 'SIMULATED', 'FAILED', 'CANCELLED', 'EXPIRED'] as const);
      const cycleId = req.query.cycleId !== undefined ? uuidParam(req.query.cycleId, 'Cycle') : undefined;
      return json(200, await d.read.listJobs(principal!.userId, {
        ...(page !== undefined ? { page } : {}), ...(pageSize !== undefined ? { pageSize } : {}), ...(status ? { status } : {}), ...(cycleId ? { cycleId } : {}),
        ...(req.query.from !== undefined ? { from: req.query.from } : {}), ...(req.query.to !== undefined ? { to: req.query.to } : {}),
      }));
    }
  });
  user({ method: 'POST', pattern: '/v1/jobs/:id/retry', limits: [{ name: 'job-retry', limit: 60, windowMs: HOUR }], handler: async ({ params, principal }) => json(200, await d.cycles.retryJob(principal!.userId, uuidParam(params.id, 'Job'))) });
  user({ method: 'GET', pattern: '/v1/dashboard', handler: async ({ principal }) => json(200, await d.read.dashboard(principal!.userId)) });

  /* ---------------------------------------------------------------- health */
  open({ method: 'GET', pattern: '/health/live', handler: async () => json(200, { status: 'ok' }) });
  open({
    method: 'GET', pattern: '/health/ready', handler: async () => {
      const [db, redis] = await Promise.all([d.checks.database().catch(() => false), d.checks.redis().catch(() => false)]);
      return json(db && redis ? 200 : 503, { status: db && redis ? 'ok' : 'degraded', database: db ? 'up' : 'down', redis: redis ? 'up' : 'down' });
    }
  });

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
