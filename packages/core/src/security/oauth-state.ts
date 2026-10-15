import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * OAuth `state` parameter (CSRF protection).
 *
 * The state is `<base64url(payload)>.<base64url(HMAC-SHA256)>` and binds:
 *   - the user who started the flow,
 *   - a random nonce that the API also stores server-side/in an httpOnly cookie
 *     and compares on callback (so a leaked state alone is not enough),
 *   - the issue time (short validity window).
 */
export interface OAuthStatePayload {
  userId: string;
  nonce: string;
  issuedAt: number; // epoch ms
}

export type OAuthStateError = 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' | 'USER_MISMATCH' | 'NONCE_MISMATCH';

export type OAuthStateResult =
  | { ok: true; payload: OAuthStatePayload }
  | { ok: false; error: OAuthStateError };

export function generateNonce(): string {
  return randomBytes(24).toString('base64url');
}

function sign(body: string, secret: string): Buffer {
  return createHmac('sha256', secret).update(body).digest();
}

export function createOAuthState(payload: OAuthStatePayload, secret: string): string {
  if (secret.length < 32) throw new Error('OAuth state secret must be at least 32 characters');
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${sign(body, secret).toString('base64url')}`;
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function verifyOAuthState(
  token: string,
  secret: string,
  expected: { userId: string; nonce: string; now: Date; maxAgeMs: number },
): OAuthStateResult {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1 || token.indexOf('.', dot + 1) !== -1) {
    return { ok: false, error: 'MALFORMED' };
  }
  const body = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1), 'base64url');
  const good = sign(body, secret);
  if (sig.length !== good.length || !timingSafeEqual(sig, good)) {
    return { ok: false, error: 'BAD_SIGNATURE' };
  }

  let payload: OAuthStatePayload;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as OAuthStatePayload).userId !== 'string' ||
      typeof (parsed as OAuthStatePayload).nonce !== 'string' ||
      typeof (parsed as OAuthStatePayload).issuedAt !== 'number'
    ) {
      return { ok: false, error: 'MALFORMED' };
    }
    payload = parsed as OAuthStatePayload;
  } catch {
    return { ok: false, error: 'MALFORMED' };
  }

  const age = expected.now.getTime() - payload.issuedAt;
  if (age < 0 || age > expected.maxAgeMs) return { ok: false, error: 'EXPIRED' };
  if (!safeEqual(payload.userId, expected.userId)) return { ok: false, error: 'USER_MISMATCH' };
  if (!safeEqual(payload.nonce, expected.nonce)) return { ok: false, error: 'NONCE_MISMATCH' };
  return { ok: true, payload };
}
