import { MailError, type MailMessage, type MailTransport } from '@reelqueue/integrations';

/** The slice of Nodemailer we use, typed structurally so this package needs no `nodemailer` dependency (apps/api injects the real one). */
export interface NodemailerLike {
  createTransport(opts: Record<string, unknown>): { sendMail(m: Record<string, unknown>): Promise<unknown>; close?(): void };
}
export interface NodemailerSettings { host: string; port: number; security: 'tls' | 'starttls' | 'none'; user?: string; pass?: string; timeoutMs: number }

/** MailTransport over Nodemailer. `security: 'tls'` = implicit TLS (port 465, EMAIL_SECURE=true). Errors are sanitised: no credentials, no message body. */
export class NodemailerTransport implements MailTransport {
  private readonly t: ReturnType<NodemailerLike['createTransport']>;
  constructor(nm: NodemailerLike, s: NodemailerSettings) {
    this.t = nm.createTransport({
      host: s.host, port: s.port, secure: s.security === 'tls', requireTLS: s.security === 'starttls',
      ...(s.user ? { auth: { user: s.user, pass: s.pass ?? '' } } : {}),
      connectionTimeout: s.timeoutMs, greetingTimeout: s.timeoutMs, socketTimeout: s.timeoutMs,
    });
  }
  async send(m: MailMessage & { html?: string }): Promise<void> {
    try {
      await this.t.sendMail({ from: m.from, to: m.to, subject: m.subject, text: m.text, ...(m.html ? { html: m.html } : {}), headers: { 'Auto-Submitted': 'auto-generated' } });
    } catch (e) {
      const err = e as { code?: unknown; responseCode?: unknown };
      const rc = typeof err.responseCode === 'number' ? err.responseCode : undefined;
      const code = typeof err.code === 'string' ? err.code : 'UNKNOWN';
      if (code === 'EAUTH') throw new MailError('PERMANENT', 'SMTP authentication failed (check EMAIL_USER / EMAIL_PASS)', rc);
      if (rc !== undefined && rc >= 500) throw new MailError('PERMANENT', `SMTP rejected the message (${rc})`, rc);
      throw new MailError('TRANSIENT', `SMTP send failed (${code})`, rc);
    }
  }
  close(): void { this.t.close?.(); }
}
