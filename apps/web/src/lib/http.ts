/**
 * Framework-free HTTP core of the typed API client. No imports from React/Next and no '@/' alias, so it
 * runs under `tsx --test`. The typed layer that binds this to the shared ROUTES table lives in ./api.ts.
 */
import type { ApiErrorBody, ApiErrorCode } from '@reelqueue/shared';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** Structural subset of RouteSpec (the shared one has phantom _req/_res members). */
export interface BaseSpec {
  method: HttpMethod;
  path: string;
  auth: 'none' | 'user' | 'admin';
  _req?: unknown;
  _res?: unknown;
}

export type ClientErrorCode = ApiErrorCode | 'NETWORK_ERROR' | 'UNEXPECTED_RESPONSE';

export class ApiError extends Error {
  readonly code: ClientErrorCode;
  readonly status: number;
  readonly requestId: string | undefined;
  readonly details: { field: string; message: string }[] | undefined;

  constructor(init: {
    code: ClientErrorCode;
    message: string;
    status: number;
    requestId?: string | undefined;
    details?: { field: string; message: string }[] | undefined;
  }) {
    super(init.message);
    this.name = 'ApiError';
    this.code = init.code;
    this.status = init.status;
    this.requestId = init.requestId;
    this.details = init.details;
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

/* ------------------------------------------------------------ URL helpers */

export type PathParams = Record<string, string | number>;

/** Substitutes `:name` segments. Throws when a param is missing so a bug never produces a wrong URL. */
export function buildPath(template: string, params: PathParams = {}): string {
  const used = new Set<string>();
  const out = template.replace(/:([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name: string) => {
    const v = params[name];
    if (v === undefined || v === null || String(v) === '') {
      throw new Error(`Missing path param "${name}" for ${template}`);
    }
    used.add(name);
    return encodeURIComponent(String(v));
  });
  return out;
}

export type QueryValue = string | number | boolean | Date | null | undefined | readonly (string | number | boolean)[];

/** `?a=1&b=x`. Skips undefined / null / empty strings; arrays repeat the key; Dates become ISO strings. */
export function buildQuery(query?: object): string {
  if (!query) return '';
  const sp = new URLSearchParams();
  for (const [k, raw] of Object.entries(query as Record<string, QueryValue>)) {
    if (raw === undefined || raw === null || raw === '') continue;
    if (Array.isArray(raw)) {
      for (const item of raw as readonly (string | number | boolean)[]) sp.append(k, String(item));
    } else if (raw instanceof Date) {
      sp.append(k, raw.toISOString());
    } else {
      sp.append(k, String(raw));
    }
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export function buildUrl(baseUrl: string, spec: BaseSpec, params?: PathParams, query?: object): string {
  const base = baseUrl.replace(/\/+$/, '');
  return `${base}${buildPath(spec.path, params)}${buildQuery(query)}`;
}

/* ------------------------------------------------------------ error mapping */

const STATUS_FALLBACK: Record<number, ClientErrorCode> = {
  400: 'VALIDATION_FAILED',
  401: 'UNAUTHENTICATED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  409: 'CONFLICT',
  429: 'RATE_LIMITED',
};

function isErrorBody(v: unknown): v is ApiErrorBody {
  if (typeof v !== 'object' || v === null) return false;
  const e = (v as { error?: unknown }).error;
  if (typeof e !== 'object' || e === null) return false;
  const o = e as { code?: unknown; message?: unknown };
  return typeof o.code === 'string' && typeof o.message === 'string';
}

/** Turns a non-2xx response (status + parsed JSON or undefined) into an ApiError. Switch on `.code`, not the message. */
export function toApiError(status: number, body: unknown): ApiError {
  if (isErrorBody(body)) {
    const e = body.error;
    return new ApiError({ code: e.code, message: e.message, status, requestId: e.requestId, details: e.details });
  }
  const code: ClientErrorCode = STATUS_FALLBACK[status] ?? (status >= 500 ? 'INTERNAL' : 'UNEXPECTED_RESPONSE');
  return new ApiError({ code, message: `The server responded with HTTP ${status}.`, status });
}

/** Codes whose API message is replaced by a clearer, actionable one. Others show the API's own message. */
const FRIENDLY: Partial<Record<ClientErrorCode, string>> = {
  NETWORK_ERROR: 'Cannot reach the ReelQueue API. Check your connection and try again.',
  UNEXPECTED_RESPONSE: 'The server sent a response this app does not understand.',
  RATE_LIMITED: 'Too many requests. Please wait a moment and try again.',
  ACCOUNT_LOCKED: 'This account is temporarily locked after too many failed attempts. Try again later.',
  ACCOUNT_SUSPENDED: 'This account is suspended. Contact support.',
  EMAIL_NOT_VERIFIED: 'Verify your email address first - follow the link in the verification email.',
  INSTAGRAM_REAUTH_REQUIRED: 'Instagram needs you to reconnect this account before anything can be published.',
  INSTAGRAM_NOT_CONNECTED: 'Connect an Instagram account first.',
  VIDEO_IN_USE: 'This video is part of a queued or active publishing job and cannot be deleted without confirmation.',
  STORAGE_QUOTA_EXCEEDED: 'Your storage quota is full. Delete videos before uploading more.',
  QUEUE_EMPTY: 'There are no ready videos to publish. Upload videos first.',
  CYCLE_ALREADY_ACTIVE: 'A publishing cycle is already running or paused. Stop it before starting a new one.',
  CYCLE_EXPIRED: 'The 24h cycle window has already elapsed.',
  MOCK_ONLY: 'This action is only available in mock mode.',
};

export function errorMessage(e: unknown): string {
  if (e instanceof ApiError) {
    const base = FRIENDLY[e.code] ?? e.message;
    return e.requestId ? `${base} (ref ${e.requestId})` : base;
  }
  if (e instanceof Error && e.message) return e.message;
  return 'Something went wrong.';
}

/** Field-level messages from a VALIDATION_FAILED error: { fieldName: message }. */
export function fieldErrors(e: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (e instanceof ApiError && e.details) {
    for (const d of e.details) if (!(d.field in out)) out[d.field] = d.message;
  }
  return out;
}

/* ------------------------------------------------------------ client */

export interface ClientConfig {
  baseUrl: string;
  /** Route used for the one-shot refresh on 401 (ROUTES.refresh). */
  refreshRoute: BaseSpec;
  /** Called when the session cannot be recovered (refresh failed). Typically redirects to /login. */
  onUnauthenticated?: () => void;
  fetchImpl?: typeof fetch;
}

export interface CallOptions {
  params?: PathParams;
  query?: object;
  body?: unknown;
  signal?: AbortSignal;
  /** Do not call onUnauthenticated (used by the session probe on public pages). */
  noAuthRedirect?: boolean;
}

export interface HttpClient {
  request<T>(spec: BaseSpec, opts?: CallOptions): Promise<T>;
  setUnauthenticatedHandler(fn: (() => void) | undefined): void;
}

export function createHttpClient(cfg: ClientConfig): HttpClient {
  let onUnauth = cfg.onUnauthenticated;
  let refreshing: Promise<boolean> | null = null;
  const doFetch = (...a: Parameters<typeof fetch>) => (cfg.fetchImpl ?? fetch)(...a);

  async function send(spec: BaseSpec, opts: CallOptions): Promise<Response> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    let body: string | undefined;
    if (opts.body !== undefined && spec.method !== 'GET') {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(opts.body);
    }
    const init: RequestInit = { method: spec.method, credentials: 'include', headers };
    if (body !== undefined) init.body = body;
    if (opts.signal) init.signal = opts.signal;
    try {
      return await doFetch(buildUrl(cfg.baseUrl, spec, opts.params, opts.query), init);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err;
      throw new ApiError({ code: 'NETWORK_ERROR', message: 'Network error', status: 0 });
    }
  }

  async function parse(res: Response): Promise<unknown> {
    if (res.status === 204) return undefined;
    const text = await res.text();
    if (!text) return undefined;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      if (res.ok) throw new ApiError({ code: 'UNEXPECTED_RESPONSE', message: 'Invalid JSON in response', status: res.status });
      return undefined;
    }
  }

  /** Single-flight refresh: concurrent 401s share one POST /auth/refresh. */
  function refreshOnce(): Promise<boolean> {
    if (!refreshing) {
      refreshing = (async () => {
        try {
          const res = await send(cfg.refreshRoute, {});
          return res.ok;
        } catch {
          return false;
        } finally {
          // allow a later (separate) refresh once this one settled
          setTimeout(() => {
            refreshing = null;
          }, 0);
        }
      })();
    }
    return refreshing;
  }

  async function request<T>(spec: BaseSpec, opts: CallOptions = {}): Promise<T> {
    let res = await send(spec, opts);
    if (res.status === 401 && spec.auth !== 'none') {
      const ok = await refreshOnce();
      if (ok) {
        res = await send(spec, opts); // retry exactly once
      }
      if (!ok || res.status === 401) {
        const err = toApiError(401, await parse(res).catch(() => undefined));
        if (!opts.noAuthRedirect) onUnauth?.();
        throw err;
      }
    }
    const data = await parse(res);
    if (!res.ok) throw toApiError(res.status, data);
    return data as T;
  }

  return {
    request,
    setUnauthenticatedHandler(fn) {
      onUnauth = fn;
    },
  };
}
