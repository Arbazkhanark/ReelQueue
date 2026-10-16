import type { CycleStatus, JobStatus, ProviderKind } from '@reelqueue/core';

export type { CycleStatus, JobStatus, ProviderKind };

export interface Page<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}
export interface PageQuery {
  page?: number; // 1-based
  pageSize?: number; // 1..100
}

/* ------------------------------------------------------------------ auth */
export type Role = 'USER' | 'ADMIN';
export type UserStatus = 'ACTIVE' | 'SUSPENDED' | 'PENDING_DELETION';

export interface UserDto {
  id: string;
  email: string;
  role: Role;
  status: UserStatus;
  emailVerified: boolean;
  createdAt: string;
  deletionRequestedAt: string | null;
}
export interface RegisterRequest { email: string; password: string }
export interface LoginRequest { email: string; password: string }
export interface VerifyEmailRequest { token: string }
export interface ForgotPasswordRequest { email: string }
export interface ResetPasswordRequest { token: string; password: string }
export interface ChangePasswordRequest { currentPassword: string; newPassword: string }
export interface DeleteAccountRequest { password: string }
export interface AuthResponse { user: UserDto }

/* -------------------------------------------------------------- settings */
export interface SettingsDto {
  timezone: string;
  batchSize: number;
  intervalMinutes: number;
  cycleDurationHours: number;
  loopEnabled: boolean;
  defaultInstagramAccountId: string | null;
  limits: {
    storageQuotaBytes: number;
    maxVideos: number;
    maxUploadBatch: number;
    batchSize: { min: number; max: number };
    intervalMinutes: { min: number; max: number };
    cycleDurationHours: { min: number; max: number };
  };
}
export type UpdateSettingsRequest = Partial<
  Pick<SettingsDto, 'timezone' | 'batchSize' | 'intervalMinutes' | 'cycleDurationHours' | 'loopEnabled' | 'defaultInstagramAccountId'>
>;

/* ------------------------------------------------------------- instagram */
export type InstagramAccountStatus = 'CONNECTED' | 'REAUTH_REQUIRED' | 'PERMISSION_REVOKED' | 'DISCONNECTED';
export interface QuotaDto {
  used: number;
  total: number;
  windowSeconds: number;
  remaining: number;
  fetchedAt: string;
}
/** Never contains a token or token ciphertext. */
export interface InstagramAccountDto {
  id: string;
  provider: ProviderKind;
  /** True when provider === 'MOCK': nothing published through this account is real. */
  isMock: boolean;
  username: string | null;
  accountType: string | null;
  status: InstagramAccountStatus;
  tokenExpiresAt: string | null;
  quota: QuotaDto | null;
  lastErrorCode: string | null;
  createdAt: string;
}
export interface ConnectInstagramResponse { authorizationUrl: string }
export interface MockConnectRequest { username: string }

/* ---------------------------------------------------------------- videos */
export type VideoStatus = 'PENDING_UPLOAD' | 'VALIDATING' | 'READY' | 'REJECTED' | 'FAILED';
export interface VideoDto {
  id: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  durationMs: number | null;
  width: number | null;
  height: number | null;
  status: VideoStatus;
  rejectionReason: string | null;
  caption: string | null;
  position: number;
  createdAt: string;
  /** True when a queued/active publishing job references this video (deletion needs confirmation). */
  inUse: boolean;
  /** Number of times this video has been published (ACCEPTED/CONFIRMED/SIMULATED). */
  publishedCount: number;
}
export interface UploadFileSpec { filename: string; contentType: string; sizeBytes: number }
export interface InitUploadRequest { files: UploadFileSpec[] }
export interface UploadTarget {
  index: number;
  videoId: string;
  /** Presigned PUT URL (short-lived). The browser uploads the file bytes directly to object storage. */
  uploadUrl: string;
  /** Headers the browser MUST send with the PUT. */
  headers: Record<string, string>;
}
export interface RejectedFile { index: number; filename: string; code: 'UNSUPPORTED_MEDIA' | 'FILE_TOO_LARGE' | 'EMPTY_FILE' | 'INVALID_NAME'; message: string }
export interface InitUploadResponse {
  batchId: string;
  expiresAt: string;
  targets: UploadTarget[];
  rejected: RejectedFile[];
}
export interface CompleteUploadRequest { uploaded: string[]; failed?: string[] } // video ids
export interface UploadBatchDto {
  id: string;
  status: 'OPEN' | 'COMPLETED' | 'ABANDONED';
  declaredFiles: number;
  completedFiles: number;
  failedFiles: number;
  expiresAt: string;
}
export interface CompleteUploadResponse { batch: UploadBatchDto; videos: VideoDto[] }
export interface UpdateVideoRequest { caption: string | null }
export interface ReorderVideosRequest { videoIds: string[] }
export interface VideoPreviewResponse { url: string; expiresAt: string }
export interface DeleteVideoQuery { confirmInUse?: boolean }

export interface StorageUsageDto {
  bytesUsed: number;
  bytesReserved: number;
  quotaBytes: number;
  videoCount: number;
  maxVideos: number;
  percentUsed: number;
  /** 'OK' < 80 %, 'WARNING' >= 80 %, 'FULL' >= 100 % (uploads blocked). */
  level: 'OK' | 'WARNING' | 'FULL';
}

/* ---------------------------------------------------------------- cycles */
export interface StartCycleRequest {
  instagramAccountId: string;
  batchSize?: number;
  intervalMinutes?: number;
  loopEnabled?: boolean;
  durationHours?: number;
}
export interface UpdateCycleRequest { loopEnabled: boolean }
export interface CycleCountsDto {
  /** Videos waiting to be released by the scheduler (not yet turned into jobs in this pass). */
  queued: number;
  /** Jobs created and not yet resolved. */
  pending: number;
  /** Provider took the post (ACCEPTED / CONFIRMED). */
  published: number;
  /** MOCK provider only; never counted as published. */
  simulated: number;
  failed: number;
  cancelled: number;
  expired: number;
}
export interface CycleWarningDto {
  code: 'QUOTA_LIMITED' | 'QUOTA_EXHAUSTED' | 'QUOTA_UNKNOWN' | 'AUTO_PAUSED' | 'REAUTH_REQUIRED' | 'MOCK_MODE';
  message: string;
}
export interface CycleDto {
  id: string;
  instagramAccountId: string;
  provider: ProviderKind;
  isMock: boolean;
  status: CycleStatus;
  pauseReason: string | null;
  batchSize: number;
  intervalMinutes: number;
  loopEnabled: boolean;
  startedAt: string;
  endsAt: string;
  nextBatchAt: string | null;
  endedAt: string | null;
  endReason: string | null;
  iteration: number;
  counts: CycleCountsDto;
  warnings: CycleWarningDto[];
}

/* ------------------------------------------------------------------ jobs */
export interface JobDto {
  id: string;
  cycleId: string;
  videoId: string;
  videoFilename: string | null;
  sequenceNo: number;
  iteration: number;
  status: JobStatus;
  /** Human-readable truth: SCHEDULED / API-ACCEPTED / CONFIRMED / SIMULATED (mock) / ... */
  isMock: boolean;
  nextAttemptAt: string;
  attemptCount: number;
  deferredReason: string | null;
  failureReason: string | null;
  lastErrorCode: string | null;
  retryable: boolean;
  permalink: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface JobListQuery extends PageQuery {
  status?: JobStatus;
  cycleId?: string;
  from?: string; // ISO
  to?: string; // ISO
}

export interface DashboardDto {
  currentCycle: CycleDto | null;
  storage: StorageUsageDto;
  accounts: InstagramAccountDto[];
  totals: { readyVideos: number; published: number; simulated: number; failed: number };
  mockMode: boolean;
}

/* ----------------------------------------------------------------- admin */
export interface AdminUserDto extends UserDto {
  videoCount: number;
  bytesUsed: number;
  accountCount: number;
  lastLoginAt: string | null;
}
export interface AdminUpdateUserRequest { status: Exclude<UserStatus, 'PENDING_DELETION'> }
export interface AdminHealthDto {
  database: 'up' | 'down';
  redis: 'up' | 'down';
  queue: { waiting: number; delayed: number; failed: number } | null;
  jobsByStatus: Record<string, number>;
  expiredLeases: number;
  mockMode: boolean;
}
export interface AdminFailureDto {
  jobId: string;
  userId: string;
  failureReason: string | null;
  lastErrorCode: string | null;
  retryable: boolean;
  updatedAt: string;
}
export interface AdminStorageDto { totalBytesUsed: number; totalVideos: number; topUsers: { userId: string; bytesUsed: number }[] }
export interface AdminQuotaDto { accounts: { accountId: string; userId: string; used: number | null; total: number | null; fetchedAt: string | null }[] }
