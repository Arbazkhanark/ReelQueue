import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing port. Default implementation: scrypt (memory-hard KDF in Node's stdlib). The stored format is
 * self-describing, so parameters can be raised later and `needsRehash` tells the login flow to upgrade on success.
 * Swapping to Argon2id later = another implementation of this port + a new prefix; old hashes keep verifying.
 */
export interface PasswordHasher {
  hash(password: string): Promise<string>;
  verify(password: string, stored: string): Promise<boolean>;
  needsRehash(stored: string): boolean;
}

export interface ScryptParams { N: number; r: number; p: number; keyLen: number; saltLen: number }
/** OWASP-aligned minimum for scrypt: N=2^17,r=8,p=1 is the strongest listed; 2^15 trades ~32 MiB for latency. Tune on real hardware. */
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 15, r: 8, p: 1, keyLen: 32, saltLen: 16 };

const derive = (pw: string, salt: Buffer, p: ScryptParams): Promise<Buffer> =>
  new Promise((resolve, reject) =>
    scryptCb(pw.normalize('NFKC'), salt, p.keyLen, { N: p.N, r: p.r, p: p.p, maxmem: 256 * p.N * p.r + 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))),
  );

export class ScryptPasswordHasher implements PasswordHasher {
  constructor(private readonly params: ScryptParams = DEFAULT_SCRYPT) {}

  async hash(password: string): Promise<string> {
    const p = this.params;
    const salt = randomBytes(p.saltLen);
    const key = await derive(password, salt, p);
    return `scrypt$${p.N}$${p.r}$${p.p}$${salt.toString('base64')}$${key.toString('base64')}`;
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parsed = parse(stored);
    if (!parsed) return false;
    const key = await derive(password, parsed.salt, { ...parsed.params, keyLen: parsed.key.length, saltLen: parsed.salt.length });
    return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
  }

  needsRehash(stored: string): boolean {
    const parsed = parse(stored);
    if (!parsed) return true;
    const c = parsed.params;
    return c.N < this.params.N || c.r < this.params.r || c.p < this.params.p || parsed.key.length < this.params.keyLen;
  }
}

function parse(stored: string): { params: ScryptParams; salt: Buffer; key: Buffer } | null {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [N, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  // Bound attacker-influenced cost parameters (a tampered DB row must not become a DoS lever).
  if (![N, r, p].every(Number.isInteger) || N < 2 || N > 2 ** 20 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  const salt = Buffer.from(parts[4]!, 'base64');
  const key = Buffer.from(parts[5]!, 'base64');
  if (salt.length < 8 || key.length < 16) return null;
  return { params: { N, r, p, keyLen: key.length, saltLen: salt.length }, salt, key };
}

export interface PasswordPolicy { minLength: number; maxLength: number }
export const DEFAULT_PASSWORD_POLICY: PasswordPolicy = { minLength: 12, maxLength: 128 };
const COMMON = new Set(['password1234', '123456789012', 'qwertyuiop12', 'iloveyou1234', 'letmein12345', 'administrator']);

export type PasswordIssue = 'TOO_SHORT' | 'TOO_LONG' | 'TOO_COMMON' | 'CONTAINS_EMAIL' | 'LOW_VARIETY';

/** Length-first policy (NIST 800-63B style): no composition theatre, but reject obvious weak choices. */
export function checkPassword(pw: string, ctx: { email?: string } = {}, policy: PasswordPolicy = DEFAULT_PASSWORD_POLICY): PasswordIssue[] {
  const issues: PasswordIssue[] = [];
  const len = [...pw].length;
  if (len < policy.minLength) issues.push('TOO_SHORT');
  if (len > policy.maxLength) issues.push('TOO_LONG');
  const lower = pw.toLowerCase();
  if (COMMON.has(lower)) issues.push('TOO_COMMON');
  const local = ctx.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) issues.push('CONTAINS_EMAIL');
  if (new Set(lower).size < 5) issues.push('LOW_VARIETY');
  return issues;
}
