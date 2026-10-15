import { ProviderError } from '../domain/errors';
import type { PublishQuota } from '../domain/quota';
import type {
  ConfirmResult,
  ContainerStatus,
  CreateReelInput,
  EligibilityResult,
  InstagramProvider,
} from './provider';

export type MockOperation =
  | 'getPublishingQuota'
  | 'checkEligibility'
  | 'createReelContainer'
  | 'getContainerStatus'
  | 'publishContainer'
  | 'confirmMedia';

export interface MockFault {
  error: ProviderError;
  /**
   * When true the operation takes effect and THEN throws, simulating a lost
   * response (e.g. a timeout after the provider already published).
   */
  applyEffect?: boolean;
}

interface MockContainer {
  accountId: string;
  status: 'IN_PROGRESS' | 'FINISHED' | 'ERROR' | 'EXPIRED' | 'PUBLISHED';
  pollsRemaining: number;
  errorCode?: string;
  mediaId?: string;
}

export interface MockPublication {
  accountId: string;
  containerId: string;
  mediaId: string;
}

/**
 * MOCK PROVIDER - local development and automated tests only.
 *
 * It never contacts Instagram. Every "publication" is simulated: media ids carry
 * a `mock_media_` prefix, `isMock` is true, and the executor records the terminal
 * status SIMULATED instead of CONFIRMED so a mock result can never be mistaken
 * for a real Reel. The quota numbers here are test configuration, not a claim
 * about Instagram's real limits.
 */
export class MockInstagramProvider implements InstagramProvider {
  readonly kind = 'MOCK' as const;
  readonly isMock = true as const;

  /** Quota reported for every account, adjustable by tests. */
  quota: { used: number; total: number; windowSeconds: number } = {
    used: 0,
    total: 25,
    windowSeconds: 86_400,
  };
  /** Number of IN_PROGRESS responses before a new container becomes FINISHED. */
  processingPolls = 0;
  /** Containers created from these URLs end in ERROR (simulated rejected media). */
  rejectedUrlFragments: string[] = [];
  /** Eligibility result returned by checkEligibility. */
  eligibility: EligibilityResult = { eligible: true };

  readonly publications: MockPublication[] = [];
  readonly calls: { op: MockOperation; args: unknown[] }[] = [];

  private seq = 0;
  private readonly containers = new Map<string, MockContainer>();
  private readonly faults = new Map<MockOperation, MockFault[]>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  /** Queue a fault for the NEXT call(s) of an operation. */
  scriptFault(op: MockOperation, fault: MockFault): this {
    const list = this.faults.get(op) ?? [];
    list.push(fault);
    this.faults.set(op, list);
    return this;
  }

  callCount(op: MockOperation): number {
    return this.calls.filter((c) => c.op === op).length;
  }

  /** Test helper: force a container into a status (e.g. EXPIRED). */
  forceContainerStatus(containerId: string, status: MockContainer['status']): void {
    const c = this.containers.get(containerId);
    if (c) c.status = status;
  }

  private nextFault(op: MockOperation): MockFault | undefined {
    return this.faults.get(op)?.shift();
  }

  private record(op: MockOperation, args: unknown[]): void {
    this.calls.push({ op, args });
  }

  async getPublishingQuota(accountId: string): Promise<PublishQuota> {
    this.record('getPublishingQuota', [accountId]);
    const fault = this.nextFault('getPublishingQuota');
    if (fault) throw fault.error;
    return { ...this.quota, fetchedAt: this.now() };
  }

  async checkEligibility(accountId: string): Promise<EligibilityResult> {
    this.record('checkEligibility', [accountId]);
    const fault = this.nextFault('checkEligibility');
    if (fault) throw fault.error;
    return this.eligibility;
  }

  async createReelContainer(
    accountId: string,
    input: CreateReelInput,
  ): Promise<{ containerId: string }> {
    this.record('createReelContainer', [accountId, input.idempotencyKey]);
    const fault = this.nextFault('createReelContainer');
    const make = (): string => {
      const containerId = `mock_container_${++this.seq}`;
      const rejected = this.rejectedUrlFragments.some((f) => input.videoUrl.includes(f));
      this.containers.set(containerId, {
        accountId,
        status: rejected ? 'ERROR' : this.processingPolls > 0 ? 'IN_PROGRESS' : 'FINISHED',
        pollsRemaining: this.processingPolls,
        ...(rejected ? { errorCode: 'MOCK_UNSUPPORTED_MEDIA' } : {}),
      });
      return containerId;
    };
    if (fault) {
      if (fault.applyEffect) make();
      throw fault.error;
    }
    return { containerId: make() };
  }

  async getContainerStatus(accountId: string, containerId: string): Promise<ContainerStatus> {
    this.record('getContainerStatus', [accountId, containerId]);
    const fault = this.nextFault('getContainerStatus');
    if (fault) throw fault.error;
    const c = this.containers.get(containerId);
    if (!c || c.accountId !== accountId) {
      throw new ProviderError('VALIDATION', 'Unknown mock container', { code: 'MOCK_NOT_FOUND' });
    }
    if (c.status === 'IN_PROGRESS') {
      if (c.pollsRemaining > 0) {
        c.pollsRemaining -= 1;
        return { status: 'IN_PROGRESS' };
      }
      c.status = 'FINISHED';
    }
    return {
      status: c.status,
      ...(c.errorCode ? { errorCode: c.errorCode } : {}),
      ...(c.mediaId ? { mediaId: c.mediaId } : {}),
    };
  }

  async publishContainer(accountId: string, containerId: string): Promise<{ mediaId: string }> {
    this.record('publishContainer', [accountId, containerId]);
    const fault = this.nextFault('publishContainer');
    const apply = (): string => {
      const c = this.containers.get(containerId);
      if (!c || c.accountId !== accountId) {
        throw new ProviderError('VALIDATION', 'Unknown mock container', { code: 'MOCK_NOT_FOUND' });
      }
      if (c.status === 'PUBLISHED' && c.mediaId) return c.mediaId; // idempotent at the mock level
      if (c.status !== 'FINISHED') {
        throw new ProviderError('VALIDATION', 'Mock container not ready', { code: 'MOCK_NOT_READY' });
      }
      const mediaId = `mock_media_${++this.seq}`;
      c.status = 'PUBLISHED';
      c.mediaId = mediaId;
      this.publications.push({ accountId, containerId, mediaId });
      this.quota.used += 1;
      return mediaId;
    };
    if (fault) {
      if (fault.applyEffect) apply();
      throw fault.error;
    }
    return { mediaId: apply() };
  }

  async confirmMedia(
    accountId: string,
    ref: { mediaId: string | null; containerId: string },
  ): Promise<ConfirmResult> {
    this.record('confirmMedia', [accountId, ref.containerId]);
    const fault = this.nextFault('confirmMedia');
    if (fault) throw fault.error;
    const known = this.publications.find(
      (p) => p.accountId === accountId && p.containerId === ref.containerId,
    );
    return known ? { state: 'CONFIRMED', permalink: `mock://simulated/${known.mediaId}` } : { state: 'NOT_FOUND' };
  }
}
