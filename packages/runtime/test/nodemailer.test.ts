import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MailError } from '@reelqueue/integrations';
import { NodemailerTransport, verificationMail, passwordResetMail, loadConfig, type NodemailerLike } from '../src';

const fakeNm = (sendMail: (m: Record<string, unknown>) => Promise<unknown>) => { const created: Record<string, unknown>[] = []; const nm: NodemailerLike = { createTransport: (o) => { created.push(o); return { sendMail }; } }; return { nm, created }; };
const base = { host: 'smtp.gmail.com', port: 465, security: 'tls' as const, user: 'u@gmail.com', pass: 'secretpass', timeoutMs: 5000 };

describe('NodemailerTransport (fake Nodemailer; the real package is NOT installed in this workspace)', () => {
  it('Gmail-style settings: implicit TLS on 465, auth, timeouts; sends text + html', async () => {
    const sent: Record<string, unknown>[] = []; const { nm, created } = fakeNm(async (m) => { sent.push(m); });
    await new NodemailerTransport(nm, base).send({ from: 'ReelQueue <a@gmail.com>', to: 'x@example.com', subject: 'S', text: 'T', html: '<p>H</p>' });
    assert.deepEqual([created[0]!.host, created[0]!.port, created[0]!.secure, created[0]!.requireTLS], ['smtp.gmail.com', 465, true, false]);
    assert.deepEqual(created[0]!.auth, { user: 'u@gmail.com', pass: 'secretpass' });
    assert.deepEqual([sent[0]!.to, sent[0]!.html, sent[0]!.text], ['x@example.com', '<p>H</p>', 'T']);
    new NodemailerTransport(fakeNm(async () => undefined).nm, { ...base, port: 587, security: 'starttls' });
    const st = fakeNm(async () => undefined); new NodemailerTransport(st.nm, { ...base, port: 587, security: 'starttls' });
    assert.deepEqual([st.created[0]!.secure, st.created[0]!.requireTLS], [false, true]);
  });
  it('maps failures to MailError kinds and never leaks the password or body', async () => {
    const mk = (e: object) => new NodemailerTransport(fakeNm(async () => { throw Object.assign(new Error('Invalid login: secretpass body'), e); }).nm, base);
    const m = { from: 'a@b.co', to: 'x@example.com', subject: 'S', text: 'T' };
    for (const [e, kind] of [[{ code: 'EAUTH', responseCode: 535 }, 'PERMANENT'], [{ code: 'EENVELOPE', responseCode: 550 }, 'PERMANENT'], [{ code: 'ETIMEDOUT' }, 'TRANSIENT'], [{ responseCode: 421 }, 'TRANSIENT']] as const) {
      await assert.rejects(mk(e).send(m), (x) => x instanceof MailError && x.kind === kind && !/secretpass|body/.test(x.message));
    }
  });
});

describe('mail templates', () => {
  it('contain the link in button and plain text, a clear subject, and escape dynamic values', () => {
    const link = 'https://app.example.com/verify-email?token=a%2Bb&x="><script>';
    const v = verificationMail(link);
    assert.match(v.subject, /Verify your email/); assert.ok(v.text.includes(link));
    assert.ok(!v.html.includes('<script>') && v.html.includes('&lt;script&gt;'), 'link is HTML-escaped');
    assert.ok(v.html.includes('Verify email address') && v.html.startsWith('<!doctype html>'));
    const r = passwordResetMail('https://app.example.com/reset-password?token=t');
    assert.match(r.subject, /Reset your ReelQueue password/); assert.match(r.html, /did not request a password reset/);
  });
});

describe('EMAIL_* variables (Nodemailer-style .env)', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const core = { DATABASE_URL: 'x', REDIS_URL: 'x', APP_ORIGINS: 'http://localhost:3000', JWT_SECRET: 'j'.repeat(40), TOKEN_ENCRYPTION_KEYS: `k1:${key}`, TOKEN_ENCRYPTION_ACTIVE_KEY_ID: 'k1', S3_ENDPOINT: 'http://s3', S3_BUCKET: 'b', S3_ACCESS_KEY_ID: 'a', S3_SECRET_ACCESS_KEY: 's' };
  const gmail = { ...core, EMAIL_HOST: 'smtp.gmail.com', EMAIL_PORT: '465', EMAIL_SECURE: 'true', EMAIL_USER: 'someone@gmail.com', EMAIL_PASS: 'abcd efgh ijkl mnop', EMAIL_FROM: 'ReelQueue <someone@gmail.com>' };
  it('an EMAIL_HOST alone switches to real SMTP mail; app-password spaces are removed', () => {
    const c = loadConfig(gmail);
    assert.equal(c.mailTransport, 'smtp');
    assert.deepEqual([c.mail.smtp?.host, c.mail.smtp?.port, c.mail.smtp?.security, c.mail.smtp?.user, c.mail.smtp?.pass, c.mail.from], ['smtp.gmail.com', 465, 'tls', 'someone@gmail.com', 'abcdefghijklmnop', 'ReelQueue <someone@gmail.com>']);
  });
  it('EMAIL_SECURE=false means STARTTLS; invalid values and missing From are reported without echoing the password', () => {
    assert.equal(loadConfig({ ...gmail, EMAIL_PORT: '587', EMAIL_SECURE: 'false' }).mail.smtp?.security, 'starttls');
    assert.throws(() => loadConfig({ ...gmail, EMAIL_SECURE: 'maybe' }), /EMAIL_SECURE must be true or false/);
    assert.throws(() => loadConfig({ ...gmail, EMAIL_FROM: '' }), (e: Error) => /MAIL_FROM is required/.test(e.message) && !e.message.includes('abcd'));
  });
  it('without any EMAIL_*/SMTP_* the dev log transport stays the default', () => { assert.equal(loadConfig(core).mailTransport, 'log'); });
});
