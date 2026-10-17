import {
  ProviderError,
  type Clock,
  type ConfirmResult,
  type ContainerStatus,
  type CreateReelInput,
  type EligibilityResult,
  type InstagramProvider,
  type ProviderErrorKind,
  type PublishQuota,
} from '@reelqueue/core';

/**
 * UNVERIFIED ADAPTER. Endpoint paths, field names and Meta error codes below come from prior knowledge, NOT from a
 * live call or from the pages verified in docs/INSTAGRAM_SETUP.md. It has only been exercised against a fake HTTP
 * client. Before enabling INSTAGRAM_PROVIDER=meta, check every item in docs/INSTAGRAM_SETUP.md ("Unverified") against
 * the current official docs and a real test account.
 */
export interface MetaCredentials {
  /** Decrypted access token. Resolved per call; never stored on the provider, never logged. */
  accessToken: string;
  /** The Instagram professional account id used in /{id}/media paths. */
  igUserId: string;
}

export interface TokenResolver {
  resolve(accountId: string): Promise<MetaCredentials>;
}

export type HttpFn = (
  url: string,
  init: { method: 'GET' | 'POST'; headers: Record<string, string>; body?: string; signal?: AbortSignal },
) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

export interface MetaProviderConfig {
  /** e.g. https://graph.instagram.com */
  baseUrl: string;
  /** e.g. "v21.0" — taken from env, never assumed. */
  graphVersion: string;
  requestTimeoutMs: number;
}

interface MetaErrorBody {
  error?: { message?: string; type?: string; code?: number; error_subcode?: number };
}

/** Meta error code -> our taxonomy. UNVERIFIED mapping (see header). */
export function classifyMetaError(httpStatus: number, body: MetaErrorBody | null, retryAfterMs?: number): ProviderError {
  const code = body?.error?.code;
  const sub = body?.error?.error_subcode;
  const opts = {
    ...(code !== undefined ? { code: String(code) } : {}),
    ...(sub !== undefined ? { subcode: String(sub) } : {}),
    httpStatus,
    ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
  };
  let kind: ProviderErrorKind;
  if (code === 190 || httpStatus === 401) kind = 'AUTH_EXPIRED';
  else if (code === 10 || (code !== undefined && code >= 200 && code <= 299) || httpStatus === 403) kind = 'PERMISSION_REVOKED';
  else if (code === 4 || code === 17 || code === 32 || code === 613 || httpStatus === 429) kind = 'RATE_LIMITED';
  else if (code === 368) kind = 'ACCOUNT_RESTRICTED';
  else if (code === 2 || httpStatus >= 500) kind = 'TRANSIENT';
  else if (code === 9004 || code === 9007 || (sub !== undefined && sub >= 2207000 && sub < 2208000)) kind = 'MEDIA_REJECTED';
  else if (httpStatus === 400 || code === 100) kind = 'VALIDATION';
  else kind = 'UNKNOWN';
  // Sanitised: fixed text, never Meta's free-form message (could echo URLs/ids) and never the response body.
  return new ProviderError(kind, `Instagram API error (${kind}${code !== undefined ? ` code ${code}` : ''}, HTTP ${httpStatus})`, opts);
}

function retryAfter(h: { get(n: string): string | null }): number | undefined {
  const v = Number(h.get('retry-after'));
  return Number.isFinite(v) && v > 0 ? v * 1000 : undefined;
}

export class MetaInstagramProvider implements InstagramProvider {
  readonly kind = 'META' as const;
  readonly isMock = false as const;

  constructor(
    private readonly cfg: MetaProviderConfig,
    private readonly deps: { tokens: TokenResolver; clock: Clock; http?: HttpFn },
  ) {}

  private async call<T>(accountId: string, method: 'GET' | 'POST', path: (c: MetaCredentials) => string, params: Record<string, string>): Promise<T> {
    const creds = await this.deps.tokens.resolve(accountId);
    const form = new URLSearchParams({ ...params, access_token: creds.accessToken });
    const base = `${this.cfg.baseUrl}/${this.cfg.graphVersion}${path(creds)}`;
    const url = method === 'GET' ? `${base}?${form.toString()}` : base;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.requestTimeoutMs);
    const http: HttpFn = this.deps.http ?? ((u, i) => fetch(u, i));
    try {
      const res = await http(url, {
        method,
        headers: method === 'POST' ? { 'content-type': 'application/x-www-form-urlencoded' } : {},
        ...(method === 'POST' ? { body: form.toString() } : {}),
        signal: ctl.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (res.status < 200 || res.status >= 300) throw classifyMetaError(res.status, json as MetaErrorBody | null, retryAfter(res.headers));
      if (json === null || typeof json !== 'object') throw new ProviderError('UNKNOWN', 'Instagram API returned an unreadable response', { httpStatus: res.status });
      return json as T;
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      // Abort or network failure: the request MAY have reached Meta. Never include the underlying message (may contain the URL).
      throw new ProviderError('TIMEOUT', 'No usable response from the Instagram API');
    } finally {
      clearTimeout(timer);
    }
  }

  async getPublishingQuota(accountId: string): Promise<PublishQuota> {
    const r = await this.call<{ data?: { quota_usage?: number; config?: { quota_total?: number; quota_duration?: number } }[] }>(
      accountId, 'GET', (c) => `/${c.igUserId}/content_publishing_limit`, { fields: 'quota_usage,config' });
    const row = r.data?.[0];
    const used = row?.quota_usage, total = row?.config?.quota_total, windowSeconds = row?.config?.quota_duration;
    if (typeof used !== 'number' || typeof total !== 'number' || typeof windowSeconds !== 'number') {
      // Fail closed: the scheduler treats a thrown error as QUOTA_UNKNOWN and publishes nothing.
      throw new ProviderError('UNKNOWN', 'Instagram quota response had an unexpected shape');
    }
    return { used, total, windowSeconds, fetchedAt: this.deps.clock.now() };
  }

  async checkEligibility(accountId: string): Promise<EligibilityResult> {
    try {
      const r = await this.call<{ account_type?: string }>(accountId, 'GET', () => '/me', { fields: 'user_id,username,account_type' });
      if (r.account_type === 'BUSINESS' || r.account_type === 'MEDIA_CREATOR') return { eligible: true };
      return { eligible: false, reason: 'NOT_PROFESSIONAL_ACCOUNT', message: 'Only Instagram professional accounts can publish through the API.' };
    } catch (e) {
      if (e instanceof ProviderError) {
        if (e.kind === 'AUTH_EXPIRED') return { eligible: false, reason: 'TOKEN_EXPIRED', message: 'The Instagram connection has expired; reconnect the account.' };
        if (e.kind === 'PERMISSION_REVOKED') return { eligible: false, reason: 'PERMISSION_MISSING', message: 'A required Instagram permission is missing.' };
        if (e.kind === 'ACCOUNT_RESTRICTED') return { eligible: false, reason: 'ACCOUNT_RESTRICTED', message: 'Instagram has restricted this account.' };
      }
      throw e;
    }
  }

  async createReelContainer(accountId: string, input: CreateReelInput): Promise<{ containerId: string }> {
    const r = await this.call<{ id?: string }>(accountId, 'POST', (c) => `/${c.igUserId}/media`, {
      media_type: 'REELS',
      video_url: input.videoUrl,
      ...(input.caption ? { caption: input.caption } : {}),
    });
    if (!r.id) throw new ProviderError('UNKNOWN', 'Instagram did not return a container id');
    return { containerId: r.id };
  }

  async getContainerStatus(accountId: string, containerId: string): Promise<ContainerStatus> {
    const r = await this.call<{ status_code?: string; status?: string }>(accountId, 'GET', () => `/${containerId}`, { fields: 'status_code,status' });
    switch (r.status_code) {
      case 'IN_PROGRESS':
      case 'FINISHED':
      case 'EXPIRED':
      case 'PUBLISHED':
        return { status: r.status_code };
      case 'ERROR':
        // `status` can carry a free-form reason; keep only a short token-like code, never the text.
        return { status: 'ERROR', errorCode: /^[A-Z0-9_]{1,40}$/.test(r.status ?? '') ? (r.status as string) : 'ERROR' };
      default:
        throw new ProviderError('UNKNOWN', 'Instagram returned an unknown container status');
    }
  }

  async publishContainer(accountId: string, containerId: string): Promise<{ mediaId: string }> {
    const r = await this.call<{ id?: string }>(accountId, 'POST', (c) => `/${c.igUserId}/media_publish`, { creation_id: containerId });
    if (!r.id) throw new ProviderError('UNKNOWN', 'Instagram did not return a media id');
    return { mediaId: r.id };
  }

  async confirmMedia(accountId: string, ref: { mediaId: string | null; containerId: string }): Promise<ConfirmResult> {
    if (!ref.mediaId) return { state: 'INDETERMINATE' }; // a PUBLISHED container does not reveal its media id
    try {
      const r = await this.call<{ id?: string; permalink?: string }>(accountId, 'GET', () => `/${ref.mediaId}`, { fields: 'id,permalink' });
      return r.id === ref.mediaId ? { state: 'CONFIRMED', ...(r.permalink ? { permalink: r.permalink } : {}) } : { state: 'INDETERMINATE' };
    } catch (e) {
      if (e instanceof ProviderError && e.kind === 'VALIDATION' && e.httpStatus === 400) return { state: 'NOT_FOUND' };
      throw e;
    }
  }
}
