/**
 * Pure state machine for the bulk upload screen. No I/O: the runner (./upload-runner.ts) feeds it actions.
 *
 *   queued -> uploading -> uploaded
 *                      \-> failed -> (RETRY) -> queued
 *   rejected: refused by POST /uploads/init (never uploaded, not retryable)
 */
export type UploadItemStatus = 'queued' | 'uploading' | 'uploaded' | 'failed' | 'rejected';

export interface UploadItem {
  index: number;
  filename: string;
  sizeBytes: number;
  status: UploadItemStatus;
  loaded: number;
  attempts: number;
  videoId: string | null;
  error: string | null;
  rejectionCode: string | null;
}

export interface UploadState {
  concurrency: number;
  items: UploadItem[];
}

export const DEFAULT_CONCURRENCY = 4;

export type UploadAction =
  | {
      type: 'INIT';
      files: { index: number; filename: string; sizeBytes: number }[];
      targets: { index: number; videoId: string }[];
      rejected: { index: number; code: string; message: string }[];
      concurrency?: number;
    }
  | { type: 'START'; index: number }
  | { type: 'PROGRESS'; index: number; loaded: number }
  | { type: 'SUCCESS'; index: number }
  | { type: 'FAILURE'; index: number; error: string }
  | { type: 'RETRY'; index: number }
  | { type: 'RETRY_ALL' }
  | { type: 'CANCEL_QUEUED' };

export const initialUploadState: UploadState = { concurrency: DEFAULT_CONCURRENCY, items: [] };

function patch(state: UploadState, index: number, fn: (it: UploadItem) => UploadItem): UploadState {
  let changed = false;
  const items = state.items.map((it) => {
    if (it.index !== index) return it;
    const next = fn(it);
    if (next !== it) changed = true;
    return next;
  });
  return changed ? { ...state, items } : state;
}

export function uploadReducer(state: UploadState, action: UploadAction): UploadState {
  switch (action.type) {
    case 'INIT': {
      const targetByIndex = new Map(action.targets.map((t) => [t.index, t.videoId]));
      const rejectedByIndex = new Map(action.rejected.map((r) => [r.index, r]));
      const items: UploadItem[] = action.files.map((f) => {
        const base = { index: f.index, filename: f.filename, sizeBytes: f.sizeBytes, loaded: 0, attempts: 0 };
        const rej = rejectedByIndex.get(f.index);
        if (rej) return { ...base, status: 'rejected', videoId: null, error: rej.message, rejectionCode: rej.code };
        const videoId = targetByIndex.get(f.index);
        if (videoId === undefined) {
          return { ...base, status: 'failed', videoId: null, error: 'The server returned no upload target for this file.', rejectionCode: null };
        }
        return { ...base, status: 'queued', videoId, error: null, rejectionCode: null };
      });
      const c = action.concurrency ?? DEFAULT_CONCURRENCY;
      return { concurrency: Math.max(1, Math.floor(c)), items };
    }
    case 'START':
      return patch(state, action.index, (it) =>
        it.status === 'queued' ? { ...it, status: 'uploading', loaded: 0, attempts: it.attempts + 1, error: null } : it,
      );
    case 'PROGRESS':
      return patch(state, action.index, (it) =>
        it.status === 'uploading' ? { ...it, loaded: Math.max(0, Math.min(it.sizeBytes, action.loaded)) } : it,
      );
    case 'SUCCESS':
      return patch(state, action.index, (it) =>
        it.status === 'uploading' ? { ...it, status: 'uploaded', loaded: it.sizeBytes, error: null } : it,
      );
    case 'FAILURE':
      return patch(state, action.index, (it) =>
        it.status === 'uploading' || it.status === 'queued' ? { ...it, status: 'failed', loaded: 0, error: action.error } : it,
      );
    case 'RETRY':
      return patch(state, action.index, (it) =>
        it.status === 'failed' && it.videoId !== null ? { ...it, status: 'queued', loaded: 0, error: null } : it,
      );
    case 'RETRY_ALL':
      return {
        ...state,
        items: state.items.map((it) =>
          it.status === 'failed' && it.videoId !== null ? { ...it, status: 'queued', loaded: 0, error: null } : it,
        ),
      };
    case 'CANCEL_QUEUED':
      return {
        ...state,
        items: state.items.map((it) => (it.status === 'queued' ? { ...it, status: 'failed', error: 'Cancelled', loaded: 0 } : it)),
      };
    default:
      return state;
  }
}

/* ---------------------------------------------------------------- selectors */

export function countBy(state: UploadState, status: UploadItemStatus): number {
  return state.items.reduce((n, it) => n + (it.status === status ? 1 : 0), 0);
}

/** Indexes that may start now, honouring the concurrency limit, in file order. */
export function nextToStart(state: UploadState): number[] {
  const free = state.concurrency - countBy(state, 'uploading');
  if (free <= 0) return [];
  return state.items
    .filter((it) => it.status === 'queued')
    .slice(0, free)
    .map((it) => it.index);
}

/** True when nothing is queued or in flight (everything is uploaded, failed or rejected). */
export function isSettled(state: UploadState): boolean {
  return state.items.every((it) => it.status !== 'queued' && it.status !== 'uploading');
}

/** 0..1 across all files that are being uploaded (rejected files are excluded). */
export function overallProgress(state: UploadState): number {
  let total = 0;
  let loaded = 0;
  for (const it of state.items) {
    if (it.status === 'rejected') continue;
    total += it.sizeBytes;
    loaded += it.status === 'uploaded' ? it.sizeBytes : it.loaded;
  }
  return total === 0 ? 0 : Math.min(1, loaded / total);
}

export function itemProgress(it: UploadItem): number {
  if (it.status === 'uploaded') return 1;
  return it.sizeBytes === 0 ? 0 : Math.min(1, it.loaded / it.sizeBytes);
}

export function uploadedVideoIds(state: UploadState): string[] {
  return state.items.filter((it) => it.status === 'uploaded' && it.videoId).map((it) => it.videoId as string);
}
/** Ids of files that got a target but did not upload (reported to completeUpload as `failed`). */
export function failedVideoIds(state: UploadState): string[] {
  return state.items.filter((it) => it.status === 'failed' && it.videoId).map((it) => it.videoId as string);
}
