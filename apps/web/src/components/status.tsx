import type { InstagramAccountDto, JobStatus, VideoStatus } from '@reelqueue/shared';
import { Badge } from './ui';
import { jobStatusInfo } from '@/lib/job-status';

export function JobStatusBadge({ status }: { status: JobStatus }) {
  const i = jobStatusInfo(status);
  return (
    <Badge tone={i.tone} glyph={i.glyph} title={i.description}>
      {i.label}
    </Badge>
  );
}

export function VideoStatusBadge({ status }: { status: VideoStatus }) {
  const map: Record<VideoStatus, { label: string; tone: 'neutral' | 'info' | 'ok' | 'danger'; glyph: string }> = {
    PENDING_UPLOAD: { label: 'Pending upload', tone: 'neutral', glyph: '○' },
    VALIDATING: { label: 'Validating', tone: 'info', glyph: '◔' },
    READY: { label: 'Ready', tone: 'ok', glyph: '✓' },
    REJECTED: { label: 'Rejected', tone: 'danger', glyph: '✕' },
    FAILED: { label: 'Failed', tone: 'danger', glyph: '✕' },
  };
  const m = map[status];
  return (
    <Badge tone={m.tone} glyph={m.glyph}>
      {m.label}
    </Badge>
  );
}

export function AccountStatusBadge({ status }: { status: InstagramAccountDto['status'] }) {
  const map = {
    CONNECTED: { label: 'Connected', tone: 'ok', glyph: '✓' },
    REAUTH_REQUIRED: { label: 'Reconnect required', tone: 'warn', glyph: '!' },
    PERMISSION_REVOKED: { label: 'Permission revoked', tone: 'danger', glyph: '✕' },
    DISCONNECTED: { label: 'Disconnected', tone: 'neutral', glyph: '−' },
  } as const;
  const m = map[status];
  return (
    <Badge tone={m.tone} glyph={m.glyph}>
      {m.label}
    </Badge>
  );
}
