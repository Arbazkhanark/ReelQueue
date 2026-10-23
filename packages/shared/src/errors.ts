/** Stable, machine-readable error codes. The web app switches on these, never on messages. */
export const API_ERROR_CODES = [
  'VALIDATION_FAILED',
  'UNAUTHENTICATED',
  'FORBIDDEN',
  'NOT_FOUND', // also returned for resources owned by another tenant (no existence leak)
  'CONFLICT',
  'RATE_LIMITED',
  'EMAIL_NOT_VERIFIED',
  'EMAIL_TAKEN',
  'INVALID_CREDENTIALS',
  'ACCOUNT_LOCKED',
  'ACCOUNT_SUSPENDED',
  'TOKEN_INVALID', // verification / reset token invalid, expired or used
  'STORAGE_QUOTA_EXCEEDED',
  'UPLOAD_LIMIT_EXCEEDED',
  'UNSUPPORTED_MEDIA',
  'VIDEO_IN_USE', // referenced by a queued/active publishing job
  'INSTAGRAM_NOT_CONNECTED',
  'INSTAGRAM_REAUTH_REQUIRED',
  'INSTAGRAM_ACCOUNT_INELIGIBLE',
  'CYCLE_ALREADY_ACTIVE',
  'CYCLE_NOT_ACTIVE',
  'CYCLE_EXPIRED',
  'QUEUE_EMPTY',
  'INVALID_STATE',
  'JOB_NOT_RETRYABLE',
  'MOCK_ONLY', // endpoint only available with INSTAGRAM_PROVIDER=mock
  'INTERNAL',
  // Google Drive Errors
  'GOOGLE_DRIVE_NOT_CONNECTED',
  'GOOGLE_DRIVE_REAUTH_REQUIRED',
  'GOOGLE_DRIVE_UNAVAILABLE', // Google Drive refused or could not be reached (never carries Google's text)
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiErrorBody {
  error: {
    code: ApiErrorCode;
    message: string;
    requestId?: string;
    /** Field-level problems for VALIDATION_FAILED. */
    details?: { field: string; message: string }[];
  };
}

/** HTTP status for each code; the API's exception filter and the tests both use this table. */
export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  VALIDATION_FAILED: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  CONFLICT: 409,
  RATE_LIMITED: 429,
  EMAIL_NOT_VERIFIED: 403,
  EMAIL_TAKEN: 409,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 423,
  ACCOUNT_SUSPENDED: 403,
  TOKEN_INVALID: 400,
  STORAGE_QUOTA_EXCEEDED: 413,
  UPLOAD_LIMIT_EXCEEDED: 413,
  UNSUPPORTED_MEDIA: 415,
  VIDEO_IN_USE: 409,
  INSTAGRAM_NOT_CONNECTED: 409,
  INSTAGRAM_REAUTH_REQUIRED: 409,
  INSTAGRAM_ACCOUNT_INELIGIBLE: 422,
  CYCLE_ALREADY_ACTIVE: 409,
  CYCLE_NOT_ACTIVE: 409,
  CYCLE_EXPIRED: 409,
  QUEUE_EMPTY: 422,
  INVALID_STATE: 409,
  JOB_NOT_RETRYABLE: 409,
  MOCK_ONLY: 404,
  INTERNAL: 500,
  // Google Drive Error Codes
  GOOGLE_DRIVE_NOT_CONNECTED: 409,
  GOOGLE_DRIVE_REAUTH_REQUIRED: 409,
  GOOGLE_DRIVE_UNAVAILABLE: 502,
};

/** Thrown by services; the API layer maps it to HTTP using API_ERROR_STATUS. */
export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: { field: string; message: string }[],
  ) {
    super(message);
    this.name = 'AppError';
  }
}
