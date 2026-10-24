// packages/integrations/metaserc/oauth.ts
import { ProviderError, type Clock } from '@reelqueue/core';
import { classifyMetaError, type HttpFn } from './provider';

/**
 * Instagram Login (Business Login) OAuth client.
 *
 * Endpoints and parameters were read from Meta's official page on 2026-10-18
 * (developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/business-login and /get-started):
 *   authorize          GET  https://www.instagram.com/oauth/authorize          client_id, redirect_uri, response_type=code, scope, state
 *   code -> short      POST https://api.instagram.com/oauth/access_token       client_id, client_secret, grant_type=authorization_code, redirect_uri, code
 *                           -> { data: [{ access_token, user_id, permissions }] }  (older flat shape also accepted)
 *   short -> long      GET  https://graph.instagram.com/access_token           grant_type=ig_exchange_token, client_secret, access_token -> { access_token, token_type, expires_in }
 *   refresh (long)     GET  https://graph.instagram.com/refresh_access_token   grant_type=ig_refresh_token, access_token  (token >= 24 h old, unexpired, instagram_business_basic granted)
 *   profile            GET  https://graph.instagram.com/<version>/me           fields=user_id,username,account_type
 * Codes live 1 hour and are single-use; long-lived tokens live 60 days (each refresh grants another 60).
 *
 * UNVERIFIED: this code has only ever talked to a fake HTTP client, never to Meta. The exact response shapes (notably the
 * `data` array wrapper and whether `expires_in` is always present) must be confirmed against a real test account.
 * Errors are sanitised: they never contain URLs, secrets, codes or tokens.
 */
export interface MetaOAuthConfig {
  appId: string;
  appSecret: string;
  redirectUri: string;
  scopes: string[];
  graphVersion: string;
  requestTimeoutMs: number;
  /** Overridable for tests only. */
  hosts?: { authorize: string; token: string; graph: string };
}
const DEFAULT_HOSTS = { authorize: 'https://www.instagram.com', token: 'https://api.instagram.com', graph: 'https://graph.instagram.com' };

export interface ShortLivedToken { accessToken: string; userId: string; permissions: string[] }
export interface LongLivedToken { accessToken: string; expiresAt: Date; issuedAt: Date }
export interface InstagramProfile { userId: string; username: string | null; accountType: string | null }

export class MetaOAuthClient {
  private readonly hosts: { authorize: string; token: string; graph: string };
  constructor(private readonly cfg: MetaOAuthConfig, private readonly deps: { clock: Clock; http?: HttpFn }) {
    this.hosts = cfg.hosts ?? DEFAULT_HOSTS;
  }

  buildAuthorizationUrl(state: string): string {
    const q = new URLSearchParams({ client_id: this.cfg.appId, redirect_uri: this.cfg.redirectUri, response_type: 'code', scope: this.cfg.scopes.join(','), state });
    return `${this.hosts.authorize}/oauth/authorize?${q.toString()}`;
  }

  async exchangeCode(code: string): Promise<ShortLivedToken> {
    const body = new URLSearchParams({ client_id: this.cfg.appId, client_secret: this.cfg.appSecret, grant_type: 'authorization_code', redirect_uri: this.cfg.redirectUri, code });
    const j = await this.request('POST', `${this.hosts.token}/oauth/access_token`, body, 'CODE_EXCHANGE');
    const row = Array.isArray(j.data) ? (j.data[0] as Record<string, unknown> | undefined) : j; // documented: data[]; tolerate the flat shape
    const token = row?.access_token, uid = row?.user_id;
    if (typeof token !== 'string' || token === '' || (typeof uid !== 'string' && typeof uid !== 'number')) throw new ProviderError('UNKNOWN', 'Instagram code exchange returned an unexpected shape');
    const perms = row?.permissions;
    const permissions = Array.isArray(perms) ? perms.map(String) : typeof perms === 'string' ? perms.split(',').map((s) => s.trim()).filter(Boolean) : [];
    return { accessToken: token, userId: String(uid), permissions };
  }

  async exchangeForLongLived(shortToken: string): Promise<LongLivedToken> {
    const q = new URLSearchParams({ grant_type: 'ig_exchange_token', client_secret: this.cfg.appSecret, access_token: shortToken });
    return this.longLived(await this.request('GET', `${this.hosts.graph}/access_token?${q.toString()}`, undefined, 'LONG_LIVED_EXCHANGE'));
  }

  async refreshLongLived(token: string): Promise<LongLivedToken> {
    const q = new URLSearchParams({ grant_type: 'ig_refresh_token', access_token: token });
    return this.longLived(await this.request('GET', `${this.hosts.graph}/refresh_access_token?${q.toString()}`, undefined, 'REFRESH'));
  }

  async fetchProfile(token: string): Promise<InstagramProfile> {
    const q = new URLSearchParams({ fields: 'user_id,username,account_type', access_token: token });
    const j = await this.request('GET', `${this.hosts.graph}/${this.cfg.graphVersion}/me?${q.toString()}`, undefined, 'PROFILE');
    const row = (Array.isArray(j.data) ? j.data[0] : j) as Record<string, unknown> | undefined;
    const uid = row?.user_id ?? row?.id;
    if (typeof uid !== 'string' && typeof uid !== 'number') throw new ProviderError('UNKNOWN', 'Instagram profile response had an unexpected shape');
    return { userId: String(uid), username: typeof row?.username === 'string' ? row.username : null, accountType: typeof row?.account_type === 'string' ? row.account_type : null };
  }

  private longLived(j: Record<string, unknown>): LongLivedToken {
    const t = j.access_token, ttl = j.expires_in;
    if (typeof t !== 'string' || t === '' || typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) throw new ProviderError('UNKNOWN', 'Instagram token response had an unexpected shape');
    const now = this.deps.clock.now();
    return { accessToken: t, issuedAt: now, expiresAt: new Date(now.getTime() + ttl * 1000) };
  }

  private async request(method: 'GET' | 'POST', url: string, body: URLSearchParams | undefined, step: string): Promise<Record<string, unknown>> {
    const http = this.deps.http ?? (globalThis.fetch as unknown as HttpFn);
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.cfg.requestTimeoutMs);
    try {
      const res = await http(url, { method, headers: body ? { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' } : { accept: 'application/json' }, ...(body ? { body: body.toString() } : {}), signal: ctl.signal });
      const text = await res.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (res.status < 200 || res.status >= 300) {
        // OAuth endpoints answer a bad/used/expired code or bad credentials with 400 (and sometimes a different error body shape):
        const payload = json as {
          error?: {
            code?: number;
            type?: string;
            error_subcode?: number;
          };
        } | null;

        const metaError = payload?.error;
        console.log({
            event: 'instagram.oauth.token_exchange_failed',
            step,
            httpStatus: res.status,
            errorCode: metaError?.code ?? null,
            errorType: metaError?.type ?? null,
            errorSubcode: metaError?.error_subcode ?? null,
          },
          'Instagram OAuth token exchange failed',
        );


        
        // classify as VALIDATION unless Meta's regular error envelope says otherwise.
        // const e = classifyMetaError(res.status, (json as { error?: { code?: number } } | null));
        // throw new ProviderError(e.kind === 'UNKNOWN' ? 'VALIDATION' : e.kind, `Instagram OAuth ${step} failed (HTTP ${res.status})`, { httpStatus: res.status, ...(e.code ? { code: e.code } : {}) });
        
          const e = classifyMetaError(res.status, payload);
          throw new ProviderError(
            e.kind === 'UNKNOWN' ? 'VALIDATION' : e.kind,
            `Instagram OAuth ${step} failed (HTTP ${res.status})`,
            {
              httpStatus: res.status,
              ...(e.code ? { code: e.code } : {}),
            },
          );
      }
      if (json === null || typeof json !== 'object') throw new ProviderError('UNKNOWN', `Instagram OAuth ${step} returned an unreadable response`, { httpStatus: res.status });
      return json as Record<string, unknown>;
    } catch (e) {
      if (e instanceof ProviderError) throw e;
      throw new ProviderError('TIMEOUT', `No usable response from Instagram during OAuth ${step}`);
    } finally { clearTimeout(timer); }
  }
}
