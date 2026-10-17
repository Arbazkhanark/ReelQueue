export interface CookieOptions { httpOnly?: boolean; secure?: boolean; sameSite?: 'Strict' | 'Lax' | 'None'; path?: string; maxAgeSeconds?: number; domain?: string }

const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const VALUE = /^[\x21\x23-\x2B\x2D-\x3A\x3C-\x5B\x5D-\x7E]*$/;

export function serializeCookie(name: string, value: string, o: CookieOptions = {}): string {
  if (!TOKEN.test(name)) throw new Error('Invalid cookie name');
  if (!VALUE.test(value)) throw new Error('Invalid cookie value');
  if (o.path && !/^\/[\x21-\x3A\x3C-\x7E]*$/.test(o.path)) throw new Error('Invalid cookie path');
  if (o.domain && !/^[A-Za-z0-9.-]+$/.test(o.domain)) throw new Error('Invalid cookie domain');
  if (o.sameSite === 'None' && !o.secure) throw new Error('SameSite=None requires Secure');
  const out = [`${name}=${value}`, `Path=${o.path ?? '/'}`];
  if (o.domain) out.push(`Domain=${o.domain}`);
  if (o.maxAgeSeconds !== undefined) out.push(`Max-Age=${Math.max(0, Math.floor(o.maxAgeSeconds))}`);
  if (o.httpOnly !== false) out.push('HttpOnly');
  if (o.secure) out.push('Secure');
  out.push(`SameSite=${o.sameSite ?? 'Lax'}`);
  return out.join('; ');
}

export const clearCookie = (name: string, o: Omit<CookieOptions, 'maxAgeSeconds'> = {}): string => serializeCookie(name, '', { ...o, maxAgeSeconds: 0 });

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header || header.length > 8192) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (TOKEN.test(k) && VALUE.test(v) && !(k in out)) out[k] = v; // first occurrence wins
  }
  return out;
}
