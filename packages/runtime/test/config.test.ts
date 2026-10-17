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
