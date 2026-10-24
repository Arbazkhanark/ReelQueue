// apps/web/src/lib/validate.ts
/** Client-side validators. Server remains the authority; these give instant feedback against GET /settings `limits`. */

export interface RangeLimit {
  min: number;
  max: number;
}
export interface SchedulerLimits {
  batchSize: RangeLimit;
  intervalMinutes: RangeLimit;
  cycleDurationHours: RangeLimit;
}
export interface SchedulerInput {
  batchSize: string | number;
  intervalMinutes: string | number;
  cycleDurationHours: string | number;
}
export type SchedulerField = keyof SchedulerInput;
export interface SchedulerValue {
  batchSize: number;
  intervalMinutes: number;
  cycleDurationHours: number;
}
export type SchedulerValidation =
  | { ok: true; value: SchedulerValue; errors: Record<string, never> }
  | { ok: false; errors: Partial<Record<SchedulerField, string>> };

const LABEL: Record<SchedulerField, string> = {
  batchSize: 'Batch size',
  intervalMinutes: 'Interval',
  cycleDurationHours: 'Cycle duration',
};
const UNIT: Record<SchedulerField, string> = { batchSize: '', intervalMinutes: ' minutes', cycleDurationHours: ' hours' };

export function parseWholeNumber(v: string | number): number | null {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  const t = v.trim();
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

export function validateScheduler(input: SchedulerInput, limits: SchedulerLimits): SchedulerValidation {
  const errors: Partial<Record<SchedulerField, string>> = {};
  const value: Partial<SchedulerValue> = {};
  for (const f of ['batchSize', 'intervalMinutes', 'cycleDurationHours'] as const) {
    const n = parseWholeNumber(input[f]);
    const { min, max } = limits[f];
    if (n === null) errors[f] = `${LABEL[f]} must be a whole number.`;
    else if (n < min || n > max) errors[f] = `${LABEL[f]} must be between ${min} and ${max}${UNIT[f]}.`;
    else value[f] = n;
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  return { ok: true, value: value as SchedulerValue, errors: {} };
}

export function validateEmail(email: string): string | null {
  const e = email.trim();
  if (!e) return 'Enter your email address.';
  if (e.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return 'Enter a valid email address.';
  return null;
}

/** Hint-level check only; the API enforces the real password policy and its message is shown if it disagrees. */
export function validateNewPassword(pw: string): string | null {
  if (pw.length < 12) return 'Use at least 12 characters.';
  if (pw.length > 128) return 'Use at most 128 characters.';
  return null;
}

/** Only same-origin relative paths are allowed as post-login redirect targets (prevents open redirects). */
export function safeNextPath(next: string | null | undefined, fallback = '/dashboard'): string {
  if (!next) return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  if (/^\/(login|register)(\/|\?|$)/.test(next)) return fallback;
  return next;
}
