const REDACTED = '[REDACTED]';

/** Object keys whose values must never reach logs or API responses. */
const SENSITIVE_KEY = /(pass(word)?|secret|token|authorization|cookie|api[-_]?key|private[-_]?key|credential|signature|^code$|^state$)/i;

/** Pino `redact.paths` covering the common request/response shapes. */
export const PINO_REDACT_PATHS: readonly string[] = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.password',
  '*.newPassword',
  '*.currentPassword',
  '*.accessToken',
  '*.access_token',
  '*.refreshToken',
  '*.refresh_token',
  '*.client_secret',
  '*.token',
];

/** Scrubs secrets embedded in free-form strings (URLs, error messages). */
export function redactString(input: string): string {
  return input
    .replace(/([?&](?:access_token|client_secret|token|code|refresh_token)=)[^&\s"']+/gi, `$1${REDACTED}`)
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, `$1${REDACTED}`)
    .replace(/\bIG[A-Za-z0-9_-]{30,}\b/g, REDACTED)
    .replace(/\bEAA[A-Za-z0-9]{20,}\b/g, REDACTED);
}

/** Deep-clones a value, redacting sensitive keys and scrubbing strings. Cycle-safe. */
export function redact<T>(value: T, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return redactString(value);
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return { name: value.name, message: redactString(value.message) };
  }
  if (seen.has(value)) return '[Circular]';
  seen.add(value);

  if (Array.isArray(value)) return value.map((v) => redact(v, seen));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redact(v, seen);
  }
  return out;
}
