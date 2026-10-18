import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src';

const key = Buffer.alloc(32, 7).toString('base64');
const base = { DATABASE_URL: 'postgres://x', REDIS_URL: 'redis://x', APP_ORIGINS: 'http://localhost:3000', JWT_SECRET: 'j'.repeat(40), TOKEN_ENCRYPTION_KEYS: `k1:${key}`, TOKEN_ENCRYPTION_ACTIVE_KEY_ID: 'k1', S3_ENDPOINT: 'http://s3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's' };
const problems = (env: Record<string, string>) => { try { loadConfig(env); return []; } catch (e) { assert.ok(e instanceof ConfigError); return e.problems; } };

describe('loadConfig', () => {
  it('accepts a valid dev config with safe defaults (mock provider, 20-minute scheduler defaults untouched)', () => {
    const c = loadConfig(base);
    assert.deepEqual([c.nodeEnv, c.instagramProvider, c.port, c.secureCookies, c.migrateOnBoot, c.trustProxy], ['development', 'mock', 4000, false, true, false]);
  });
  it('reports ALL problems at once and never echoes secrets', () => {
    const p = problems({ JWT_SECRET: 'short-secret-value', APP_ORIGINS: 'http://a/b/', TOKEN_ENCRYPTION_KEYS: 'k1:c2hvcnQ=', TOKEN_ENCRYPTION_ACTIVE_KEY_ID: 'k9' });
    assert.ok(p.length >= 6, p.join('|'));
    assert.ok(p.some((x) => /DATABASE_URL is required/.test(x)) && p.some((x) => /JWT_SECRET must be at least 32/.test(x)) && p.some((x) => /exact origin/.test(x)));
    assert.ok(!p.join('').includes('short-secret-value') && !p.join('').includes('c2hvcnQ'));
  });
  it('production refuses mock provider, insecure cookies, http origins and the log mailer', () => {
    const p = problems({ ...base, NODE_ENV: 'production', COOKIE_SECURE: 'false' });
    for (const re of [/mock is not allowed in production/, /COOKIE_SECURE/, /must be https in production/, /MAIL_TRANSPORT=log is not allowed/]) assert.ok(p.some((x) => re.test(x)), String(re));
  });
  it('rejects malformed numbers/booleans/provider', () => {
    const p = problems({ ...base, PORT: '99999', TRUST_PROXY: 'maybe', INSTAGRAM_PROVIDER: 'scrape' });
    assert.ok(p.some((x) => /PORT/.test(x)) && p.some((x) => /TRUST_PROXY/.test(x)) && p.some((x) => /INSTAGRAM_PROVIDER/.test(x)));
  });
  it('meta mode demands the Graph base URL and version (never assumed)', () => {
    const p = problems({ ...base, INSTAGRAM_PROVIDER: 'meta' });
    assert.ok(p.some((x) => /META_GRAPH_BASE_URL is required/.test(x)) && p.some((x) => /META_GRAPH_VERSION is required/.test(x)));
  });
});

describe('loadConfig: mail, OAuth, retention', () => {
  const prodBase = { ...base, NODE_ENV: 'production', APP_ORIGINS: 'https://app.example.com', INSTAGRAM_PROVIDER: 'meta', META_GRAPH_BASE_URL: 'https://g', META_GRAPH_VERSION: 'v25.0', META_APP_ID: 'a', META_APP_SECRET: 's', META_REDIRECT_URI: 'https://api.example.com/v1/instagram/callback', OAUTH_STATE_SECRET: 'o'.repeat(40), MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'ReelQueue <no-reply@example.com>' };
  it('a complete production config validates and yields the SMTP/OAuth/retention sections with safe defaults', () => {
    const c = loadConfig(prodBase);
    assert.deepEqual([c.mail.smtp?.security, c.mail.smtp?.port, c.webBaseUrl, c.retention.videoDays, c.retention.accountGraceDays], ['starttls', 587, 'https://app.example.com', 30, 14]);
    assert.deepEqual(c.oauth?.scopes, ['instagram_business_basic', 'instagram_business_content_publish']);
  });
  it('smtp: requires host + valid From, credentials in pairs, never cleartext credentials, no security=none in production', () => {
    assert.ok(problems({ ...prodBase, SMTP_HOST: '', MAIL_FROM: 'nonsense' }).filter((x) => /SMTP_HOST is required|MAIL_FROM/.test(x)).length === 2);
    assert.ok(problems({ ...prodBase, SMTP_USER: 'u' }).some((x) => /set together/.test(x)));
    assert.ok(problems({ ...prodBase, SMTP_SECURITY: 'none' }).some((x) => /not allowed in production/.test(x)));
    assert.ok(problems({ ...base, MAIL_TRANSPORT: 'smtp', SMTP_HOST: 'mail.example.com', MAIL_FROM: 'a@example.com', SMTP_SECURITY: 'none', SMTP_USER: 'u', SMTP_PASS: 'p' }).some((x) => /cleartext credentials/.test(x)));
    assert.equal(loadConfig({ ...prodBase, SMTP_SECURITY: 'tls' }).mail.smtp?.port, 465);
    assert.ok(problems({ ...base, MAIL_TRANSPORT: 'sendgrid' }).some((x) => /must be "log" or "smtp"/.test(x)));
  });
  it('meta/OAuth: needs app id/secret/redirect, a 32+ char state secret different from the JWT secret, https redirect in production; never echoes the secrets', () => {
    const p = problems({ ...prodBase, META_APP_ID: '', META_APP_SECRET: '', META_REDIRECT_URI: '', OAUTH_STATE_SECRET: 'short' });
    for (const re of [/META_APP_ID is required/, /META_APP_SECRET is required/, /META_REDIRECT_URI is required/, /OAUTH_STATE_SECRET must be at least 32/]) assert.ok(p.some((x) => re.test(x)), String(re));
    assert.ok(problems({ ...prodBase, OAUTH_STATE_SECRET: base.JWT_SECRET }).some((x) => /must differ from JWT_SECRET/.test(x)));
    assert.ok(problems({ ...prodBase, META_REDIRECT_URI: 'http://api.example.com/cb' }).some((x) => /META_REDIRECT_URI must be https/.test(x)));
    assert.ok(!problems({ ...prodBase, OAUTH_STATE_SECRET: 'short', META_APP_SECRET: 'LEAKME' }).join('').includes('LEAKME'));
  });
  it('retention bounds are validated', () => {
    assert.ok(problems({ ...base, RETENTION_VIDEO_DAYS: '0' }).some((x) => /RETENTION_VIDEO_DAYS/.test(x)));
    assert.ok(problems({ ...base, RETENTION_ACCOUNT_GRACE_DAYS: '9999' }).some((x) => /RETENTION_ACCOUNT_GRACE_DAYS/.test(x)));
    assert.equal(loadConfig({ ...base, RETENTION_VIDEO_DAYS: '7' }).retention.videoDays, 7);
  });
});
