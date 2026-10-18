import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MailError, type MailMessage, type MailTransport } from '@reelqueue/integrations';
import { SmtpMailer } from '../src';

const mk = (t: MailTransport, max = 50) => { const logs: { o: Record<string, unknown>; m: string }[] = []; return { logs, mailer: new SmtpMailer(t, 'ReelQueue <no-reply@example.com>', 'https://app.example.com', (o, m) => logs.push({ o, m }), max) }; };

describe('SmtpMailer', () => {
  it('composes the verification and reset links from the web URL, with the token URL-encoded', async () => {
    const sent: MailMessage[] = []; const { mailer } = mk({ send: async (m) => { sent.push(m); } });
    await mailer.sendVerificationEmail('a@example.com', 'tok/en+1'); await mailer.sendPasswordResetEmail('a@example.com', 'r1'); await mailer.drain();
    assert.equal(sent.length, 2);
    assert.ok(sent[0]!.text.includes('https://app.example.com/verify-email?token=tok%2Fen%2B1'));
    assert.ok(sent[1]!.text.includes('https://app.example.com/reset-password?token=r1'));
    assert.deepEqual([sent[0]!.to, sent[0]!.from], ['a@example.com', 'ReelQueue <no-reply@example.com>']);
  });
  it('never throws and never waits for the network (no account-enumeration oracle via errors or latency)', async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const slow = mk({ send: async () => { await gate; } });
    const t0 = Date.now(); await slow.mailer.sendVerificationEmail('a@example.com', 'x'); assert.ok(Date.now() - t0 < 50, 'returns immediately while the send is still running');
    release(); await slow.mailer.drain();
    for (const err of [new MailError('TRANSIENT', 'SMTP timeout'), new MailError('PERMANENT', 'rejected', 550), new Error('boom')]) {
      const f = mk({ send: async () => { throw err; } });
      await f.mailer.sendPasswordResetEmail('victim@example.com', 'SECRET-TOKEN'); await f.mailer.drain(); // resolves, does not reject
      assert.equal(f.logs.length, 1);
      const log = JSON.stringify(f.logs[0]);
      assert.ok(!log.includes('victim@example.com') && !log.includes('SECRET-TOKEN') && !log.includes('example.com/reset'), 'log has no recipient, link or token');
    }
  });
  it('bounds memory under an outage: beyond maxInFlight mails are dropped and logged', async () => {
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; }); let sends = 0;
    const { mailer, logs } = mk({ send: async () => { sends++; await gate; } }, 2);
    for (let i = 0; i < 5; i++) await mailer.sendVerificationEmail(`u${i}@example.com`, 't');
    assert.equal(sends, 2); assert.equal(logs.filter((l) => l.m === 'mail dropped').length, 3);
    release(); await mailer.drain();
  });
});
