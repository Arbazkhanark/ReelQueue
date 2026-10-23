/** Pure view logic for the Google Drive storage page (kept out of the component so it is unit-testable without React). */
import type { GoogleDriveStatusDto } from '@reelqueue/shared';

export type DriveViewState = 'LOADING' | 'ERROR' | 'DISABLED' | 'DISCONNECTED' | 'REAUTH_REQUIRED' | 'CONNECTED';

export function driveViewState(s: { data: GoogleDriveStatusDto | undefined; error: unknown; loading: boolean }): DriveViewState {
  if (s.data === undefined) return s.error ? 'ERROR' : 'LOADING';
  if (!s.data.enabled) return 'DISABLED';
  if (s.data.status === 'CONNECTED') return 'CONNECTED';
  if (s.data.status === 'REAUTH_REQUIRED') return 'REAUTH_REQUIRED';
  return 'DISCONNECTED';
}

/** Fixed outcome codes the API puts in the callback redirect (`/storage?connected=1` or `?error=CODE`). Unknown codes get the generic text. */
const REDIRECT_MESSAGES: Record<string, string> = {
  NOT_ENABLED: 'Google Drive is not enabled on this server.',
  ACCESS_DENIED: 'You declined access, so Google Drive was not connected.',
  STATE_INVALID: 'The connection link was invalid or already used. Please try again.',
  STATE_EXPIRED: 'The connection attempt took too long. Please try again.',
  SESSION: 'Your session expired. Sign in and try again.',
  MISSING_PERMISSION: 'Google Drive was not connected because the required permission was not granted.',
  NO_REFRESH_TOKEN: 'Google did not allow long-lived access. Remove ReelQueue from your Google account permissions and connect again.',
  PROVIDER_ERROR: 'Google could not be reached. Please try again.',
};
export function driveRedirectNotice(search: string): { tone: 'ok' | 'danger'; text: string } | null {
  const q = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search);
  if (q.get('connected') === '1') return { tone: 'ok', text: 'Google Drive connected.' };
  const e = q.get('error');
  if (e) return { tone: 'danger', text: REDIRECT_MESSAGES[e] ?? 'Google Drive could not be connected.' };
  return null;
}

/** Same rules the server enforces (it re-validates): video/mp4 or video/quicktime, up to 1 GiB. */
export const DRIVE_UPLOAD_TYPES = ['video/mp4', 'video/quicktime'] as const;
export const DRIVE_MAX_BYTES = 1024 ** 3;
export function validateDriveUpload(f: { name: string; type: string; size: number }): string | null {
  if (!f.name.trim()) return 'The file has no name.';
  if (!(DRIVE_UPLOAD_TYPES as readonly string[]).includes(f.type)) return 'Only MP4 or MOV videos can be uploaded.';
  if (f.size <= 0) return 'The file is empty.';
  if (f.size > DRIVE_MAX_BYTES) return 'The file is larger than 1 GiB.';
  return null;
}

export type UploadPhase = { kind: 'idle' } | { kind: 'uploading'; name: string; percent: number } | { kind: 'done'; name: string } | { kind: 'failed'; name: string; message: string };
export const uploadPercent = (loaded: number, total: number): number => (total <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((loaded / total) * 100))));