import { createOAuthState, generateNonce, planTokenAction, ProviderError, verifyOAuthState, type Clock, type TokenCipher } from '@reelqueue/core';
import type { AccountRow, AccountStore } from '@reelqueue/db';
import type { InstagramProfile, LongLivedToken, ShortLivedToken } from '@reelqueue/integrations';
import { tokenAad } from './wiring';
import type { ServiceLogger } from './upload-service';

/** The subset of MetaOAuthClient we use (structural: tests inject a fake, production injects the real client). */
export interface OAuthPort {
  buildAuthorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<ShortLivedToken>;
  exchangeForLongLived(shortToken: string): Promise<LongLivedToken>;
  refreshLongLived(token: string): Promise<LongLivedToken>;
  fetchProfile(token: string): Promise<InstagramProfile>;
}

export type ConnectFailure = 'STATE_INVALID' | 'MISSING_PERMISSION' | 'NOT_PROFESSIONAL_ACCOUNT' | 'ACCOUNT_IN_USE' | 'PROVIDER_ERROR';
export type ConnectResult = { ok: true; account: AccountRow } | { ok: false; reason: ConnectFailure };

export interface OAuthConfig {
  /** HMAC key for the `state` parameter (>= 32 chars). */
  stateSecret: string;
  stateMaxAgeMs: number;
  /** Scopes that must be granted for publishing to work (checked only when Meta reports the granted list). */
  requiredScopes: string[];
}
export const OAUTH_STATE_MAX_AGE_MS = 10 * 60_000;
/** Account types accepted for publishing. Values from Meta's docs ("Business" | "Media_Creator"); UNVERIFIED against a live account. */
const PROFESSIONAL_TYPES = new Set(['Business', 'Media_Creator']);
function normalizeAccountType(value: string | null): string {
  return (value ?? '')
    .trim()
    .replace(/([a-z])([A-Z])/g, '$1_$2')
    .replace(/[\s-]+/g, '_')
    .toUpperCase();
}

export class InstagramConnectService {
  constructor(private readonly accounts: AccountStore, private readonly oauth: OAuthPort, private readonly cipher: TokenCipher, private readonly clock: Clock, private readonly cfg: OAuthConfig, private readonly log: ServiceLogger = { warn: () => undefined }) {}

  /** The nonce must be stored by the caller in an HttpOnly cookie and presented again on the callback: a leaked `state` alone is useless. */
  // start(userId: string): { authorizationUrl: string; nonce: string } {
  //   const nonce = generateNonce();
  //   const state = createOAuthState({ userId, nonce, issuedAt: this.clock.now().getTime() }, this.cfg.stateSecret);
  //   return { authorizationUrl: this.oauth.buildAuthorizationUrl(state), nonce };
  // }
  start(userId: string): { authorizationUrl: string; nonce: string } {
    const startedAt = Date.now();

    const nonce = generateNonce();

    const state = createOAuthState(
      {
        userId,
        nonce,
        issuedAt: this.clock.now().getTime(),
      },
      this.cfg.stateSecret,
    );

    const authorizationUrl = this.oauth.buildAuthorizationUrl(state);

    this.log.warn({
      event: 'instagram.oauth.start.completed',
      userId,
      nonceCreated: Boolean(nonce),
      stateCreated: Boolean(state),
      authorizationUrlCreated: Boolean(authorizationUrl),
      stateLength: state.length,
      nonceLength: nonce.length,
      durationMs: Date.now() - startedAt,
    }, 'Instagram OAuth start completed');

    return { authorizationUrl, nonce };
  }

  /** `userId` comes from the authenticated session, never from the request/state. */
  async complete(a: { userId: string; code: string; state: string; nonce: string }): Promise<ConnectResult> {
    const startedAt = Date.now();

    this.log.warn({
      event: 'instagram.oauth.complete.started',
      userId: a.userId,
      codePresent: Boolean(a.code),
      statePresent: Boolean(a.state),
      noncePresent: Boolean(a.nonce),
      stateLength: a.state.length,
      nonceLength: a.nonce.length,
      time:startedAt
    }, 'Instagram OAuth completion started');
    const verificationStartedAt = Date.now();
    const v = verifyOAuthState(a.state, this.cfg.stateSecret, { userId: a.userId, nonce: a.nonce, now: this.clock.now(), maxAgeMs: this.cfg.stateMaxAgeMs });
    if (!v.ok) { 
      this.log.warn({
        event: 'instagram.oauth.state.rejected',
        userId: a.userId,
        reason: v.error,
        stateLength: a.state.length,
        nonceLength: a.nonce.length,
        maxAgeMs: this.cfg.stateMaxAgeMs,
        verificationDurationMs: Date.now() - verificationStartedAt,
      }, 'Instagram OAuth state verification failed');
      return { ok: false, reason: 'STATE_INVALID' }; 
    }
    this.log.warn({
      event: 'instagram.oauth.state.verified',
      userId: a.userId,
      verificationDurationMs: Date.now() - verificationStartedAt,
    }, 'Instagram OAuth state verification succeeded');
    try {
      this.log.warn({
        event: 'instagram.oauth.token_exchange.started',
        userId: a.userId,
      }, 'Meta token exchange started');
      const short = await this.oauth.exchangeCode(a.code); // the code is single-use: a replay fails here
      this.log.warn({
        event: 'instagram.oauth.token_exchange.succeeded',
        userId: a.userId,
        permissionsCount: short.permissions.length,
      }, 'Meta token exchange succeeded');
      if (short.permissions.length > 0 && !this.cfg.requiredScopes.every((s) => short.permissions.includes(s))){
        this.log.warn({
          event: 'instagram.oauth.permissions.rejected',
          userId: a.userId,
          grantedCount: short.permissions.length,
          requiredCount: this.cfg.requiredScopes.length,
        }, 'Instagram permissions are insufficient');
        return { ok: false, reason: 'MISSING_PERMISSION' };
      }
      this.log.warn({
        event: 'instagram.oauth.long_lived_exchange.started',
        userId: a.userId,
      }, 'Long-lived token exchange started');
      const long = await this.oauth.exchangeForLongLived(short.accessToken);
      this.log.warn({
        event: 'instagram.oauth.long_lived_exchange.succeeded',
        userId: a.userId,
        issuedAtValid: Number.isFinite(long.issuedAt.getTime()),
        expiresAtValid: Number.isFinite(long.expiresAt.getTime()),
      }, 'Long-lived token exchange succeeded');
      this.log.warn({
        event: 'instagram.oauth.profile_fetch.started',
        userId: a.userId,
      }, 'Instagram profile fetch started');
      const profile = await this.oauth.fetchProfile(long.accessToken);
      this.log.warn({
        event: 'instagram.oauth.profile_fetch.succeeded',
        userId: a.userId,
        accountType: profile.accountType,
        usernamePresent: Boolean(profile.username),
        providerAccountIdPresent: Boolean(profile.userId),
      }, 'Instagram profile fetch succeeded');
      const accountType = normalizeAccountType(profile.accountType);
      this.log.warn({
        event:'instagram.oauth.profile_fetch.succeeded/complete',
        userId:a.userId,
        profile:profile,
        accountType:profile.accountType,
        usernamePresent:profile.username,
        providerAccountIdPresent:profile.userId,
        InstagramAccountType:accountType,
      },'FETCHING INSTAGRAM PROFILE')
      if (profile.accountType !== null && !PROFESSIONAL_TYPES.has(profile.accountType)){ 
          this.log.warn({
            event: 'instagram.oauth.account_type.rejected',
            userId: a.userId,
            accountType: profile.accountType,
          }, 'Instagram account type is not supported');
        return { ok: false, reason: 'NOT_PROFESSIONAL_ACCOUNT' };
      }

      this.log.warn({
        event: 'instagram.oauth.account_upsert.started',
        userId: a.userId,
      }, 'Instagram account database upsert started');
      const r = await this.accounts.upsertMeta({
        userId: a.userId, providerAccountId: profile.userId, username: profile.username, accountType: profile.accountType,
        scopes: short.permissions, tokenEnc: this.cipher.encrypt(long.accessToken, tokenAad(a.userId, profile.userId)), issuedAt: long.issuedAt, expiresAt: long.expiresAt,
      });
      this.log.warn({
        event: 'instagram.oauth.account_upsert.finished',
        userId: a.userId,
        success: r.ok,
      }, 'Instagram account database upsert finished');
      return r.ok ? { ok: true, account: r.account } : { ok: false, reason: 'ACCOUNT_IN_USE' };
    } catch (e) {
      const kind = e instanceof ProviderError ? e.kind : 'UNEXPECTED';
      // Only the error KIND is logged: never messages (they could be provider-controlled), tokens, codes or URLs.
      this.log.warn({ userId: a.userId, kind: e instanceof ProviderError ? e.kind : 'UNEXPECTED' }, 'oauth connect failed');
      this.log.warn({
        event: 'instagram.oauth.complete.failed',
        userId: a.userId,
        kind,
        durationMs: Date.now() - startedAt,
      }, 'Instagram OAuth completion failed');
      return { ok: false, reason: 'PROVIDER_ERROR' };
    }
  }
}

export interface TokenRefreshConfig { leadMs: number; claimLeaseMs: number; batch: number }
export const DEFAULT_TOKEN_REFRESH_CONFIG: TokenRefreshConfig = { leadMs: 10 * 24 * 3_600_000, claimLeaseMs: 5 * 60_000, batch: 50 };
export interface TokenRefreshReport { refreshed: number; expired: number; needsAuth: number; transientFailures: number; skipped: number }

/**
 * Keeps long-lived tokens alive (refresh when within the lead time and at least 24 h old) and flags accounts that can no
 * longer be refreshed. Safe to run in every worker concurrently (per-account lease + compare-and-set swap).
 */
export class TokenRefreshService {
  constructor(private readonly accounts: AccountStore, private readonly oauth: Pick<OAuthPort, 'refreshLongLived'>, private readonly cipher: TokenCipher, private readonly clock: Clock, private readonly cfg: TokenRefreshConfig = DEFAULT_TOKEN_REFRESH_CONFIG, private readonly log: ServiceLogger = { warn: () => undefined }) {}

  async run(): Promise<TokenRefreshReport> {
    const rep: TokenRefreshReport = { refreshed: 0, expired: 0, needsAuth: 0, transientFailures: 0, skipped: 0 };
    const now = this.clock.now();
    for (const c of await this.accounts.listTokenCandidates(now, this.cfg.leadMs, this.cfg.batch)) {
      const action = planTokenAction({ issuedAt: c.tokenIssuedAt, expiresAt: c.tokenExpiresAt, now, refreshLeadMs: this.cfg.leadMs });
      if (action === 'EXPIRED') { await this.accounts.markNeedsAuth(c.id, 'REAUTH_REQUIRED', 'TOKEN_EXPIRED'); rep.expired++; continue; }
      if (action !== 'REFRESH_DUE') { rep.skipped++; continue; }
      const oldEnc = await this.accounts.claimTokenRefresh(c.id, now, this.cfg.claimLeaseMs);
      if (!oldEnc) { rep.skipped++; continue; } // another worker has it
      try {
        let plain: string;
        try { plain = this.cipher.decrypt(oldEnc, tokenAad(c.userId, c.providerAccountId)); }
        catch { await this.accounts.markNeedsAuth(c.id, 'REAUTH_REQUIRED', 'TOKEN_UNREADABLE'); rep.needsAuth++; continue; }
        const fresh = await this.oauth.refreshLongLived(plain);
        const swapped = await this.accounts.applyRefreshedToken(c.id, oldEnc, this.cipher.encrypt(fresh.accessToken, tokenAad(c.userId, c.providerAccountId)), fresh.issuedAt, fresh.expiresAt);
        if (swapped) rep.refreshed++; else { await this.accounts.releaseTokenRefreshClaim(c.id, null); rep.skipped++; } // reconnected meanwhile: keep the newer token
      } catch (e) {
        const kind = e instanceof ProviderError ? e.kind : 'UNEXPECTED';
        this.log.warn({ accountId: c.id, kind }, 'token refresh failed');
        if (kind === 'AUTH_EXPIRED') { await this.accounts.markNeedsAuth(c.id, 'REAUTH_REQUIRED', 'AUTH_EXPIRED'); rep.needsAuth++; }
        else if (kind === 'PERMISSION_REVOKED') { await this.accounts.markNeedsAuth(c.id, 'PERMISSION_REVOKED', 'PERMISSION_REVOKED'); rep.needsAuth++; }
        else { await this.accounts.releaseTokenRefreshClaim(c.id, `REFRESH_${kind}`); rep.transientFailures++; } // retried by the next sweep
      }
    }
    return rep;
  }
}
