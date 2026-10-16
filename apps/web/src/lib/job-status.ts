import type { JobStatus } from '@reelqueue/shared';

/**
 * The three truths are never conflated:
 *  SCHEDULED  = our intent (nothing sent to Instagram yet)
 *  ACCEPTED   = Instagram's API accepted the publish request (not yet verified)
 *  CONFIRMED  = we verified the Reel exists
 * SIMULATED is the mock provider's terminal state and is NEVER a real publication.
 */
export type Tone = 'neutral' | 'info' | 'ok' | 'warn' | 'danger' | 'sim';

export interface JobStatusInfo {
  label: string;
  /** Non-color signal (shape) shown next to the label. */
  glyph: string;
  tone: Tone;
  description: string;
  /** True only for states where a real Reel was handed to / confirmed by Instagram. */
  realPublication: boolean;
}

export const JOB_STATUS_INFO: Record<JobStatus, JobStatusInfo> = {
  SCHEDULED: { label: 'Scheduled', glyph: '○', tone: 'neutral', description: 'Our intent only. Nothing has been sent to Instagram yet.', realPublication: false },
  DEFERRED: { label: 'Deferred', glyph: '⏸', tone: 'warn', description: 'Waiting - for example for quota or a paused cycle. Not published.', realPublication: false },
  RETRY_WAIT: { label: 'Retry waiting', glyph: '↻', tone: 'warn', description: 'A step failed temporarily and will be retried. Not published.', realPublication: false },
  CREATING_CONTAINER: { label: 'Preparing', glyph: '◔', tone: 'info', description: 'Creating the media container at Instagram. Not published.', realPublication: false },
  PROCESSING_MEDIA: { label: 'Processing', glyph: '◑', tone: 'info', description: 'Instagram is processing the video. Not published.', realPublication: false },
  PUBLISH_REQUESTED: { label: 'Publishing', glyph: '◕', tone: 'info', description: 'Publish requested; waiting for the API answer. Outcome not yet known.', realPublication: false },
  ACCEPTED: { label: 'API accepted', glyph: '✓', tone: 'ok', description: 'Instagram’s API accepted the publish. Not independently verified yet.', realPublication: true },
  CONFIRMED: { label: 'Confirmed', glyph: '✓✓', tone: 'ok', description: 'Verified with Instagram: the Reel exists.', realPublication: true },
  SIMULATED: { label: 'Simulated (mock)', glyph: '◇', tone: 'sim', description: 'Mock mode: nothing was published to Instagram.', realPublication: false },
  FAILED: { label: 'Failed', glyph: '✕', tone: 'danger', description: 'The job failed. See the reason.', realPublication: false },
  CANCELLED: { label: 'Cancelled', glyph: '−', tone: 'neutral', description: 'Cancelled before publishing.', realPublication: false },
  EXPIRED: { label: 'Expired', glyph: '⌛', tone: 'neutral', description: 'The cycle window ended before this job ran.', realPublication: false },
};

export function jobStatusInfo(status: string): JobStatusInfo {
  return (JOB_STATUS_INFO as Record<string, JobStatusInfo | undefined>)[status] ?? {
    label: status,
    glyph: '?',
    tone: 'neutral',
    description: 'Unknown status.',
    realPublication: false,
  };
}
