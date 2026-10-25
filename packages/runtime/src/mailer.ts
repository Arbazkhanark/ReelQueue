// packages/runtime/src/mailer.ts
import type { Mailer } from '@reelqueue/services';
import { MailError, type MailTransport } from '@reelqueue/integrations';
import { passwordResetMail, verificationMail, type RenderedMail } from './mail-templates';

/**
 * Development mailer: writes the message (including the one-time link token) to the log. loadConfig REFUSES this transport
 * in production, so tokens can never reach production logs.
 */
export class LogMailer implements Mailer {
  constructor(private readonly log: (o: Record<string, unknown>, m: string) => void, private readonly appUrl: string) {}
  async sendVerificationEmail(to: string, rawToken: string): Promise<void> { this.log({ to, link: `${this.appUrl}/verify-email?token=${encodeURIComponent(rawToken)}` }, 'DEV MAIL verification'); }
  async sendPasswordResetEmail(to: string, rawToken: string): Promise<void> { this.log({ to, link: `${this.appUrl}/reset-password?token=${encodeURIComponent(rawToken)}` }, 'DEV MAIL password reset'); }
}

/**
 * Production mailer over a MailTransport (SMTP).
 *  - NEVER throws and never waits for the network: AuthService awaits the mailer for new accounts on signup and for existing
 *    ACTIVE accounts on password reset only, so a slow/failed send must not make the response differ (account-enumeration oracle).
 *    Delivery therefore happens in the background; failures are logged WITHOUT the recipient, the link or any token.
 *  - NOT durable: there is no outbox. A process crash or a provider outage between "token created" and "mail accepted" loses
 *    the mail; the user can request another. (Documented limitation; an outbox table is the next step if this matters.)
 *  - At most `maxInFlight` sends run at once; beyond that the mail is dropped and logged (back-pressure instead of unbounded memory).
 */
export class SmtpMailer implements Mailer {
  private inFlight = 0;
  private pending = new Set<Promise<void>>();
  constructor(
    private readonly transport: MailTransport, private readonly from: string, private readonly appUrl: string,
    private readonly log: (o: Record<string, unknown>, m: string) => void, private readonly maxInFlight = 50,
  ) {}

  sendVerificationEmail(to: string, rawToken: string): Promise<void> {
    return this.enqueue('verification', to, verificationMail(`${this.appUrl}/verify-email?token=${encodeURIComponent(rawToken)}`));
  }
  sendPasswordResetEmail(to: string, rawToken: string): Promise<void> {
    return this.enqueue('password-reset', to, passwordResetMail(`${this.appUrl}/reset-password?token=${encodeURIComponent(rawToken)}`));
  }
  private enqueue(kind: string, to: string, mail: RenderedMail): Promise<void> {
    if (this.inFlight >= this.maxInFlight) { this.log({ kind, reason: 'BACKPRESSURE' }, 'mail dropped'); return Promise.resolve(); }
    this.inFlight++;
    // .catch((e: unknown) => { this.log(e instanceof MailError ? { kind, failure: e.kind, smtpCode: e.smtpCode } : { kind, failure: 'UNKNOWN' }, 'mail send failed'); })
    const p = this.transport.send({ from: this.from, to, subject: mail.subject, text: mail.text, html: mail.html })
      .catch((e: unknown) => {
        if (e instanceof MailError) {
          this.log(
            {
              kind,
              failure: e.kind,
              smtpCode: e.smtpCode ?? null,
              errorName: e.name,
              errorMessage: e.message.slice(0, 500),
            },
            'mail send failed',
          );
          return;
        }

        // Do not log arbitrary objects or credentials.
        const err = e instanceof Error ? e : null;
        this.log(
          {
            kind,
            failure: 'UNKNOWN',
            errorName: err?.name ?? 'UnknownError',
            errorMessage: (err?.message ?? 'Non-Error thrown').slice(0, 500),
          },
          'mail send failed',
        );
      })
      .finally(() => { this.inFlight--; this.pending.delete(p); });
    this.pending.add(p);
    return Promise.resolve();
  }
  /** For graceful shutdown and tests: resolves when every accepted send has finished (never rejects). */
  async drain(): Promise<void> { await Promise.all([...this.pending]); }
}
