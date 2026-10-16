import type { CycleDto, InstagramAccountDto } from '@reelqueue/shared';

export type LiveStatus = 'ACTIVE' | 'PAUSED';

/** Status the cycle effectively has at `nowMs` (an ACTIVE/PAUSED cycle past its end is EXPIRED, mirroring core). */
export function effectiveCycleStatus(c: Pick<CycleDto, 'status' | 'endsAt'>, nowMs: number): CycleDto['status'] {
  if ((c.status === 'ACTIVE' || c.status === 'PAUSED') && nowMs >= Date.parse(c.endsAt)) return 'EXPIRED';
  return c.status;
}

/** A cycle that still holds the "one live cycle" slot and can be controlled. */
export function isLiveCycle(c: CycleDto | null | undefined, nowMs: number): c is CycleDto {
  if (!c) return false;
  const s = effectiveCycleStatus(c, nowMs);
  return s === 'ACTIVE' || s === 'PAUSED';
}

export interface Control {
  enabled: boolean;
  /** Always set when disabled: shown as visible helper text and as the tooltip. */
  reason: string | null;
}
export interface CycleControls {
  start: Control;
  pause: Control;
  resume: Control;
  stop: Control;
}

export interface ControlContext {
  cycle: CycleDto | null | undefined;
  nowMs: number;
  account: Pick<InstagramAccountDto, 'status'> | null | undefined;
  readyVideos: number | null;
  settingsValid: boolean;
  busy: boolean;
}

const ok: Control = { enabled: true, reason: null };
const no = (reason: string): Control => ({ enabled: false, reason });

export function cycleControls(ctx: ControlContext): CycleControls {
  const { cycle, nowMs, account, readyVideos, settingsValid, busy } = ctx;
  const live = isLiveCycle(cycle, nowMs);
  const eff = cycle ? effectiveCycleStatus(cycle, nowMs) : null;
  const busyReason = 'Another action is in progress.';

  let start: Control;
  if (live) start = no('A cycle is already running or paused. Stop it first.');
  else if (!account) start = no('Select a connected Instagram account.');
  else if (account.status !== 'CONNECTED') start = no('This Instagram account needs to be reconnected first.');
  else if (readyVideos === null) start = no('Loading video counts…');
  else if (readyVideos === 0) start = no('Upload at least one ready video first.');
  else if (!settingsValid) start = no('Fix the highlighted scheduler settings.');
  else start = busy ? no(busyReason) : ok;

  const noLive = (what: string): Control =>
    eff === 'EXPIRED' && cycle && (cycle.status === 'ACTIVE' || cycle.status === 'PAUSED')
      ? no('The 24h window has elapsed; the server will mark this cycle expired.')
      : no(`There is no live cycle to ${what}.`);

  const pause = !live ? noLive('pause') : eff !== 'ACTIVE' ? no('Only an active cycle can be paused.') : busy ? no(busyReason) : ok;
  const resume = !live ? noLive('resume') : eff !== 'PAUSED' ? no('Only a paused cycle can be resumed.') : busy ? no(busyReason) : ok;
  const stop = !live ? noLive('stop') : busy ? no(busyReason) : ok;
  return { start, pause, resume, stop };
}
