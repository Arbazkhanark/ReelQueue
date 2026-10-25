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
  /** Instagram Login OAuth (meta mode only). */
  oauth: { appId: string; appSecret: string; redirectUri: string; scopes: string[]; stateSecret: string } | null;
  /** Where the browser lands after the OAuth callback and what mail links point to (a single exact origin). */
  webBaseUrl: string;
  /** Optional Google Drive integration (additional to S3, never a replacement). null = disabled; S3 and startup are unaffected. */
  googleDrive: { clientId: string; clientSecret: string; redirectUri: string; scopes: string[] } | null;
  /** Primary object storage for the upload/publish pipeline. Only 's3' exists; Drive is a separate integration (docs/GOOGLE_DRIVE.md). */
  storageProvider: 's3';
  s3: { endpoint: string; region: string; bucket: string; accessKeyId: string; secretAccessKey: string; forcePathStyle: boolean };
  mailTransport: 'log' | 'smtp';
  mail: { from: string; smtp: { host: string; port: number; security: 'tls' | 'starttls' | 'none'; user?: string; pass?: string; helo: string; timeoutMs: number } | null };
  retention: { videoDays: number; accountGraceDays: number; intervalMs: number };
  worker: { concurrency: number; sweepIntervalMs: number; sweepJitterMs: number };
  migrateOnBoot: boolean;
}

export class ConfigError extends Error {
  constructor(readonly problems: string[]) { super(`Invalid configuration:\n - ${problems.join('\n - ')}`); this.name = 'ConfigError'; }
}

type Env = Record<string, string | undefined>;

/** Maps the EMAIL_ variable names (Nodemailer-style .env) onto the SMTP_ and MAIL_ names; explicit SMTP_/MAIL_ values win. */
function withEmailAliases(raw: Env, problems: string[]): Env {
  const e: Env = { ...raw };
  const set = (k: string, v: string | undefined) => { if (v !== undefined && v.trim() !== '' && !e[k]?.trim()) e[k] = v; };
  set('SMTP_HOST', raw.EMAIL_HOST); set('SMTP_PORT', raw.EMAIL_PORT); set('SMTP_USER', raw.EMAIL_USER); set('MAIL_FROM', raw.EMAIL_FROM);
  // Google shows app passwords as "abcd efgh ijkl mnop"; the spaces are cosmetic.
  set('SMTP_PASS', raw.EMAIL_PASS !== undefined && /^[a-z]{4}( [a-z]{4}){3}$/.test(raw.EMAIL_PASS.trim()) ? raw.EMAIL_PASS.replace(/ /g, '') : raw.EMAIL_PASS?.trim());
  const sec = raw.EMAIL_SECURE?.trim().toLowerCase();
  if (sec) { if (['1', 'true', 'yes'].includes(sec)) set('SMTP_SECURITY', 'tls'); else if (['0', 'false', 'no'].includes(sec)) set('SMTP_SECURITY', 'starttls'); else problems.push('EMAIL_SECURE must be true or false'); }
  if (!e.MAIL_TRANSPORT?.trim() && raw.EMAIL_HOST?.trim()) e.MAIL_TRANSPORT = 'smtp'; // an EMAIL_HOST means "send real mail"
  return e;
}

export function loadConfig(rawEnv: Env): AppConfig {
  const problems: string[] = [];
  const env = withEmailAliases(rawEnv, problems);
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
  if (mailTransport !== 'log' && mailTransport !== 'smtp') problems.push('MAIL_TRANSPORT must be "log" or "smtp"');
  if (prod && mailTransport === 'log') problems.push('MAIL_TRANSPORT=log is not allowed in production (it writes one-time links to the log); use smtp');
  const mailFrom = str('MAIL_FROM', { required: false, def: '' });
  let smtp: AppConfig['mail']['smtp'] = null;
  if (mailTransport === 'smtp') {
    const security = str('SMTP_SECURITY', { def: 'starttls' });
    if (security !== 'tls' && security !== 'starttls' && security !== 'none') problems.push('SMTP_SECURITY must be tls, starttls or none');
    if (prod && security === 'none') problems.push('SMTP_SECURITY=none is not allowed in production');
    const host = str('SMTP_HOST');
    const user = env.SMTP_USER?.trim() || undefined; const pass = env.SMTP_PASS || undefined;
    if (!!user !== !!pass) problems.push('SMTP_USER and SMTP_PASS must be set together');
    if (user && security === 'none' && !['localhost', '127.0.0.1', '::1'].includes(host)) problems.push('SMTP credentials require SMTP_SECURITY=tls or starttls (refusing cleartext credentials)');
    if (!/^[^<>\r\n]*<[^<>\s@]+@[^<>\s@]+>$|^[^<>\s@]+@[^<>\s@]+$/.test(mailFrom)) problems.push('MAIL_FROM is required and must be "name@host" or "Name <name@host>"');
    smtp = { host, port: int('SMTP_PORT', security === 'tls' ? 465 : 587, 1, 65535), security: (security as 'tls' | 'starttls' | 'none'), ...(user ? { user } : {}), ...(pass ? { pass } : {}), helo: str('SMTP_HELO', { def: 'reelqueue' }), timeoutMs: int('SMTP_TIMEOUT_MS', 10_000, 500, 60_000) };
  }

  const webBaseUrl = str('WEB_BASE_URL', { required: false, def: origins[0] ?? '' });
  try { const u = new URL(webBaseUrl); if (u.origin !== webBaseUrl) problems.push('WEB_BASE_URL must be an exact origin without path or trailing slash'); if (prod && u.protocol !== 'https:') problems.push('WEB_BASE_URL must be https in production'); }
  catch { problems.push('WEB_BASE_URL is not a valid URL'); }

  let meta: AppConfig['meta'] = null;
  let oauth: AppConfig['oauth'] = null;
  if (provider === 'meta') {
    meta = { baseUrl: str('META_GRAPH_BASE_URL'), graphVersion: str('META_GRAPH_VERSION'), requestTimeoutMs: int('META_REQUEST_TIMEOUT_MS', 20_000, 1000, 120_000) };
    const stateSecret = str('OAUTH_STATE_SECRET');
    if (stateSecret && stateSecret.length < 32) problems.push('OAUTH_STATE_SECRET must be at least 32 characters');
    if (stateSecret && stateSecret === jwtSecret) problems.push('OAUTH_STATE_SECRET must differ from JWT_SECRET');
    const redirectUri = str('META_REDIRECT_URI');
    try { const u = new URL(redirectUri); if (prod && u.protocol !== 'https:') problems.push('META_REDIRECT_URI must be https in production'); if (u.hash) problems.push('META_REDIRECT_URI must not contain a fragment'); }
    catch { if (redirectUri) problems.push('META_REDIRECT_URI is not a valid URL'); }
    const scopes = str('META_SCOPES', { def: 'instagram_business_basic,instagram_business_content_publish' }).split(',').map((x) => x.trim()).filter(Boolean);
    oauth = { appId: str('META_APP_ID'), appSecret: str('META_APP_SECRET'), redirectUri, scopes, stateSecret };
  }
  if (prod && provider === 'mock') problems.push('INSTAGRAM_PROVIDER=mock is not allowed in production');


  // Google Drive: optional, all-or-nothing. Never broadens the OAuth scope silently.
  const DRIVE_SCOPES_ALLOWED = ['https://www.googleapis.com/auth/drive.file'];
  let googleDrive: AppConfig['googleDrive'] = null;
  const gdVars = ['GOOGLE_DRIVE_CLIENT_ID', 'GOOGLE_DRIVE_CLIENT_SECRET', 'GOOGLE_DRIVE_REDIRECT_URI'].filter((k) => env[k]?.trim());
  if (gdVars.length > 0) {
    const redirectUri = str('GOOGLE_DRIVE_REDIRECT_URI');
    try { const u = new URL(redirectUri); if (u.pathname !== '/v1/google-drive/callback') problems.push('GOOGLE_DRIVE_REDIRECT_URI must end with /v1/google-drive/callback'); if (prod && u.protocol !== 'https:') problems.push('GOOGLE_DRIVE_REDIRECT_URI must be https in production'); if (u.hash || u.search) problems.push('GOOGLE_DRIVE_REDIRECT_URI must not contain a query or fragment'); }
    catch { if (redirectUri) problems.push('GOOGLE_DRIVE_REDIRECT_URI is not a valid URL'); }
    const scopes = str('GOOGLE_DRIVE_SCOPES', { def: DRIVE_SCOPES_ALLOWED[0]! }).split(/[\s,]+/).filter(Boolean);
    if (scopes.length === 0 || scopes.some((x) => !DRIVE_SCOPES_ALLOWED.includes(x))) problems.push('GOOGLE_DRIVE_SCOPES may only contain https://www.googleapis.com/auth/drive.file (broader scopes need a deliberate code change and Google verification)');
    googleDrive = { clientId: str('GOOGLE_DRIVE_CLIENT_ID'), clientSecret: str('GOOGLE_DRIVE_CLIENT_SECRET'), redirectUri, scopes };
  }
  const storageProvider = str('STORAGE_PROVIDER', { def: 's3' }) as AppConfig['storageProvider'];
  if (storageProvider !== 's3') problems.push('STORAGE_PROVIDER must be "s3" (Google Drive is an additional integration, not a replacement for the upload/publish storage)');

  const cfg: AppConfig = {
    nodeEnv: nodeEnv as AppConfig['nodeEnv'],
    port: int('PORT', 4000, 1, 65535),
    databaseUrl: str('DATABASE_URL'),
    redisUrl: str('REDIS_URL'),
    allowedOrigins: origins,
    secureCookies,
    trustProxy: bool('TRUST_PROXY', false),
    jwtSecret,
    tokenKeys,
    tokenActiveKeyId,
    instagramProvider: provider === 'meta' ? 'meta' : 'mock',
    meta,
    oauth,
    webBaseUrl,
    googleDrive,
    storageProvider,
    s3: { endpoint: str('S3_ENDPOINT'), region: str('S3_REGION', { def: 'auto' }), bucket: str('S3_BUCKET'), accessKeyId: str('S3_ACCESS_KEY_ID'), secretAccessKey: str('S3_SECRET_ACCESS_KEY'), forcePathStyle: bool('S3_FORCE_PATH_STYLE', true) },
    mailTransport: mailTransport === 'smtp' ? 'smtp' : 'log',
    mail: { from: mailFrom, smtp },
    retention: { videoDays: int('RETENTION_VIDEO_DAYS', 30, 1, 3650), accountGraceDays: int('RETENTION_ACCOUNT_GRACE_DAYS', 14, 1, 365), intervalMs: int('RETENTION_INTERVAL_MS', 3_600_000, 60_000, 86_400_000) },
    worker: { concurrency: int('WORKER_CONCURRENCY', 5, 1, 100), sweepIntervalMs: int('SWEEP_INTERVAL_MS', 30_000, 1000, 3_600_000), sweepJitterMs: int('SWEEP_JITTER_MS', 5000, 0, 60_000) },
    migrateOnBoot: bool('MIGRATE_ON_BOOT', !prod),
  };
  if (problems.length) throw new ConfigError(problems);
  return cfg;
}
