import { createHash } from 'node:crypto';
import { InvalidTransitionError } from './errors';

/**
 * Three distinct truths are never conflated:
 *   SCHEDULED  -> we intend to publish (our own request)
 *   ACCEPTED   -> the provider API accepted media_publish (API-accepted)
 *   CONFIRMED  -> we verified the published Reel with the provider (confirmed)
 * SIMULATED is the terminal success of the MOCK provider and is never reported as
 * a real publication.
 */
export const JOB_STATUSES = [
  'SCHEDULED',
  'DEFERRED',
  'RETRY_WAIT',
  'CREATING_CONTAINER',
  'PROCESSING_MEDIA',
  'PUBLISH_REQUESTED',
  'ACCEPTED',
  'CONFIRMED',
  'SIMULATED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];
export type ProviderKind = 'META' | 'MOCK';

export const TERMINAL_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  'CONFIRMED',
  'SIMULATED',
  'FAILED',
  'CANCELLED',
  'EXPIRED',
]);

/** Statuses that count as "the provider took the post" for queue-advance purposes. */
export const SUCCESS_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  'ACCEPTED',
  'CONFIRMED',
  'SIMULATED',
]);

/** Until PUBLISH_REQUESTED nothing irreversible has happened, so cancellation is safe. */
export const CANCELLABLE_JOB_STATUSES: ReadonlySet<JobStatus> = new Set([
  'SCHEDULED',
  'DEFERRED',
  'RETRY_WAIT',
  'CREATING_CONTAINER',
  'PROCESSING_MEDIA',
]);

const ANY_PRE_PUBLISH: JobStatus[] = ['CANCELLED', 'EXPIRED', 'DEFERRED', 'SCHEDULED', 'FAILED'];

const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  SCHEDULED: ['CREATING_CONTAINER', 'PROCESSING_MEDIA', 'RETRY_WAIT', ...ANY_PRE_PUBLISH],
  DEFERRED: ['CREATING_CONTAINER', 'PROCESSING_MEDIA', 'RETRY_WAIT', ...ANY_PRE_PUBLISH],
  RETRY_WAIT: ['CREATING_CONTAINER', 'PROCESSING_MEDIA', 'RETRY_WAIT', ...ANY_PRE_PUBLISH],
  CREATING_CONTAINER: ['PROCESSING_MEDIA', 'RETRY_WAIT', 'CREATING_CONTAINER', ...ANY_PRE_PUBLISH],
  PROCESSING_MEDIA: [
    'PROCESSING_MEDIA',
    'PUBLISH_REQUESTED',
    'CREATING_CONTAINER',
    'RETRY_WAIT',
    'ACCEPTED',
    ...ANY_PRE_PUBLISH,
  ],
  // Deliberately NO CANCELLED/EXPIRED: once a publish may have been sent, the job
  // must be reconciled first (which moves it back to PROCESSING_MEDIA/CREATING_CONTAINER
  // only when the provider proves the post does not exist).
  PUBLISH_REQUESTED: [
    'PUBLISH_REQUESTED',
    'ACCEPTED',
    'SIMULATED',
    'PROCESSING_MEDIA',
    'CREATING_CONTAINER',
    'DEFERRED',
    'SCHEDULED',
    'FAILED',
  ],
  ACCEPTED: ['ACCEPTED', 'CONFIRMED'],
  CONFIRMED: [],
  SIMULATED: [],
  FAILED: ['SCHEDULED'], // manual retry only (guarded by `retryable`)
  CANCELLED: [],
  EXPIRED: [],
};

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export function assertTransition(from: JobStatus, to: JobStatus): void {
  if (!canTransition(from, to)) throw new InvalidTransitionError(from, to);
}

/**
 * A non-terminal job blocks LATER jobs of the same account (ordering), except
 * ACCEPTED which has already been published and only awaits confirmation.
 */
export function blocksLaterJobs(status: JobStatus): boolean {
  return !TERMINAL_JOB_STATUSES.has(status) && status !== 'ACCEPTED';
}

/**
 * Deterministic idempotency key for "this video, in this cycle, on this pass".
 * Backed by a UNIQUE constraint so duplicate materialization or duplicate queue
 * events can never create a second job for the same slot.
 */
export function makeIdempotencyKey(cycleId: string, videoId: string, iteration: number): string {
  return createHash('sha256').update(`${cycleId}:${videoId}:${iteration}`).digest('hex');
}

export interface PublishJobRecord {
  id: string;
  cycleId: string;
  accountId: string;
  videoId: string;
  /** Monotonic per account; defines publication order. */
  sequenceNo: number;
  iteration: number;
  idempotencyKey: string;
  provider: ProviderKind;
  status: JobStatus;
  attemptCount: number;
  /** When the job is next eligible to run (also used as the wait timer between steps). */
  nextAttemptAt: Date;
  containerId: string | null;
  containerCreatedAt: Date | null;
  /** Persisted BEFORE media_publish is called. Presence + no mediaId = outcome uncertain. */
  publishRequestedAt: Date | null;
  mediaId: string | null;
  permalink: string | null;
  confirmAttempts: number;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  lastErrorKind: string | null;
  lastErrorCode: string | null;
  failureReason: string | null;
  retryable: boolean;
  deferredReason: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}
