import { generateOpaqueToken, hashToken, checkPassword, signJwt, verifyJwt, type Clock, type PasswordHasher, type PasswordIssue } from '@reelqueue/core';
import { AuthStore, type UserRow } from '@reelqueue/db';
import { AppError } from '@reelqueue/shared';

export interface Mailer {
  sendVerificationEmail(to: string, rawToken: string): Promise<void>;
  sendPasswordResetEmail(to: string, rawToken: string): Promise<void>;
}

export interface AuthConfig {
  jwtSecret: string;
  issuer: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  refreshGraceMs: number;
  lockMaxFailures: number;
  lockMs: number;
  verifyTtlSeconds: number;
  resetTtlSeconds: number;
  /** When true, login requires a verified email. */
  requireVerifiedEmail: boolean;
}

export const DEFAULT_AUTH_CONFIG: Omit<AuthConfig, 'jwtSecret'> = {
  issuer: 'reelqueue', accessTtlSeconds: 15 * 60, refreshTtlSeconds: 30 * 24 * 3600, refreshGraceMs: 10_000,
  lockMaxFailures: 5, lockMs: 15 * 60_000, verifyTtlSeconds: 24 * 3600, resetTtlSeconds: 3600, requireVerifiedEmail: true,
};

export interface SessionTokens { accessToken: string; refreshToken: string; accessExpiresAt: Date; refreshExpiresAt: Date; user: UserRow }
export interface Principal { userId: string; role: 'USER' | 'ADMIN' }
export interface ClientContext { userAgent?: string | null; ipHash?: string | null }

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}\.[^\s@]{2,}$/;
const ISSUE_TEXT: Record<PasswordIssue, string> = {
  TOO_SHORT: 'Password must be at least 12 characters.', TOO_LONG: 'Password must be at most 128 characters.',
  TOO_COMMON: 'That password is too common.', CONTAINS_EMAIL: 'Password must not contain your email name.', LOW_VARIETY: 'Password is too repetitive.',
};

/**
 * Authentication use-cases. Enumeration-safe: signup of a taken email, forgot-password for an unknown email and
 * login with an unknown email are indistinguishable from the normal path (same result, same work).
 */
export class AuthService {
  private dummyHash: Promise<string> | null = null;

  constructor(
    private readonly store: AuthStore, private readonly hasher: PasswordHasher, private readonly mailer: Mailer,
    private readonly clock: Clock, private readonly cfg: AuthConfig,
  ) {}

  private normEmail(email: string): string {
    const e = email.trim().toLowerCase();
    if (!EMAIL.test(e)) throw new AppError('VALIDATION_FAILED', 'Invalid input.', [{ field: 'email', message: 'Enter a valid email address.' }]);
    return e;
  }
  private assertPassword(pw: string, email?: string): void {
    const issues = checkPassword(pw, email ? { email } : {});
    if (issues.length) throw new AppError('VALIDATION_FAILED', 'Invalid input.', issues.map((i) => ({ field: 'password', message: ISSUE_TEXT[i] })));
  }
  private mint(user: UserRow, now: Date) {
    const t = Math.floor(now.getTime() / 1000);
    const accessToken = signJwt({ sub: user.id, role: user.role, iat: t, exp: t + this.cfg.accessTtlSeconds, iss: this.cfg.issuer }, this.cfg.jwtSecret);
    const refreshToken = generateOpaqueToken();
    return { accessToken, refreshToken, accessExpiresAt: new Date(now.getTime() + this.cfg.accessTtlSeconds * 1000), refreshExpiresAt: new Date(now.getTime() + this.cfg.refreshTtlSeconds * 1000) };
  }

  async signup(emailIn: string, password: string): Promise<void> {
    // Report email and password problems together so a form can show them all at once.
    const details: { field: string; message: string }[] = [];
    const email = emailIn.trim().toLowerCase();
    if (!EMAIL.test(email)) details.push({ field: 'email', message: 'Enter a valid email address.' });
    for (const i of checkPassword(password, EMAIL.test(email) ? { email } : {})) details.push({ field: 'password', message: ISSUE_TEXT[i] });
    if (details.length) throw new AppError('VALIDATION_FAILED', 'Invalid input.', details);
    const hash = await this.hasher.hash(password);
    const created = await this.store.createUser(email, hash);
    if (!created.ok) return; // taken: silent, indistinguishable (the owner is not emailed here; add a "someone tried" notice later)
    await this.sendVerification(created.user);
  }

  private async sendVerification(user: UserRow): Promise<void> {
    const raw = generateOpaqueToken();
    const now = this.clock.now();
    await this.store.createAuthToken({ userId: user.id, purpose: 'EMAIL_VERIFICATION', tokenHash: hashToken(raw), expiresAt: new Date(now.getTime() + this.cfg.verifyTtlSeconds * 1000), now });
    await this.mailer.sendVerificationEmail(user.email, raw);
  }

  async verifyEmail(rawToken: string): Promise<void> {
    const r = await this.store.consumeAuthToken(hashToken(rawToken), 'EMAIL_VERIFICATION', this.clock.now());
    if (!r) throw new AppError('TOKEN_INVALID', 'This link is invalid or has expired.');
    await this.store.markEmailVerified(r.userId, this.clock.now());
  }

  async login(emailIn: string, password: string, ctx: ClientContext = {}): Promise<SessionTokens> {
    const email = emailIn.trim().toLowerCase();
    const now = this.clock.now();
    const user = EMAIL.test(email) ? await this.store.findByEmail(email) : null;
    if (!user) {
      // Equalise timing with the real path so unknown emails are not distinguishable by latency.
      this.dummyHash ??= this.hasher.hash('dummy-password-for-timing');
      await this.hasher.verify(password, await this.dummyHash);
      throw new AppError('INVALID_CREDENTIALS', 'Incorrect email or password.');
    }
    if (user.lockedUntil && user.lockedUntil.getTime() > now.getTime()) {
      throw new AppError('ACCOUNT_LOCKED', 'Too many failed attempts. Try again later.');
    }
    if (!(await this.hasher.verify(password, user.passwordHash))) {
      await this.store.recordLoginFailure(user.id, now, this.cfg.lockMaxFailures, this.cfg.lockMs);
      throw new AppError('INVALID_CREDENTIALS', 'Incorrect email or password.');
    }
    if (user.status === 'SUSPENDED') throw new AppError('ACCOUNT_SUSPENDED', 'This account is suspended.');
    if (user.status !== 'ACTIVE' && user.status !== 'PENDING_DELETION') throw new AppError('INVALID_CREDENTIALS', 'Incorrect email or password.');
    if (this.cfg.requireVerifiedEmail && !user.emailVerifiedAt) throw new AppError('EMAIL_NOT_VERIFIED', 'Verify your email address to sign in.');
    if (this.hasher.needsRehash(user.passwordHash)) await this.store.setPasswordHash(user.id, await this.hasher.hash(password));
    await this.store.recordLoginSuccess(user.id, now);
    const t = this.mint(user, now);
    await this.store.issueRefreshToken({ userId: user.id, tokenHash: hashToken(t.refreshToken), expiresAt: t.refreshExpiresAt, ...ctx });
    return { ...t, user };
  }

  async refresh(rawRefresh: string, ctx: ClientContext = {}): Promise<SessionTokens> {
    const now = this.clock.now();
    const fresh = this.mint({ id: '', role: 'USER' } as UserRow, now); // only the opaque token + expiry are used below
    const r = await this.store.rotateRefreshToken({ oldHash: hashToken(rawRefresh), newHash: hashToken(fresh.refreshToken), newExpiresAt: fresh.refreshExpiresAt, now, graceMs: this.cfg.refreshGraceMs, ...ctx });
    if (r.status !== 'OK') throw new AppError('UNAUTHENTICATED', 'Session expired. Sign in again.');
    const user = await this.store.findById(r.userId);
    if (!user || (user.status !== 'ACTIVE' && user.status !== 'PENDING_DELETION')) {
      await this.store.revokeAllForUser(r.userId, now);
      throw new AppError('UNAUTHENTICATED', 'Session expired. Sign in again.');
    }
    const t = this.mint(user, now);
    return { ...t, refreshToken: fresh.refreshToken, refreshExpiresAt: fresh.refreshExpiresAt, user };
  }

  async logout(rawRefresh: string | undefined): Promise<void> {
    if (rawRefresh) await this.store.revokeFamilyOf(hashToken(rawRefresh), this.clock.now());
  }

  /** Verifies the access token AND that the account is still active (suspension/deletion takes effect immediately). */
  async authenticate(accessToken: string | undefined): Promise<Principal> {
    if (!accessToken) throw new AppError('UNAUTHENTICATED', 'Sign in required.');
    const v = verifyJwt(accessToken, this.cfg.jwtSecret, this.clock.now(), { issuer: this.cfg.issuer });
    if (!v.ok) throw new AppError('UNAUTHENTICATED', 'Sign in required.');
    const user = await this.store.findById(v.claims.sub);
    if (!user || (user.status !== 'ACTIVE' && user.status !== 'PENDING_DELETION')) throw new AppError('UNAUTHENTICATED', 'Sign in required.');
    return { userId: user.id, role: user.role };
  }

  async requestPasswordReset(emailIn: string): Promise<void> {
    const email = emailIn.trim().toLowerCase();
    const user = EMAIL.test(email) ? await this.store.findByEmail(email) : null;
    if (!user || user.status !== 'ACTIVE') return; // identical outward behaviour
    const raw = generateOpaqueToken();
    const now = this.clock.now();
    await this.store.createAuthToken({ userId: user.id, purpose: 'PASSWORD_RESET', tokenHash: hashToken(raw), expiresAt: new Date(now.getTime() + this.cfg.resetTtlSeconds * 1000), now });
    await this.mailer.sendPasswordResetEmail(user.email, raw);
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<void> {
    this.assertPassword(newPassword);
    const hash = await this.hasher.hash(newPassword);
    const r = await this.store.resetPassword({ tokenHash: hashToken(rawToken), newPasswordHash: hash, now: this.clock.now() });
    if (!r) throw new AppError('TOKEN_INVALID', 'This link is invalid or has expired.');
  }

  async changePassword(userId: string, current: string, next: string): Promise<void> {
    const user = await this.store.findById(userId);
    if (!user || !(await this.hasher.verify(current, user.passwordHash))) throw new AppError('INVALID_CREDENTIALS', 'Current password is incorrect.');
    this.assertPassword(next, user.email);
    await this.store.setPasswordHash(userId, await this.hasher.hash(next));
    await this.store.revokeAllForUser(userId, this.clock.now());
  }

  async getUser(userId: string): Promise<UserRow> {
    const u = await this.store.findById(userId);
    if (!u) throw new AppError('UNAUTHENTICATED', 'Sign in required.');
    return u;
  }

  async verifyPassword(userId: string, password: string): Promise<void> {
    const u = await this.getUser(userId);
    if (!(await this.hasher.verify(password, u.passwordHash))) throw new AppError('INVALID_CREDENTIALS', 'Password is incorrect.');
  }

  /** Grace-period deletion: live cycles are stopped by the caller first; sessions are revoked, sign-in stays possible to cancel. */
  async requestDeletion(userId: string): Promise<UserRow> {
    await this.store.requestDeletion(userId, this.clock.now());
    await this.store.revokeAllForUser(userId, this.clock.now());
    return this.getUser(userId);
  }
  async cancelDeletion(userId: string): Promise<UserRow> {
    await this.store.cancelDeletion(userId);
    return this.getUser(userId);
  }
}
