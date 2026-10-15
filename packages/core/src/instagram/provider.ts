import type { PublishQuota } from '../domain/quota';
import type { ProviderKind } from '../domain/jobs';

/**
 * Port for everything that talks to Instagram. The scheduler depends only on this
 * interface so it can be tested with the mock provider and no network.
 *
 * Methods throw `ProviderError` (see domain/errors) with a sanitized message.
 * Methods take an internal `accountId`; the provider resolves the (decrypted)
 * token itself, so tokens never travel through scheduler code.
 */
export interface InstagramProvider {
  readonly kind: ProviderKind;
  /** True for the mock provider: publications are simulated and never real. */
  readonly isMock: boolean;

  getPublishingQuota(accountId: string): Promise<PublishQuota>;

  checkEligibility(accountId: string): Promise<EligibilityResult>;

  createReelContainer(accountId: string, input: CreateReelInput): Promise<{ containerId: string }>;

  getContainerStatus(accountId: string, containerId: string): Promise<ContainerStatus>;

  /** Calls the provider's publish endpoint. Outcome may be uncertain on timeout. */
  publishContainer(accountId: string, containerId: string): Promise<{ mediaId: string }>;

  /** Verifies a published Reel with the provider. */
  confirmMedia(
    accountId: string,
    ref: { mediaId: string | null; containerId: string },
  ): Promise<ConfirmResult>;
}

export interface CreateReelInput {
  /** Short-lived, publicly fetchable URL (e.g. presigned storage URL). */
  videoUrl: string;
  caption: string | null;
  /** Passed for correlation/logging; Meta provides no idempotency guarantee. */
  idempotencyKey: string;
}

export type EligibilityResult =
  | { eligible: true }
  | {
      eligible: false;
      reason:
        | 'NOT_PROFESSIONAL_ACCOUNT'
        | 'TOKEN_EXPIRED'
        | 'PERMISSION_MISSING'
        | 'ACCOUNT_RESTRICTED'
        | 'UNKNOWN';
      message: string;
    };

export type ContainerStatusCode = 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';

export interface ContainerStatus {
  status: ContainerStatusCode;
  /** Provider error detail when status is ERROR (sanitized). */
  errorCode?: string;
  /** Present only if the provider reports the media id for a PUBLISHED container. */
  mediaId?: string;
}

export type ConfirmResult =
  | { state: 'CONFIRMED'; permalink?: string }
  | { state: 'NOT_FOUND' }
  | { state: 'INDETERMINATE' };

export interface ProviderResolver {
  resolve(kind: ProviderKind): InstagramProvider;
}
