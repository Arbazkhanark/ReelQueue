/**
 * Environment -> validated config. Fails FAST at boot with every problem listed (never a half-configured server).
 * Secrets are read only here and are never echoed in error messages.
 */
export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databaseUrl: string;
  redisUrl: string;
  allowedOrigins: string[];
  secureCookies: boolean;
  trustProxy: boolean;
  jwtSecret: string;
  tokenKeys: string;
  tokenActiveKeyId: string;
  /** 'mock' = simulation only (UI shows a banner, mock-connect enabled). 'meta' = real Instagram (UNVERIFIED, see docs/INSTAGRAM_SETUP.md). */
  instagramProvider: 'mock' | 'meta';
  meta: { baseUrl: string; graphVersion: string; requestTimeoutMs: number } | null;
  s3: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean };
  mailTransport: 'log';
  worker: { concurrency: number; sweepIntervalMs: number; sweepJitterMs: number };
  migrateOnBoot: boolean;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) { super(`Invalid configuration:\n - ${problems.join('\n - ')}`); this.name = 'ConfigError'; }
}

type Env = Record<string, string | undefined>;

export function loadConfig(env: Env): AppConfig {
  const problems: string[] = [];
  const str = (k: string, o: { required?: boolean; def?: string } = {}): string => {
    const v = env[k]?.trim();
    if (v) return v;
    if (o.def !== undefined) return o.def;
    if (o.required !== false) problems.push(`${k} is required`);
    return '';
  };
  const int = (k: string, def: number, min: number, max: number): number => {
    const raw = env[k]?.trim();
    if (!raw) return def;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < min || n > max) { problems.push(`${k} must be an integer between ${min} and ${max}`); return def; }
    return n;
  };
  const bool = (k: string, def: boolean): boolean => {
    const raw = env[k]?.trim().toLowerCase();
    if (!raw) return def;
    if (['1', 'true', 'yes'].includes(raw)) return true;
    if (['0', 'false', 'no'].includes(raw)) return false;
    problems.push(`${k} must be true or false`); return def;
  };

  const nodeEnv = str('NODE_ENV', { def: 'development' });
  if (!['development', 'test', 'production'].includes(nodeEnv)) problems.push('NODE_ENV must be development, test or production');
  const prod = nodeEnv === 'production';

  const provider = str('INSTAGRAM_PROVIDER', { def: 'mock' });
  if (provider !== 'mock' && provider !== 'meta') problems.push('INSTAGRAM_PROVIDER must be "mock" or "meta"');

  const origins = str('APP_ORIGINS', { required: true }).split(',').map((s) => s.trim()).filter(Boolean);
  for (const o of origins) {
    try { const u = new URL(o); if (u.origin !== o) problems.push(`APP_ORIGINS entry "${o}" must be an exact origin without path or trailing slash`); if (prod && u.protocol !== 'https:') problems.push(`APP_ORIGINS entry "${o}" must be https in production`); }
    catch { problems.push(`APP_ORIGINS entry "${o}" is not a valid URL`); }
  }

  const jwtSecret = str('JWT_SECRET');
  if (jwtSecret && jwtSecret.length < 32) problems.push('JWT_SECRET must be at least 32 characters');

  const tokenKeys = str('TOKEN_ENCRYPTION_KEYS');
  const tokenActiveKeyId = str('TOKEN_ENCRYPTION_ACTIVE_KEY_ID');
  for (const part of tokenKeys.split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = part.indexOf(':');
    if (i <= 0 || Buffer.from(part.slice(i + 1), 'base64').length !== 32) problems.push('TOKEN_ENCRYPTION_KEYS entries must be "<id>:<base64 of exactly 32 bytes>"');
  }
  if (tokenKeys && tokenActiveKeyId && !tokenKeys.split(',').some((p) => p.trim().startsWith(`${tokenActiveKeyId}:`))) problems.push('TOKEN_ENCRYPTION_ACTIVE_KEY_ID is not in TOKEN_ENCRYPTION_KEYS');

  const secureCookies = bool('COOKIE_SECURE', prod);
  if (prod && !secureCookies) problems.push('COOKIE_SECURE must not be false in production');

  const mailTransport = str('MAIL_TRANSPORT', { def: 'log' });
  if (mailTransport !== 'log') problems.push('MAIL_TRANSPORT: only "log" is implemented');
  if (prod && mailTransport === 'log') problems.push('MAIL_TRANSPORT=log is not allowed in production (no real mail transport is implemented yet: signup/reset emails would never be delivered)');

  let meta: AppConfig['meta'] = null;
  if (provider === 'meta') {
    meta = { baseUrl: str('META_GRAPH_BASE_URL'), graphVersion: str('META_GRAPH_VERSION'), requestTimeoutMs: int('META_REQUEST_TIMEOUT_MS', 20_000, 1000, 120_000) };
  }
  if (prod && provider === 'mock') problems.push('INSTAGRAM_PROVIDER=mock is not allowed in production');

  const cfg: AppConfig = {
    nodeEnv: nodeEnv as AppConfig['nodeEnv'],
    port: int('PORT', 4000, 1, 65535),
    databaseUrl: str('DATABASE_URL'),
    redisUrl: str('REDIS_URL'),
    allowedOrigins: origins, secureCookies, trustProxy: bool('TRUST_PROXY', false),
    jwtSecret, tokenKeys, tokenActiveKeyId,
    instagramProvider: provider === 'meta' ? 'meta' : 'mock', meta,
    s3: { endpoint: str('S3_ENDPOINT'), region: str('S3_REGION', { def: 'auto' }), bucket: str('S3_BUCKET'), accessKeyId: str('S3_ACCESS_KEY_ID'), secretAccessKey: str('S3_SECRET_ACCESS_KEY'), forcePathStyle: bool('S3_FORCE_PATH_STYLE', true) },
    mailTransport: 'log',
    worker: { concurrency: int('WORKER_CONCURRENCY', 5, 1, 100), sweepIntervalMs: int('SWEEP_INTERVAL_MS', 30_000, 1000, 3_600_000), sweepJitterMs: int('SWEEP_JITTER_MS', 5000, 0, 60_000) },
    migrateOnBoot: bool('MIGRATE_ON_BOOT', !prod),
  };
  if (problems.length) throw new ConfigError(problems);
  return cfg;
}
