// packages/shared/src/routes.ts
import type * as D from './dto';

/**
 * The HTTP contract, as data. The API implements exactly these routes; the web client is typed from them.
 * `auth`: 'none' | 'user' | 'admin'. All /v1 routes except those marked 'none' require the session cookie.
 */
export interface RouteSpec<Req = unknown, Res = unknown> {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  auth: 'none' | 'user' | 'admin';
  /** phantom types, never present at runtime */
  _req?: Req;
  _res?: Res;
}
const r = <Req = void, Res = void>(method: RouteSpec['method'], path: string, auth: RouteSpec['auth']): RouteSpec<Req, Res> => ({
  method,
  path,
  auth,
});

export const ROUTES = {
  register: r<D.RegisterRequest, D.RegisterResponse>('POST', '/v1/auth/register', 'none'),
  verifyEmail: r<D.VerifyEmailRequest, void>('POST', '/v1/auth/verify-email', 'none'),
  login: r<D.LoginRequest, D.AuthResponse>('POST', '/v1/auth/login', 'none'),
  refresh: r<void, D.AuthResponse>('POST', '/v1/auth/refresh', 'none'),
  logout: r<void, void>('POST', '/v1/auth/logout', 'none'),
  forgotPassword: r<D.ForgotPasswordRequest, void>('POST', '/v1/auth/forgot-password', 'none'),
  resetPassword: r<D.ResetPasswordRequest, void>('POST', '/v1/auth/reset-password', 'none'),

  me: r<void, D.UserDto>('GET', '/v1/me', 'user'),
  changePassword: r<D.ChangePasswordRequest, void>('PATCH', '/v1/me/password', 'user'),
  deleteAccount: r<D.DeleteAccountRequest, D.UserDto>('DELETE', '/v1/me', 'user'),
  cancelDeletion: r<void, D.UserDto>('POST', '/v1/me/cancel-deletion', 'user'),
  getSettings: r<void, D.SettingsDto>('GET', '/v1/settings', 'user'),
  updateSettings: r<D.UpdateSettingsRequest, D.SettingsDto>('PATCH', '/v1/settings', 'user'),

  listAccounts: r<void, D.InstagramAccountDto[]>('GET', '/v1/instagram/accounts', 'user'),
  connectInstagram: r<void, D.ConnectInstagramResponse>('POST', '/v1/instagram/connect', 'user'),
  mockConnect: r<D.MockConnectRequest, D.InstagramAccountDto>('POST', '/v1/instagram/mock-connect', 'user'),
  instagramCallback: r<void, void>('GET', '/v1/instagram/callback', 'none'), // browser redirect; state is validated
  disconnectAccount: r<void, D.InstagramAccountDto>('POST', '/v1/instagram/accounts/:id/disconnect', 'user'),
  refreshQuota: r<void, D.QuotaDto>('POST', '/v1/instagram/accounts/:id/refresh-quota', 'user'),

  initUpload: r<D.InitUploadRequest, D.InitUploadResponse>('POST', '/v1/uploads/init', 'user'),
  completeUpload: r<D.CompleteUploadRequest, D.CompleteUploadResponse>('POST', '/v1/uploads/:batchId/complete', 'user'),
  listVideos: r<void, D.Page<D.VideoDto>>('GET', '/v1/videos', 'user'),
  updateVideo: r<D.UpdateVideoRequest, D.VideoDto>('PATCH', '/v1/videos/:id', 'user'),
  reorderVideos: r<D.ReorderVideosRequest, void>('PUT', '/v1/videos/order', 'user'),
  deleteVideo: r<void, void>('DELETE', '/v1/videos/:id', 'user'),
  videoPreview: r<void, D.VideoPreviewResponse>('GET', '/v1/videos/:id/preview', 'user'),
  storage: r<void, D.StorageUsageDto>('GET', '/v1/storage', 'user'),

  currentCycle: r<void, D.CycleDto | null>('GET', '/v1/cycles/current', 'user'),
  listCycles: r<void, D.Page<D.CycleDto>>('GET', '/v1/cycles', 'user'),
  startCycle: r<D.StartCycleRequest, D.CycleDto>('POST', '/v1/cycles', 'user'),
  pauseCycle: r<void, D.CycleDto>('POST', '/v1/cycles/:id/pause', 'user'),
  resumeCycle: r<void, D.CycleDto>('POST', '/v1/cycles/:id/resume', 'user'),
  stopCycle: r<void, D.CycleDto>('POST', '/v1/cycles/:id/stop', 'user'),
  updateCycle: r<D.UpdateCycleRequest, D.CycleDto>('PATCH', '/v1/cycles/:id', 'user'),

  upcomingJobs: r<void, D.JobDto[]>('GET', '/v1/jobs/upcoming', 'user'),
  listJobs: r<void, D.Page<D.JobDto>>('GET', '/v1/jobs', 'user'),
  retryJob: r<void, D.JobDto>('POST', '/v1/jobs/:id/retry', 'user'),
  dashboard: r<void, D.DashboardDto>('GET', '/v1/dashboard', 'user'),

  adminUsers: r<void, D.Page<D.AdminUserDto>>('GET', '/v1/admin/users', 'admin'),
  adminUpdateUser: r<D.AdminUpdateUserRequest, D.AdminUserDto>('PATCH', '/v1/admin/users/:id', 'admin'),
  adminHealth: r<void, D.AdminHealthDto>('GET', '/v1/admin/health', 'admin'),
  adminFailures: r<void, D.Page<D.AdminFailureDto>>('GET', '/v1/admin/failures', 'admin'),
  adminStorage: r<void, D.AdminStorageDto>('GET', '/v1/admin/storage', 'admin'),
  adminQuota: r<void, D.AdminQuotaDto>('GET', '/v1/admin/quota', 'admin'),

  healthLive: r<void, { status: 'ok' }>('GET', '/health/live', 'none'),
  healthReady: r<void, { status: 'ok' | 'degraded'; database: 'up' | 'down'; redis: 'up' | 'down' }>('GET', '/health/ready', 'none'),


  // Google Drive Routes
  googleDriveStatus: r<void, D.GoogleDriveStatusDto>('GET', '/v1/google-drive/status', 'user'),
  connectGoogleDrive: r<void, D.ConnectGoogleDriveResponse>('POST', '/v1/google-drive/connect', 'user'),
  googleDriveCallback: r<void, void>('GET', '/v1/google-drive/callback', 'none'), // browser redirect; state is validated
  listDriveFiles: r<void, D.DriveFileListDto>('GET', '/v1/google-drive/files', 'user'),
  getDriveFile: r<void, D.DriveFileDto>('GET', '/v1/google-drive/files/:id', 'user'),
  startDriveUpload: r<D.StartDriveUploadRequest, D.StartDriveUploadResponse>('POST', '/v1/google-drive/uploads', 'user'),
  importDriveFile: r<void, { video: D.VideoDto }>('POST', '/v1/google-drive/files/:id/import', 'user'),
  downloadDriveFile: r<void, void>('GET', '/v1/google-drive/files/:id/content', 'user'), // streamed bytes, not JSON
  deleteDriveFile: r<void, void>('DELETE', '/v1/google-drive/files/:id', 'user'),
  disconnectGoogleDrive: r<void, void>('DELETE', '/v1/google-drive/connection', 'user'),
} as const;

export type RouteName = keyof typeof ROUTES;
export const AUTH_COOKIES = { access: 'rq_at', refresh: 'rq_rt' } as const;
