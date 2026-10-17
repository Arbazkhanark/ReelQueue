import { createHmac, timingSafeEqual } from 'node:crypto';

/** Minimal HS256 JWT. `alg` is fixed server-side: a token's own header can never choose the algorithm (no "none"/RS confusion). */
export interface JwtClaims { sub: string; iat: number; exp: number; iss?: string; aud?: string; [k: string]: unknown }
export type JwtError = 'MALFORMED' | 'BAD_SIGNATURE' | 'EXPIRED' | 'NOT_YET_VALID' | 'BAD_ISSUER' | 'BAD_AUDIENCE';
export type JwtResult = { ok: true; claims: JwtClaims } | { ok: false; error: JwtError };

const b64u = (b: Buffer | string): string => Buffer.from(b).toString('base64url');
const HEADER = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
const sign = (data: string, secret: string): Buffer => createHmac('sha256', secret).update(data).digest();

export function signJwt(claims: JwtClaims, secret: string): string {
  if (secret.length < 32) throw new Error('JWT secret must be at least 32 characters');
  const body = `${HEADER}.${b64u(JSON.stringify(claims))}`;
  return `${body}.${b64u(sign(body, secret))}`;
}

export function verifyJwt(token: string, secret: string, now: Date, opts: { issuer?: string; audience?: string; leewaySeconds?: number } = {}): JwtResult {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== HEADER) return { ok: false, error: 'MALFORMED' };
  const given = Buffer.from(parts[2]!, 'base64url');
  const expected = sign(`${parts[0]}.${parts[1]}`, secret);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, error: 'BAD_SIGNATURE' };
  let claims: JwtClaims;
  try { claims = JSON.parse(Buffer.from(parts[1]!, 'base64url').toString('utf8')) as JwtClaims; } catch { return { ok: false, error: 'MALFORMED' }; }
  if (typeof claims.sub !== 'string' || typeof claims.exp !== 'number' || typeof claims.iat !== 'number') return { ok: false, error: 'MALFORMED' };
  const t = Math.floor(now.getTime() / 1000);
  const leeway = opts.leewaySeconds ?? 0;
  if (t >= claims.exp + leeway) return { ok: false, error: 'EXPIRED' };
  if (claims.iat > t + leeway) return { ok: false, error: 'NOT_YET_VALID' };
  if (opts.issuer !== undefined && claims.iss !== opts.issuer) return { ok: false, error: 'BAD_ISSUER' };
  if (opts.audience !== undefined && claims.aud !== opts.audience) return { ok: false, error: 'BAD_AUDIENCE' };
  return { ok: true, claims };
}
