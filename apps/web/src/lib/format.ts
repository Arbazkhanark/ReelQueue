/** Pure formatting helpers (no framework imports). All times are rendered in the user's timezone. */

const DASH = '—';
const LOCALE = 'en-GB'; // 24h clock, day-month order; fixed so output is deterministic

export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz) return false;
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export function browserTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function toDate(iso: string | number | Date | null | undefined): Date | null {
  if (iso === null || iso === undefined || iso === '') return null;
  const d = iso instanceof Date ? iso : new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDateTime(iso: string | number | Date | null | undefined, tz?: string | null): string {
  const d = toDate(iso);
  if (!d) return DASH;
  return new Intl.DateTimeFormat(LOCALE, {
    ...(isValidTimezone(tz) ? { timeZone: tz } : {}),
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(d);
}

export function formatTime(iso: string | number | Date | null | undefined, tz?: string | null, withSeconds = false): string {
  const d = toDate(iso);
  if (!d) return DASH;
  return new Intl.DateTimeFormat(LOCALE, {
    ...(isValidTimezone(tz) ? { timeZone: tz } : {}),
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
    hourCycle: 'h23',
  }).format(d);
}

/** Short zone label such as "GMT+5:30" for display next to times. */
export function timezoneLabel(tz?: string | null, at: Date = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      ...(isValidTimezone(tz) ? { timeZone: tz } : {}),
      timeZoneName: 'short',
    }).formatToParts(at);
    return parts.find((p) => p.type === 'timeZoneName')?.value ?? '';
  } catch {
    return '';
  }
}

/**
 * Countdown text for a remaining duration in ms.
 *   0 -> "0s", 59s -> "59s", 61s -> "1m 01s", 3661s -> "1h 01m 01s", 25h -> "1d 1h 00m" (seconds dropped from 1 day up)
 */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms)) return DASH;
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n: number) => String(n).padStart(2, '0');
  if (d > 0) return `${d}d ${h}h ${pad(m)}m`;
  if (h > 0) return `${h}h ${pad(m)}m ${pad(s)}s`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return DASH;
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  const digits = i === 0 || v >= 100 ? 0 : v >= 10 ? 1 : 2;
  return `${v.toFixed(digits)} ${units[i]}`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return DASH;
  const total = Math.round(ms / 1000);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/* ------------------------------------------------ timezone-aware day boundaries (history date filter) */

const partsFmtCache = new Map<string, Intl.DateTimeFormat>();
function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partsFmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: 'numeric',
      day: 'numeric',
      hour: 'numeric',
      minute: 'numeric',
      second: 'numeric',
    });
    partsFmtCache.set(tz, f);
  }
  return f;
}

/** Offset (ms) of `tz` from UTC at instant `ts`: wall-clock-as-UTC minus ts. */
export function tzOffsetMs(ts: number, tz: string): number {
  const parts = partsFormatter(tz).formatToParts(new Date(ts));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return asUtc - Math.floor(ts / 1000) * 1000;
}

/**
 * ISO instant for 00:00:00 of `ymd` ("YYYY-MM-DD") on the wall clock of `tz`.
 * `dayOffset` = 1 yields the start of the NEXT day (use as an exclusive upper bound).
 */
export function zonedDayStartISO(ymd: string, tz: string, dayOffset = 0): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m || !isValidTimezone(tz)) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]) + dayOffset, 0, 0, 0);
  let ts = guess - tzOffsetMs(guess, tz);
  ts = guess - tzOffsetMs(ts, tz); // second pass handles DST boundaries
  return new Date(ts).toISOString();
}
