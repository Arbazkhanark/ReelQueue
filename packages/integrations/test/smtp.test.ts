import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server, type Socket } from 'node:net';
import { SmtpTransport, MailError, buildMessage, dotStuff, isMailbox } from '../src';

interface Seen { cmds: string[]; data: string }
/** Minimal in-process SMTP server. `rcpt`/`auth` let a test force a rejection. */
async function fake(o: { auth?: string[]; ehlo?: string[]; rcpt?: string; greet?: string; hang?: boolean } = {}): Promise<{ port: number; seen: Seen; close: () => void; server: Server }> {
  const seen: Seen = { cmds: [], data: '' };
  const socks = new Set<Socket>();
  const server = createServer((s) => {
    socks.add(s); s.setEncoding('utf8'); let buf = ''; let inData = false;
    const w = (x: string) => s.write(x + '\r\n');
    if (o.hang) return;
    w(o.greet ?? '220 fake ESMTP');
    s.on('data', (d: string) => {
      buf += d;
      for (;;) {
        if (inData) { const i = buf.indexOf('\r\n.\r\n'); if (i < 0) return; seen.data = buf.slice(0, i + 2); buf = buf.slice(i + 5); inData = false; w('250 queued'); continue; }
        const i = buf.indexOf('\r\n'); if (i < 0) return;
        const line = buf.slice(0, i); buf = buf.slice(i + 2); seen.cmds.push(line);
        if (/^EHLO/i.test(line)) { const ex = o.ehlo ?? ['AUTH PLAIN LOGIN']; w(['250-fake', ...ex.map((e) => `250-${e}`)].slice(0, -1).concat(`250 ${ex.length ? ex[ex.length - 1] : 'fake'}`).join('\r\n')); }
        else if (/^AUTH PLAIN/i.test(line)) w(o.auth?.includes('bad') ? '535 auth failed' : '235 ok');
        else if (/^MAIL FROM/i.test(line)) w('250 ok');
        else if (/^RCPT TO/i.test(line)) w(o.rcpt ?? '250 ok');
        else if (/^DATA/i.test(line)) { w('354 go'); inData = true; }
        else if (/^QUIT/i.test(line)) { w('221 bye'); s.end(); }
        else w('500 what');
      }
    });
    s.on('close', () => socks.delete(s)); s.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as { port: number }).port, seen, server, close: () => { socks.forEach((x) => x.destroy()); server.close(); } };
}
const cfg = (port: number, extra = {}) => ({ host: '127.0.0.1', port, security: 'none' as const, helo: 'reelqueue.test', timeoutMs: 1500, ...extra });
const msg = { from: 'ReelQueue <no-reply@reelqueue.example>', to: 'user@example.com', subject: 'Hello', text: 'Line1\n.dot line\nLine3' };

describe('SMTP transport (fake in-process server; NOT verified against a real provider)', () => {
  it('delivers: EHLO, AUTH PLAIN, envelope uses bare addresses, body is base64 and decodes to the text', async () => {
    const f = await fake(); try {
      await new SmtpTransport(cfg(f.port, { user: 'u', pass: 'p' })).send(msg);
      assert.ok(f.seen.cmds[0]!.startsWith('EHLO reelqueue.test'));
      assert.ok(f.seen.cmds.includes(`AUTH PLAIN ${Buffer.from('\0u\0p').toString('base64')}`));
      assert.ok(f.seen.cmds.includes('MAIL FROM:<no-reply@reelqueue.example>'));
      assert.ok(f.seen.cmds.includes('RCPT TO:<user@example.com>'));
      const [head, body] = f.seen.data.split('\r\n\r\n');
      assert.match(head!, /^From: ReelQueue <no-reply@reelqueue.example>/m);
      assert.equal(Buffer.from(body!.replace(/\r\n/g, ''), 'base64').toString(), msg.text);
    } finally { f.close(); }
  });
  it('maps 4xx to TRANSIENT and 5xx to PERMANENT; error text never contains credentials', async () => {
    const f1 = await fake({ rcpt: '451 try later' }); const f2 = await fake({ rcpt: '550 no such user' }); const f3 = await fake({ auth: ['bad'] });
    try {
      await assert.rejects(new SmtpTransport(cfg(f1.port)).send(msg), (e) => e instanceof MailError && e.kind === 'TRANSIENT' && e.smtpCode === 451);
      await assert.rejects(new SmtpTransport(cfg(f2.port)).send(msg), (e) => e instanceof MailError && e.kind === 'PERMANENT');
      await assert.rejects(new SmtpTransport(cfg(f3.port, { user: 'u', pass: 'hunter2-secret' })).send(msg), (e) => e instanceof MailError && e.kind === 'PERMANENT' && !/hunter2|secret/.test(e.message));
    } finally { f1.close(); f2.close(); f3.close(); }
  });
  it('rejects header injection and invalid addresses BEFORE connecting', async () => {
    const t = new SmtpTransport(cfg(1));
    await assert.rejects(t.send({ ...msg, subject: 'x\r\nBcc: evil@example.com' }), /control character/);
    await assert.rejects(t.send({ ...msg, to: 'a@example.com\r\nRCPT TO:<b@example.com>' }), /Invalid e-mail/);
    await assert.rejects(t.send({ ...msg, to: 'not-an-address' }), /Invalid e-mail/);
  });
  it('refuses credentials over an unencrypted connection to a non-loopback host, and refuses STARTTLS downgrade', async () => {
    assert.throws(() => new SmtpTransport({ host: 'smtp.example.com', port: 25, security: 'none', user: 'u', pass: 'p', helo: 'h', timeoutMs: 1000 }), /unencrypted/);
    const f = await fake({ ehlo: ['SIZE 1000'] }); try {
      await assert.rejects(new SmtpTransport(cfg(f.port, { security: 'starttls' })).send(msg), /does not offer STARTTLS/);
      assert.ok(!f.seen.cmds.some((c) => /^MAIL FROM/.test(c)), 'nothing was sent in clear text');
    } finally { f.close(); }
  });
  it('times out on a silent server and on a refused connection (TRANSIENT)', async () => {
    const f = await fake({ hang: true }); try {
      await assert.rejects(new SmtpTransport(cfg(f.port, { timeoutMs: 200 })).send(msg), (e) => e instanceof MailError && e.kind === 'TRANSIENT');
    } finally { f.close(); }
    await assert.rejects(new SmtpTransport(cfg(1, { timeoutMs: 500 })).send(msg), (e) => e instanceof MailError && e.kind === 'TRANSIENT');
  });
  it('helpers: dot-stuffing, RFC2047 subject, mailbox validation', () => {
    assert.equal(dotStuff('a\r\n.b\r\n..c'), 'a\r\n..b\r\n...c');
    assert.match(buildMessage({ ...msg, subject: 'Vérification' }, new Date(0), 'x.example'), /Subject: =\?UTF-8\?B\?/);
    assert.ok(isMailbox('a.b+c@example.com')); assert.ok(!isMailbox('a b@example.com')); assert.ok(!isMailbox('a@b@c'));
  });
});
