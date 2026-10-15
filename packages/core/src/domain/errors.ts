/**
 * Provider-agnostic error taxonomy. Provider adapters (Meta, mock) translate
 * HTTP/API error codes into these kinds; the scheduler only reasons about kinds.
 *
 * Messages MUST be sanitized by the adapter: no tokens, no raw response bodies.
 */
export type ProviderErrorKind =
  | 'TRANSIENT' //         server-side hiccup, safe to retry
  | 'RATE_LIMITED' //      throttled; honour retryAfterMs
  | 'QUOTA_EXHAUSTED' //   daily publishing limit reached
  | 'AUTH_EXPIRED' //      token expired/invalid -> reauthorization needed
  | 'PERMISSION_REVOKED' // user revoked permission / missing scope
  | 'MEDIA_REJECTED' //    unsupported/invalid media; retrying cannot help
  | 'ACCOUNT_RESTRICTED' // account restricted or flagged
  | 'VALIDATION' //        bad request parameters; retrying cannot help
  | 'TIMEOUT' //           no response; the request MAY have taken effect
  | 'UNKNOWN'; //          unclassified; treated as uncertain

export interface ProviderErrorOptions {
  code?: string;
  subcode?: string;
  httpStatus?: number;
  retryAfterMs?: number;
}

export class ProviderError extends Error {
  readonly code: string | undefined;
  readonly subcode: string | undefined;
  readonly httpStatus: number | undefined;
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly kind: ProviderErrorKind,
    message: string,
    options: ProviderErrorOptions = {},
  ) {
    super(message);
    this.name = 'ProviderError';
    this.code = options.code;
    this.subcode = options.subcode;
    this.httpStatus = options.httpStatus;
    this.retryAfterMs = options.retryAfterMs;
  }
}

/** Thrown by a JobStore when the caller no longer holds the job lease. */
export class LeaseLostError extends Error {
  constructor(readonly jobId: string) {
    super(`Lease lost for job ${jobId}`);
    this.name = 'LeaseLostError';
  }
}

/** Thrown on an illegal job state transition (programming error). */
export class InvalidTransitionError extends Error {
  constructor(
    readonly from: string,
    readonly to: string,
  ) {
    super(`Illegal transition ${from} -> ${to}`);
    this.name = 'InvalidTransitionError';
  }
}
