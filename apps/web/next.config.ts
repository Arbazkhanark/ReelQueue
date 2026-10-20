import path from 'node:path';
import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV !== 'production';

const origin = (value: string | undefined, fallback: string): string[] =>
  (value ?? fallback)
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        return new URL(s).origin;
      } catch {
        return '';
      }
    })
    .filter(Boolean);

const apiOrigins = origin(process.env.NEXT_PUBLIC_API_ORIGIN, 'https://reelqueue-api.onrender.com');
const storageOrigins = origin(process.env.NEXT_PUBLIC_STORAGE_ORIGIN, '');

/**
 * CSP. Next.js emits inline bootstrap scripts, so script-src needs 'unsafe-inline' unless nonces are wired
 * through middleware (a later hardening step). 'unsafe-eval' is dev-only (React refresh).
 * connect-src includes the storage origin because the browser PUTs files straight to presigned URLs.
 */
const csp = [
  `default-src 'self'`,
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data: blob: ${storageOrigins.join(' ')}`.trim(),
  `media-src 'self' blob: ${storageOrigins.join(' ')}`.trim(),
  `font-src 'self' data:`,
  `connect-src 'self' ${[...apiOrigins, ...storageOrigins].join(' ')}${isDev ? ' ws:' : ''}`.trim(),
  `frame-ancestors 'none'`,
  `base-uri 'self'`,
  `form-action 'self'`,
  `object-src 'none'`,
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(), payment=()' },
  ...(isDev ? [] : [{ key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains' }]),
];

const nextConfig: NextConfig = {
  output: 'standalone',
  // pnpm workspace: trace files from the repo root so packages/shared (and core) land in the standalone bundle.
  outputFileTracingRoot: path.join(process.cwd(), '../..'),
  reactStrictMode: true,
  poweredByHeader: false,
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
