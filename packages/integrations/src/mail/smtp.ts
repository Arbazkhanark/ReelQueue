import { connect as netConnect, type Socket } from 'node:net';
import { connect as tlsConnect, type TLSSocket, type ConnectionOptions } from 'node:tls';
import { randomUUID } from 'node:crypto';

export interface MailMessage { from: string; to: string; subject: string; text: string; /** Optional HTML alternative (used by the Nodemailer transport; the built-in SmtpTransport sends text only). */ html?: string }
export interface MailTransport { send(m: MailMessage): Promise<void> }

export type SmtpSecurity = 'tls' | 'starttls' | 'none';
export interface SmtpConfig {
  host: string; port: number;
  /** 'tls' = implicit TLS (usually 465), 'starttls' = upgrade on 587, 'none' = plaintext (loopback/dev only). */
  security: SmtpSecurity;
  user?: string; pass?: string;
  /** Name announced in EHLO. */
  helo: string;
  timeoutMs: number;
  /** Extra TLS options (tests only: a private CA). Certificate verification stays ON by default. */
  tls?: ConnectionOptions;
}

/** `kind`: TRANSIENT (4xx / network: retry later) or PERMANENT (5xx / invalid input / config: do not retry). Never contains credentials. */
export class MailError extends Error {
  constructor(readonly kind: 'TRANSIENT' | 'PERMANENT', message: string, readonly smtpCode?: number) { super(message); this.name = 'MailError'; }
}

const ADDRESS = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,250}[A-Za-z0-9])?$/;
export const isMailbox = (s: string): boolean => ADDRESS.test(s) && s.length <= 254;
const isLoopback = (h: string) => h === 'localhost' || h === '127.0.0.1' || h === '::1';

/** Extracts the bare address from `Name <a@b>` or `a@b` (rejecting anything with control characters). */
function bare(addr: string): string {
  if (/[\r\n\0]/.test(addr)) throw new MailError('PERMANENT', 'Invalid e-mail address');
  const m = /<([^<>\r\n]+)>\s*$/.exec(addr);
  const a = (m ? m[1]! : addr).trim();
  if (!isMailbox(a)) throw new MailError('PERMANENT', 'Invalid e-mail address');
  return a;
}
const clean = (s: string) => { if (/[\r\n\0]/.test(s)) throw new MailError('PERMANENT', 'Illegal control character in a mail header'); return s; };
const encodeHeader = (s: string) => (/^[\x20-\x7e]*$/.test(clean(s)) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const wrap76 = (b64: string) => b64.replace(/(.{76})/g, '$1\r\n');

/** Builds the RFC 5322 message. Body is base64 (no line-length or encoding surprises); lines are CRLF. Dot-stuffing happens at DATA time. */
export function buildMessage(m: MailMessage, now: Date, domain: string): string {
  const fromDisplay = clean(m.from);
  bare(m.from); bare(m.to);
  const headers = [
    `From: ${fromDisplay}`, `To: ${clean(m.to)}`, `Subject: ${encodeHeader(m.subject)}`, `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${randomUUID()}@${domain}>`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', 'Auto-Submitted: auto-generated',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${wrap76(Buffer.from(m.text, 'utf8').toString('base64'))}\r\n`;
}
export const dotStuff = (body: string): string => body.replace(/^\./gm, '..');

class Session {
  private buf = ''; private waiter: (() => void) | null = null; private err: Error | null = null;
  constructor(public sock: Socket | TLSSocket, private readonly timeoutMs: number) { this.attach(sock); }
  private attach(s: Socket) {
    s.setEncoding('utf8');
    s.on('data', (d: string) => { this.buf += d; this.waiter?.(); });
    s.on('error', (e) => { this.err = e; this.waiter?.(); });
    s.on('close', () => { this.err ??= new Error('closed'); this.waiter?.(); });
  }
  swap(s: Socket | TLSSocket) { this.sock = s; this.buf = ''; this.err = null; this.attach(s); }
  write(line: string) { this.sock.write(line); }
  /** Reads one complete (possibly multi-line) reply. */
  async reply(): Promise<{ code: number; lines: string[] }> {
    const deadline = Date.now() + this.timeoutMs;
    for (;;) {
      const lines = this.buf.split('\r\n');
      const complete: string[] = [];
      for (let i = 0; i < lines.length - 1; i++) {
        complete.push(lines[i]!);
        if (/^\d{3} /.test(lines[i]!) || /^\d{3}$/.test(lines[i]!)) { this.buf = lines.slice(i + 1).join('\r\n'); return { code: Number(lines[i]!.slice(0, 3)), lines: complete }; }
      }
      if (this.err) throw new MailError('TRANSIENT', 'SMTP connection lost');
      if (this.buf.length > 64 * 1024) throw new MailError('TRANSIENT', 'SMTP reply too large');
      const left = deadline - Date.now();
      if (left <= 0) throw new MailError('TRANSIENT', 'SMTP timeout');
      await new Promise<void>((res) => { const t = setTimeout(res, left); this.waiter = () => { clearTimeout(t); res(); }; });
    }
  }
}

export class SmtpTransport implements MailTransport {
  // constructor(private readonly cfg: SmtpConfig, private readonly now: () => Date = () => new Date()) {
  //   if ((cfg.user || cfg.pass) && cfg.security === 'none' && !isLoopback(cfg.host)) throw new MailError('PERMANENT', 'Refusing to send SMTP credentials over an unencrypted connection');
  // }
    private readonly cfg: SmtpConfig;
  private readonly now: () => Date;
  constructor(cfg: SmtpConfig, now: () => Date = () => new Date()) {
    this.cfg = cfg;
    this.now = now;
  }

  /** TEMPORARY: for diagnostics only. Remove along with the debug log. */
  debugConfig(): Pick<SmtpConfig, 'host' | 'port' | 'security' | 'user' | 'helo' | 'timeoutMs'> {
    return {
      host: this.cfg.host,
      port: this.cfg.port,
      security: this.cfg.security,
      user: this.cfg.user,
      helo: this.cfg.helo,
      timeoutMs: this.cfg.timeoutMs,
    };
  }

  async send(m: MailMessage): Promise<void> {
    const from = bare(m.from), to = bare(m.to);
    const body = buildMessage(m, this.now(), from.split('@')[1]!);
    const c = this.cfg;
    const sock = await new Promise<Socket | TLSSocket>((resolve, reject) => {
      const t = setTimeout(() => { s.destroy(); reject(new MailError('TRANSIENT', 'SMTP connect timeout')); }, c.timeoutMs);
      const ok = () => { clearTimeout(t); resolve(s); };
      const s: Socket | TLSSocket = c.security === 'tls' ? tlsConnect({ host: c.host, port: c.port, servername: c.host, ...c.tls }, ok) : netConnect({ host: c.host, port: c.port }, ok);
      s.once('error', () => { clearTimeout(t); reject(new MailError('TRANSIENT', 'SMTP connect failed')); });
    });
    const ses = new Session(sock, c.timeoutMs);
    const expect = async (ok: number[], what: string) => {
      const r = await ses.reply();
      if (!ok.includes(r.code)) throw new MailError(r.code >= 500 ? 'PERMANENT' : 'TRANSIENT', `SMTP ${what} rejected (${r.code})`, r.code);
      return r;
    };
    const cmd = async (line: string, ok: number[], what: string) => { ses.write(line + '\r\n'); return expect(ok, what); };
    try {
      await expect([220], 'greeting');
      let ehlo = await cmd(`EHLO ${c.helo}`, [250], 'EHLO');
      if (c.security === 'starttls') {
        if (!ehlo.lines.some((l) => /STARTTLS/i.test(l))) throw new MailError('PERMANENT', 'SMTP server does not offer STARTTLS'); // never silently downgrade
        await cmd('STARTTLS', [220], 'STARTTLS');
        const up = await new Promise<TLSSocket>((res, rej) => { const t = tlsConnect({ socket: ses.sock as Socket, servername: c.host, ...c.tls }, () => res(t)); t.once('error', () => rej(new MailError('TRANSIENT', 'SMTP TLS upgrade failed'))); });
        ses.swap(up);
        ehlo = await cmd(`EHLO ${c.helo}`, [250], 'EHLO');
      }
      if (c.user !== undefined) {
        const mechs = ehlo.lines.find((l) => /^250[ -]AUTH /i.test(l))?.toUpperCase() ?? '';
        if (mechs.includes('PLAIN')) await cmd(`AUTH PLAIN ${Buffer.from(`\0${c.user}\0${c.pass ?? ''}`).toString('base64')}`, [235], 'AUTH');
        else if (mechs.includes('LOGIN')) {
          await cmd('AUTH LOGIN', [334], 'AUTH'); await cmd(Buffer.from(c.user).toString('base64'), [334], 'AUTH');
          await cmd(Buffer.from(c.pass ?? '').toString('base64'), [235], 'AUTH');
        } else throw new MailError('PERMANENT', 'SMTP server offers no supported AUTH mechanism');
      }
      await cmd(`MAIL FROM:<${from}>`, [250], 'MAIL FROM');
      await cmd(`RCPT TO:<${to}>`, [250, 251], 'RCPT TO');
      await cmd('DATA', [354], 'DATA');
      ses.write(`${dotStuff(body)}.\r\n`);
      await expect([250], 'message');
      try { await cmd('QUIT', [221], 'QUIT'); } catch { /* the message was already accepted */ }
    } finally { ses.sock.destroy(); }
  }
}
