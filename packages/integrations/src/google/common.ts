// // packages/integrations/src/google/common.ts
// /** Shared plumbing for the Google clients: a minimal fetch type (so tests inject a fake), a sanitised error, retry/backoff. */
// export interface GFetchResponse {
//   status: number;
//   headers: { get(name: string): string | null };
//   text(): Promise<string>;
//   /** Present on real fetch responses; consumed only by streaming downloads. */
//   body?: AsyncIterable<Uint8Array> | null;
// }
// export type GFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<GFetchResponse>;
// export const defaultFetch: GFetch = (url, init) => (globalThis.fetch as unknown as GFetch)(url, init);

// export type GoogleErrorKind = 'AUTH_EXPIRED' | 'PERMISSION' | 'RATE_LIMITED' | 'STORAGE_FULL' | 'NOT_FOUND' | 'VALIDATION' | 'UNAVAILABLE' | 'UNKNOWN';
// /** Never contains URLs, tokens, codes, file names or Google's free-text message; `reason` is a short whitelisted identifier. */
// export class GoogleApiError extends Error {
//   constructor(readonly kind: GoogleErrorKind, message: string, readonly httpStatus?: number, readonly reason?: string, readonly retryAfterMs?: number) { super(message); this.name = 'GoogleApiError'; }
// }

// const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'sharingRateLimitExceeded', 'backendError']);
// export function classify(status: number, json: unknown, retryAfter: string | null): GoogleApiError {
//   const e = (json as { error?: unknown } | null)?.error;
//   const reasonRaw = typeof e === 'object' && e !== null ? ((e as { errors?: { reason?: unknown }[] }).errors?.[0]?.reason ?? (e as { status?: unknown }).status) : typeof e === 'string' ? e : undefined;
//   const reason = typeof reasonRaw === 'string' && /^[A-Za-z_]{1,64}$/.test(reasonRaw) ? reasonRaw : undefined;
//   const ra = retryAfter && /^\d{1,6}$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : undefined;
//   const mk = (k: GoogleErrorKind) => new GoogleApiError(k, `Google request failed (HTTP ${status}${reason ? `, ${reason}` : ''})`, status, reason, ra);
//   if (status === 401) return mk('AUTH_EXPIRED');
//   if (status === 429) return mk('RATE_LIMITED');
//   if (status === 403) return mk(reason && RATE_REASONS.has(reason) ? 'RATE_LIMITED' : reason === 'storageQuotaExceeded' ? 'STORAGE_FULL' : 'PERMISSION');
//   if (status === 404) return mk('NOT_FOUND');
//   if (status === 400 || status === 416) return mk('VALIDATION');
//   if (status >= 500) return mk('UNAVAILABLE');
//   return mk('UNKNOWN');
// }

// export interface RetryOptions { maxRetries: number; baseDelayMs: number; maxDelayMs: number; sleep: (ms: number) => Promise<void>; random: () => number }
// export const DEFAULT_RETRY: RetryOptions = { maxRetries: 3, baseDelayMs: 300, maxDelayMs: 8000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random };

// /** Exponential backoff with full jitter; honours Retry-After. `retryable` decides per error. */
// export async function withRetry<T>(opt: RetryOptions, retryable: (e: GoogleApiError) => boolean, fn: () => Promise<T>): Promise<T> {
//   for (let attempt = 0; ; attempt++) {
//     try { return await fn(); }
//     catch (e) {
//       if (!(e instanceof GoogleApiError) || !retryable(e) || attempt >= opt.maxRetries) throw e;
//       const backoff = Math.min(opt.maxDelayMs, opt.baseDelayMs * 2 ** attempt);
//       await opt.sleep(Math.min(opt.maxDelayMs, e.retryAfterMs ?? Math.floor(opt.random() * backoff)));
//     }
//   }
// }

// /** One request with a timeout. Network errors and timeouts become UNAVAILABLE (retryable); the body is read here unless `stream` is set. */
// export async function send(f: GFetch, timeoutMs: number, url: string, init: { method: string; headers: Record<string, string>; body?: string }, opts: { stream?: boolean } = {}): Promise<{ res: GFetchResponse; text: string }> {
//   const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs);
//   try {
//     const res = await f(url, { ...init, signal: ctl.signal });
//     if (opts.stream && res.status >= 200 && res.status < 300) { clearTimeout(timer); return { res, text: '' }; } // the caller owns the body; the timeout covers the headers only
//     return { res, text: await res.text() };
//   } catch (e) {
//     if (e instanceof GoogleApiError) throw e;
//     throw new GoogleApiError('UNAVAILABLE', 'No usable response from Google');
//   } finally { clearTimeout(timer); }
// }
// export const parseJson = (t: string): unknown => { try { return t ? JSON.parse(t) : null; } catch { return null; } };






// Shared plumbing for the Google clients: minimal fetch type (tests can inject a fake), sanitised errors, retry/backoff.
export interface GFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
  body?: AsyncIterable<Uint8Array> | null;
}
// CHANGED: Google upload requests may carry raw binary bytes, not just text/JSON.
export type GFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }) => Promise<GFetchResponse>;
export const defaultFetch: GFetch = (url, init) => (globalThis.fetch as unknown as GFetch)(url, init);

export type GoogleErrorKind = 'AUTH_EXPIRED' | 'PERMISSION' | 'RATE_LIMITED' | 'STORAGE_FULL' | 'NOT_FOUND' | 'VALIDATION' | 'UNAVAILABLE' | 'UNKNOWN';
export class GoogleApiError extends Error {
  constructor(readonly kind: GoogleErrorKind, message: string, readonly httpStatus?: number, readonly reason?: string, readonly retryAfterMs?: number) { super(message); this.name = 'GoogleApiError'; }
}
const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'sharingRateLimitExceeded', 'backendError']);
export function classify(status: number, json: unknown, retryAfter: string | null): GoogleApiError {
  const e = (json as { error?: unknown } | null)?.error;
  const reasonRaw = typeof e === 'object' && e !== null ? ((e as { errors?: { reason?: unknown }[] }).errors?.[0]?.reason ?? (e as { status?: unknown }).status) : typeof e === 'string' ? e : undefined;
  const reason = typeof reasonRaw === 'string' && /^[A-Za-z_]{1,64}$/.test(reasonRaw) ? reasonRaw : undefined;
  const ra = retryAfter && /^\d{1,6}$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : undefined;
  const mk = (k: GoogleErrorKind) => new GoogleApiError(k, `Google request failed (HTTP ${status}${reason ? `, ${reason}` : ''})`, status, reason, ra);
  if (status === 401) return mk('AUTH_EXPIRED');
  if (status === 429) return mk('RATE_LIMITED');
  if (status === 403) return mk(reason && RATE_REASONS.has(reason) ? 'RATE_LIMITED' : reason === 'storageQuotaExceeded' ? 'STORAGE_FULL' : 'PERMISSION');
  if (status === 404) return mk('NOT_FOUND');
  if (status === 400 || status === 416) return mk('VALIDATION');
  if (status >= 500) return mk('UNAVAILABLE');
  return mk('UNKNOWN');
}
export interface RetryOptions { maxRetries: number; baseDelayMs: number; maxDelayMs: number; sleep: (ms: number) => Promise<void>; random: () => number }
export const DEFAULT_RETRY: RetryOptions = { maxRetries: 3, baseDelayMs: 300, maxDelayMs: 8000, sleep: (ms) => new Promise((r) => setTimeout(r, ms)), random: Math.random };
export async function withRetry<T>(opt: RetryOptions, retryable: (e: GoogleApiError) => boolean, fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); }
    catch (e) {
      if (!(e instanceof GoogleApiError) || !retryable(e) || attempt >= opt.maxRetries) throw e;
      const backoff = Math.min(opt.maxDelayMs, opt.baseDelayMs * 2 ** attempt);
      await opt.sleep(Math.min(opt.maxDelayMs, e.retryAfterMs ?? Math.floor(opt.random() * backoff)));
    }
  }
}
/** One request with timeout. */
export async function send(f: GFetch, timeoutMs: number, url: string, init: { method: string; headers: Record<string, string>; body?: string | Uint8Array }, opts: { stream?: boolean } = {}): Promise<{ res: GFetchResponse; text: string }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await f(url, { ...init, signal: ctl.signal });
    if (opts.stream && res.status >= 200 && res.status < 300) { clearTimeout(timer); return { res, text: '' }; }
    return { res, text: await res.text() };
  } catch (e) {
    if (e instanceof GoogleApiError) throw e;
    throw new GoogleApiError('UNAVAILABLE', 'No usable response from Google');
  } finally { clearTimeout(timer); }
}
export const parseJson = (t: string): unknown => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
