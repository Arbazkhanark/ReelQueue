import { randomBytes } from 'node:crypto';

/**
 * Pure rules for bulk upload sessions and media validation. Limits are configuration, not Instagram facts:
 * Meta's container status ERROR remains authoritative (see docs/INSTAGRAM_SETUP.md "Unverified").
 */
export interface UploadFileSpec {
  filename: string;
  contentType: string;
  sizeBytes: number;
}

export interface UploadLimits {
  allowedContentTypes: readonly string[];
  maxFileBytes: number;
  /** Per-user caps. */
  quotaBytes: number;
  maxVideos: number;
  maxBatchFiles: number;
}

export interface UploadUsage {
  videoCount: number;
  bytesUsed: number;
  /** Bytes reserved by other OPEN upload batches. */
  bytesReserved: number;
}

export type RejectCode = 'UNSUPPORTED_MEDIA' | 'FILE_TOO_LARGE' | 'EMPTY_FILE' | 'INVALID_NAME';
export interface RejectedFile {
  index: number;
  filename: string;
  code: RejectCode;
  message: string;
}

export type UploadPlan =
  | { ok: true; accepted: { index: number; spec: UploadFileSpec }[]; rejected: RejectedFile[]; totalBytes: number }
  | { ok: false; code: 'UPLOAD_LIMIT_EXCEEDED' | 'STORAGE_QUOTA_EXCEEDED'; message: string };

const CONTENT_TYPE_EXT: Record<string, string> = { 'video/mp4': 'mp4', 'video/quicktime': 'mov' };

/** The extension comes from the validated content type, never from the user-supplied filename. */
export function extensionFor(contentType: string): string {
  return CONTENT_TYPE_EXT[contentType.toLowerCase()] ?? 'bin';
}

/** Collision-free, user-scoped, non-guessable key. The filename is NOT part of the key. */
export function buildStorageKey(userId: string, videoId: string, contentType: string): string {
  return `u/${userId}/v/${videoId}/${randomBytes(8).toString('hex')}.${extensionFor(contentType)}`;
}

export function isSafeFilename(name: string): boolean {
  return name.length >= 1 && name.length <= 255 && !/[\u0000-\u001f\u007f/\\]/.test(name) && name.trim() === name;
}

export function planUpload(files: readonly UploadFileSpec[], limits: UploadLimits, usage: UploadUsage): UploadPlan {
  if (files.length === 0) return { ok: false, code: 'UPLOAD_LIMIT_EXCEEDED', message: 'No files were provided' };
  if (files.length > limits.maxBatchFiles) {
    return { ok: false, code: 'UPLOAD_LIMIT_EXCEEDED', message: `At most ${limits.maxBatchFiles} files can be uploaded at once` };
  }
  const allowed = new Set(limits.allowedContentTypes.map((t) => t.toLowerCase()));
  const accepted: { index: number; spec: UploadFileSpec }[] = [];
  const rejected: RejectedFile[] = [];

  files.forEach((spec, index) => {
    const reject = (code: RejectCode, message: string): void => {
      rejected.push({ index, filename: spec.filename, code, message });
    };
    if (!isSafeFilename(spec.filename)) {
      reject('INVALID_NAME', 'The file name is empty, too long, or contains control characters or slashes');
    } else if (!Number.isInteger(spec.sizeBytes) || spec.sizeBytes <= 0) {
      reject('EMPTY_FILE', 'The file is empty');
    } else if (!allowed.has(spec.contentType.toLowerCase())) {
      reject('UNSUPPORTED_MEDIA', `Unsupported type "${spec.contentType}". Allowed: ${[...allowed].join(', ')}`);
    } else if (spec.sizeBytes > limits.maxFileBytes) {
      reject('FILE_TOO_LARGE', `The file exceeds the ${limits.maxFileBytes} byte limit`);
    } else {
      accepted.push({ index, spec });
    }
  });

  if (usage.videoCount + accepted.length > limits.maxVideos) {
    return { ok: false, code: 'UPLOAD_LIMIT_EXCEEDED', message: `The library is limited to ${limits.maxVideos} videos` };
  }
  const totalBytes = accepted.reduce((n, f) => n + f.spec.sizeBytes, 0);
  if (usage.bytesUsed + usage.bytesReserved + totalBytes > limits.quotaBytes) {
    return { ok: false, code: 'STORAGE_QUOTA_EXCEEDED', message: 'This upload would exceed your storage allowance' };
  }
  return { ok: true, accepted, rejected, totalBytes };
}

export function storageLevel(bytesUsed: number, quotaBytes: number): { percentUsed: number; level: 'OK' | 'WARNING' | 'FULL' } {
  const percentUsed = quotaBytes <= 0 ? 100 : Math.min(100, Math.round((bytesUsed / quotaBytes) * 1000) / 10);
  return { percentUsed, level: percentUsed >= 100 ? 'FULL' : percentUsed >= 80 ? 'WARNING' : 'OK' };
}

/* ------------------------------------------------------------------ media */

export interface MediaMetadata {
  durationMs: number;
  width: number;
  height: number;
  videoCodec: string | null;
  audioCodec: string | null;
  container: string | null;
}

export interface MediaLimits {
  minDurationSeconds: number;
  maxDurationSeconds: number;
}

export type MediaVerdict = { ok: true } | { ok: false; code: 'NO_VIDEO_STREAM' | 'TOO_SHORT' | 'TOO_LONG' | 'BAD_DIMENSIONS'; message: string };

export function validateMedia(meta: MediaMetadata | null, limits: MediaLimits): MediaVerdict {
  if (!meta || meta.width <= 0 || meta.height <= 0) {
    return { ok: false, code: meta ? 'BAD_DIMENSIONS' : 'NO_VIDEO_STREAM', message: 'The file does not contain a playable video stream' };
  }
  const seconds = meta.durationMs / 1000;
  if (seconds < limits.minDurationSeconds) return { ok: false, code: 'TOO_SHORT', message: `Video is shorter than ${limits.minDurationSeconds}s` };
  if (seconds > limits.maxDurationSeconds) return { ok: false, code: 'TOO_LONG', message: `Video is longer than ${limits.maxDurationSeconds}s` };
  return { ok: true };
}

/** Parses `ffprobe -print_format json -show_format -show_streams` output. Returns null when there is no video stream. */
export function parseFfprobe(raw: unknown): MediaMetadata | null {
  const o = raw as { streams?: Record<string, unknown>[]; format?: Record<string, unknown> } | null;
  const streams = Array.isArray(o?.streams) ? o!.streams! : [];
  const v = streams.find((s) => s.codec_type === 'video' && !(s.disposition as { attached_pic?: number } | undefined)?.attached_pic);
  if (!v) return null;
  const a = streams.find((s) => s.codec_type === 'audio');
  const durationRaw = o?.format?.duration ?? v.duration;
  const seconds = Number(durationRaw);
  return {
    durationMs: Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0,
    width: Number(v.width) || 0,
    height: Number(v.height) || 0,
    videoCodec: typeof v.codec_name === 'string' ? v.codec_name : null,
    audioCodec: typeof a?.codec_name === 'string' ? (a.codec_name as string) : null,
    container: typeof o?.format?.format_name === 'string' ? (o.format.format_name as string) : null,
  };
}
