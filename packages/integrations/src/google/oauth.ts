import { createHash, randomBytes } from 'node:crypto';
import { classify, defaultFetch, GoogleApiError, parseJson, send, withRetry, DEFAULT_RETRY, type GFetch, type RetryOptions } from './common';

/**
 * Google OAuth 2.0 (web-server flow) with PKCE. Endpoints and parameters are written from Google's public OAuth documentation
 * as known to the author; they have NOT been exercised against Google from this workspace (UNVERIFIED, see docs/GOOGLE_DRIVE.md).
 */
export interface GoogleOAuthConfig {
  clientId: string; clientSecret: string; redirectUri: string; scopes: string[]; requestTimeoutMs: number;
  /** Overridable for tests. */
  hosts?: { authorize: string; token: string; revoke: string };
}
const HOSTS = { authorize: 'https://accounts.google.com/o/oauth2/v2/auth', token: 'https://oauth2.googleapis.com/token', revoke: 'https://oauth2.googleapis.com/revoke' };

export interface GoogleTokens { accessToken: string; refreshToken: string | null; expiresAt: Date; scopes: string[] }
const b64url = (b: Buffer) => b.toString('base64url');
export const newPkceVerifier = (): string => b64url(randomBytes(32));
export const pkceChallenge = (verifier: string): string => b64url(createHash('sha256').update(verifier).digest());

export class GoogleOAuthClient {
  private readonly hosts: NonNullable<GoogleOAuthConfig['hosts']>;
  constructor(private readonly cfg: GoogleOAuthConfig, private readonly deps: { now: () => Date; fetch?: GFetch; retry?: Partial<RetryOptions> }) { this.hosts = cfg.hosts ?? HOSTS; }
  private get f(): GFetch { return this.deps.fetch ?? defaultFetch; }

  buildAuthorizationUrl(state: string, codeChallenge: string): string {
    const q = new URLSearchParams({
      client_id: this.cfg.clientId, redirect_uri: this.cfg.redirectUri, response_type: 'code', scope: this.cfg.scopes.join(' '), state,
      access_type: 'offline', // a refresh token
      prompt: 'consent', // Google only returns a refresh token on a consent screen
      code_challenge: codeChallenge, code_challenge_method: 'S256',
    });
    return `${this.hosts.authorize}?${q.toString()}`;
  }

  private async form(url: string, params: Record<string, string>, allowEmpty = false): Promise<Record<string, unknown>> {
    return withRetry({ ...DEFAULT_RETRY, ...this.deps.retry }, (e) => e.kind === 'UNAVAILABLE' || e.kind === 'RATE_LIMITED', async () => {
      const { res, text } = await send(this.f, this.cfg.requestTimeoutMs, url, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' }, body: new URLSearchParams(params).toString() });
      const json = parseJson(text);
      if (res.status < 200 || res.status >= 300) {
        // Token endpoint errors look like {"error":"invalid_grant"} (400/401): a dead code or revoked/expired refresh token.
        const code = (json as { error?: unknown } | null)?.error;
        if (code === 'invalid_grant') throw new GoogleApiError('AUTH_EXPIRED', 'Google rejected the grant (expired, revoked or already used)', res.status, 'invalid_grant');
        if (code === 'invalid_client' || code === 'unauthorized_client') throw new GoogleApiError('PERMISSION', 'Google rejected the OAuth client configuration', res.status, String(code));
        throw classify(res.status, json, res.headers.get('retry-after'));
      }
      if (allowEmpty) return {};
      if (json === null || typeof json !== 'object') throw new GoogleApiError('UNKNOWN', 'Google returned an unreadable token response', res.status);
      return json as Record<string, unknown>;
    });
  }
  private toTokens(j: Record<string, unknown>): GoogleTokens {
    const at = j.access_token, ttl = j.expires_in;
    if (typeof at !== 'string' || at === '' || typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) throw new GoogleApiError('UNKNOWN', 'Google token response had an unexpected shape');
    return { accessToken: at, refreshToken: typeof j.refresh_token === 'string' && j.refresh_token !== '' ? j.refresh_token : null, expiresAt: new Date(this.deps.now().getTime() + ttl * 1000), scopes: typeof j.scope === 'string' ? j.scope.split(/\s+/).filter(Boolean) : [] };
  }

  async exchangeCode(code: string, codeVerifier: string): Promise<GoogleTokens> {
    return this.toTokens(await this.form(this.hosts.token, { code, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, redirect_uri: this.cfg.redirectUri, grant_type: 'authorization_code', code_verifier: codeVerifier }));
  }
  async refresh(refreshToken: string): Promise<GoogleTokens> {
    return this.toTokens(await this.form(this.hosts.token, { refresh_token: refreshToken, client_id: this.cfg.clientId, client_secret: this.cfg.clientSecret, grant_type: 'refresh_token' }));
  }
  /** Revokes a token (the refresh token revokes the whole grant). An already-invalid token counts as revoked. */
  async revoke(token: string): Promise<void> {
    try { await this.form(this.hosts.revoke, { token }, true); }
    catch (e) { if (e instanceof GoogleApiError && (e.kind === 'AUTH_EXPIRED' || e.kind === 'VALIDATION')) return; throw e; }
  }
}