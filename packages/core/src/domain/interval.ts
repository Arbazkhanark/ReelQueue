export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * 60_000);
}

export function addHours(d: Date, hours: number): Date {
  return new Date(d.getTime() + hours * 3_600_000);
}

/**
 * Cycle window semantics (documented in docs/ARCHITECTURE.md):
 *  - `startedAt` is the instant Start Cycle is accepted.
 *  - `endsAt = startedAt + duration`, a fixed wall-clock instant.
 *  - Pausing does NOT extend the window.
 *  - A publication may only START strictly before `endsAt`.
 */
export function computeCycleWindow(
  startedAt: Date,
  durationHours: number,
): { startedAt: Date; endsAt: Date } {
  return { startedAt, endsAt: addHours(startedAt, durationHours) };
}

/**
 * Interval semantics: the interval is measured between batch START times
 * (fixed-rate), not from the completion of the previous batch.
 *
 *   next = previousScheduledFor + interval
 *
 * Anti-burst rule: if the system fell behind (worker down, long pause, long
 * backpressure), we do NOT replay the missed slots. The next batch is released
 * at `now` and the cadence continues from there:
 *
 *   next = max(previousScheduledFor + interval, now)
 *
 * Returns null when the next batch would not start strictly before `endsAt`.
 */
export function computeNextBatchAt(args: {
  previousScheduledFor: Date;
  intervalMinutes: number;
  now: Date;
  endsAt: Date;
}): Date | null {
  const cadence = addMinutes(args.previousScheduledFor, args.intervalMinutes);
  const next = cadence.getTime() >= args.now.getTime() ? cadence : args.now;
  return next.getTime() < args.endsAt.getTime() ? next : null;
}
