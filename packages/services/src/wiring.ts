// packages/services/src/wiring.ts
import { DecryptionError, MediaUnavailableError, ProviderError, type InstagramProvider, type MediaUrlProvider, type ProviderResolver, type StorageProvider, type TokenCipher } from '@reelqueue/core';
import type { MetaCredentials, TokenResolver } from '@reelqueue/integrations';
import type { DriveMediaSigner } from './drive-media';

/** Production adapters that glue stores to the core/integration ports. No test doubles here. */

/** AAD binds a ciphertext to its owner, so a token copied to another account/user fails to decrypt. */
export const tokenAad = (userId: string, providerAccountId: string): string => `ig-token:${userId}:${providerAccountId}`;


/** Same as StorageMediaUrlProvider, but videos that live in Google Drive get a signed URL served by the API itself. */
export class SourceMediaUrlProvider implements MediaUrlProvider {
  constructor(
    private readonly videos: { getPublishingSource(videoId: string): Promise<{ storageKey: string; sourceType: 'S3' | 'GOOGLE_DRIVE' } | null> },
    private readonly storage: Pick<StorageProvider, 'presignDownload'>,
    private readonly driveMedia?: Pick<DriveMediaSigner, 'sign'>,
  ) {}
  async getFetchUrl(videoId: string, ttlSeconds: number): Promise<string> {
    const s = await this.videos.getPublishingSource(videoId);
    if (!s) throw new MediaUnavailableError(`Video ${videoId} is not available for publishing (not READY or deleted)`);
    if (s.sourceType === 'GOOGLE_DRIVE') {
      if (!this.driveMedia) throw new Error('Google Drive media URLs are not configured on this process (GOOGLE_DRIVE_* / JWT_SECRET)'); // transient: fix the config and the job retries
      return this.driveMedia.sign(videoId, ttlSeconds).url;
    }
    return this.storage.presignDownload(s.storageKey, { expiresSeconds: ttlSeconds });
  }
}



export class StorageMediaUrlProvider implements MediaUrlProvider {
  constructor(private readonly videos: { getStorageKeyForPublishing(videoId: string): Promise<string | null> }, private readonly storage: Pick<StorageProvider, 'presignDownload'>) {}
  async getFetchUrl(videoId: string, ttlSeconds: number): Promise<string> {
    const key = await this.videos.getStorageKeyForPublishing(videoId);
    if (!key) throw new MediaUnavailableError(`Video ${videoId} is not available for publishing (not READY or deleted)`);
    return this.storage.presignDownload(key, { expiresSeconds: ttlSeconds });
  }
}

export interface CredentialLookup {
  getCredentials(accountId: string): Promise<{ userId: string; provider: 'META' | 'MOCK'; providerAccountId: string; accessTokenEnc: string | null; status: string } | null>;
}

/**
 * Resolves + decrypts a real account's token per call. Fails closed with PROVIDER errors (not bare Errors) so the executor's
 * normal handling applies: an account that needs re-authorisation pauses the cycle with a reason instead of the job being
 * redelivered forever. Messages never contain the token.
 */
export class DbTokenResolver implements TokenResolver {
  constructor(private readonly accounts: CredentialLookup, private readonly cipher: TokenCipher) {}
  async resolve(accountId: string): Promise<MetaCredentials> {
    const c = await this.accounts.getCredentials(accountId);
    if (!c) throw new ProviderError('VALIDATION', 'Instagram account not found');
    if (c.provider !== 'META') throw new ProviderError('VALIDATION', 'Not a real Instagram account');
    if (c.status === 'PERMISSION_REVOKED') throw new ProviderError('PERMISSION_REVOKED', 'Instagram permission was revoked');
    if (c.status !== 'CONNECTED') throw new ProviderError('AUTH_EXPIRED', `Instagram account needs to be reconnected (${c.status})`);
    if (!c.accessTokenEnc) throw new ProviderError('AUTH_EXPIRED', 'Instagram account has no stored token');
    try {
      return { accessToken: this.cipher.decrypt(c.accessTokenEnc, tokenAad(c.userId, c.providerAccountId)), igUserId: c.providerAccountId };
    } catch (e) {
      if (e instanceof DecryptionError) throw new ProviderError('AUTH_EXPIRED', 'Stored Instagram token could not be decrypted');
      throw e;
    }
  }
}

/** META is only resolvable when explicitly configured; otherwise it throws (fails closed rather than falling back to a mock). */
export class CompositeProviderResolver implements ProviderResolver {
  constructor(private readonly p: { mock: InstagramProvider; meta?: InstagramProvider }) {}
  resolve(kind: 'META' | 'MOCK'): InstagramProvider {
    if (kind === 'MOCK') return this.p.mock;
    if (!this.p.meta) throw new Error('Real Instagram provider is not enabled (INSTAGRAM_PROVIDER)');
    return this.p.meta;
  }
}
