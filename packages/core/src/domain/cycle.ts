export type CycleStatus = 'ACTIVE' | 'PAUSED' | 'STOPPED' | 'EXPIRED' | 'COMPLETED';
export type CycleCommand = 'PAUSE' | 'RESUME' | 'STOP' | 'EXPIRE' | 'COMPLETE';

export const TERMINAL_CYCLE_STATUSES: ReadonlySet<CycleStatus> = new Set([
  'STOPPED',
  'EXPIRED',
  'COMPLETED',
]);

export interface CycleState {
  status: CycleStatus;
  startedAt: Date;
  endsAt: Date;
}

/**
 * The status the cycle effectively has at `now`. An ACTIVE or PAUSED cycle past
 * its end is EXPIRED even if the expiry job has not run yet (late job, Redis
 * outage, worker down). Every irreversible step must use this, not the raw column.
 */
export function effectiveStatus(c: CycleState, now: Date): CycleStatus {
  if ((c.status === 'ACTIVE' || c.status === 'PAUSED') && now.getTime() >= c.endsAt.getTime()) {
    return 'EXPIRED';
  }
  return c.status;
}

/** The single guard evaluated before any irreversible publication step. */
export function canStartNewPublication(c: CycleState, now: Date): boolean {
  return effectiveStatus(c, now) === 'ACTIVE';
}

export type CommandResult =
  | { ok: true; status: CycleStatus }
  | { ok: false; code: 'INVALID_TRANSITION' | 'CYCLE_EXPIRED'; message: string };

const ALLOWED: Record<CycleCommand, { from: readonly CycleStatus[]; to: CycleStatus }> = {
  PAUSE: { from: ['ACTIVE'], to: 'PAUSED' },
  RESUME: { from: ['PAUSED'], to: 'ACTIVE' },
  STOP: { from: ['ACTIVE', 'PAUSED'], to: 'STOPPED' },
  EXPIRE: { from: ['ACTIVE', 'PAUSED'], to: 'EXPIRED' },
  COMPLETE: { from: ['ACTIVE'], to: 'COMPLETED' },
};

/**
 * Pure transition function for user/system commands.
 * Resuming a cycle whose window has elapsed is refused with CYCLE_EXPIRED
 * (the caller should persist EXPIRE instead).
 */
export function applyCycleCommand(c: CycleState, command: CycleCommand, now: Date): CommandResult {
  const rule = ALLOWED[command];
  const current = effectiveStatus(c, now);

  if (current === 'EXPIRED' && c.status !== 'EXPIRED' && command !== 'EXPIRE' && command !== 'STOP') {
    return { ok: false, code: 'CYCLE_EXPIRED', message: 'The cycle window has already elapsed' };
  }
  const from = command === 'EXPIRE' || command === 'STOP' ? c.status : current;
  if (!rule.from.includes(from)) {
    return {
      ok: false,
      code: 'INVALID_TRANSITION',
      message: `Cannot ${command} a cycle that is ${current}`,
    };
  }
  return { ok: true, status: rule.to };
}
