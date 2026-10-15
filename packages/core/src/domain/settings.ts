/**
 * Application-level scheduler limits.
 *
 * IMPORTANT: these are limits of THIS application (to keep the product predictable),
 * NOT Instagram quotas. Instagram's publishing quota is always read from the API at
 * runtime (see quota.ts) and is never hardcoded here.
 */
export const SCHEDULER_LIMITS = {
  batchSize: { min: 1, max: 50, default: 1 },
  /** Minimum spacing between batch STARTS. */
  intervalMinutes: { min: 5, max: 1440, default: 20 },
  cycleDurationHours: { min: 1, max: 168, default: 24 },
} as const;

export interface SchedulerSettings {
  batchSize: number;
  intervalMinutes: number;
  cycleDurationHours: number;
  loopEnabled: boolean;
}

export const DEFAULT_SCHEDULER_SETTINGS: SchedulerSettings = {
  batchSize: SCHEDULER_LIMITS.batchSize.default,
  intervalMinutes: SCHEDULER_LIMITS.intervalMinutes.default,
  cycleDurationHours: SCHEDULER_LIMITS.cycleDurationHours.default,
  loopEnabled: false,
};

export interface ValidationIssue {
  field: string;
  code: 'NOT_INTEGER' | 'NOT_BOOLEAN' | 'OUT_OF_RANGE';
  message: string;
}

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: ValidationIssue[] };

function checkInt(
  field: 'batchSize' | 'intervalMinutes' | 'cycleDurationHours',
  raw: unknown,
  fallback: number,
  errors: ValidationIssue[],
): number {
  const value = raw === undefined ? fallback : raw;
  const { min, max } = SCHEDULER_LIMITS[field];
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    errors.push({ field, code: 'NOT_INTEGER', message: `${field} must be an integer` });
    return fallback;
  }
  if (value < min || value > max) {
    errors.push({
      field,
      code: 'OUT_OF_RANGE',
      message: `${field} must be between ${min} and ${max}`,
    });
  }
  return value;
}

/**
 * Validates user-supplied scheduler settings. Missing fields fall back to the
 * documented defaults (interval defaults to 20 minutes, duration to 24 hours).
 */
export function validateSchedulerSettings(
  input: Partial<Record<keyof SchedulerSettings, unknown>>,
): ValidationResult<SchedulerSettings> {
  const errors: ValidationIssue[] = [];
  const batchSize = checkInt('batchSize', input.batchSize, DEFAULT_SCHEDULER_SETTINGS.batchSize, errors);
  const intervalMinutes = checkInt(
    'intervalMinutes',
    input.intervalMinutes,
    DEFAULT_SCHEDULER_SETTINGS.intervalMinutes,
    errors,
  );
  const cycleDurationHours = checkInt(
    'cycleDurationHours',
    input.cycleDurationHours,
    DEFAULT_SCHEDULER_SETTINGS.cycleDurationHours,
    errors,
  );

  let loopEnabled = DEFAULT_SCHEDULER_SETTINGS.loopEnabled;
  if (input.loopEnabled !== undefined) {
    if (typeof input.loopEnabled !== 'boolean') {
      errors.push({ field: 'loopEnabled', code: 'NOT_BOOLEAN', message: 'loopEnabled must be a boolean' });
    } else {
      loopEnabled = input.loopEnabled;
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { batchSize, intervalMinutes, cycleDurationHours, loopEnabled } };
}
