import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Opaque single-purpose tokens (email verification, password reset, refresh
 * tokens). Only the SHA-256 hash is stored; the raw value is shown/sent once.
 * 256 bits of entropy make a fast hash appropriate (unlike passwords).
 */
export function generateOpaqueToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

export function tokenMatchesHash(raw: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(raw), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export type OneTimeTokenCheck = 'VALID' | 'EXPIRED' | 'ALREADY_USED' | 'MISMATCH';

/** Single-use + expiry rules shared by email-verification and password-reset tokens. */
export function checkOneTimeToken(args: {
  raw: string;
  storedHash: string;
  expiresAt: Date;
  usedAt: Date | null;
  now: Date;
}): OneTimeTokenCheck {
  if (!tokenMatchesHash(args.raw, args.storedHash)) return 'MISMATCH';
  if (args.usedAt) return 'ALREADY_USED';
  if (args.now.getTime() >= args.expiresAt.getTime()) return 'EXPIRED';
  return 'VALID';
}
