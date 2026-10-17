import type { Mailer } from '@reelqueue/services';

/**
 * Development mailer: writes the message (including the one-time link token) to the log. loadConfig REFUSES this transport
 * in production, so tokens can never reach production logs. A real transport (SMTP/provider API) is NOT implemented yet.
 */
export class LogMailer implements Mailer {
  constructor(private readonly log: (o: Record<string, unknown>, m: string) => void, private readonly appUrl: string) {}
  async sendVerificationEmail(to: string, rawToken: string): Promise<void> { this.log({ to, link: `${this.appUrl}/verify-email?token=${encodeURIComponent(rawToken)}` }, 'DEV MAIL verification'); }
  async sendPasswordResetEmail(to: string, rawToken: string): Promise<void> { this.log({ to, link: `${this.appUrl}/reset-password?token=${encodeURIComponent(rawToken)}` }, 'DEV MAIL password reset'); }
}
