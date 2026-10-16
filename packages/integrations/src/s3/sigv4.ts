import { createHash, createHmac } from 'node:crypto';

/**
 * AWS Signature Version 4 (query-string "presign" and header signing), implemented with node:crypto only.
 * Verified against AWS's published presigned-URL example (see test/sigv4.test.ts).
 * Works with Cloudflare R2 (region "auto") and any S3-compatible store.
 */
export const EMPTY_SHA256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
export const UNSIGNED_PAYLOAD = 'UNSIGNED-PAYLOAD';

export interface Credentials {
  accessKeyId: string;
  secretAccessKey: string;
}

const sha256Hex = (data: string): string => createHash('sha256').update(data, 'utf8').digest('hex');
const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data, 'utf8').digest();

/** RFC 3986 encoding as required by SigV4 (encodeURIComponent leaves !'()* unescaped). */
export function uriEncode(value: string, encodeSlash = true): string {
  const encoded = encodeURIComponent(value).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return encodeSlash ? encoded : encoded.replace(/%2F/g, '/');
}

export function amzDate(d: Date): { date: string; datetime: string } {
  const iso = d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z'); // 20130524T000000Z
  return { datetime: iso, date: iso.slice(0, 8) };
}

export function deriveSigningKey(secret: string, date: string, region: string, service: string): Buffer {
  return hmac(hmac(hmac(hmac('AWS4' + secret, date), region), service), 'aws4_request');
}

export interface SignInput {
  method: string;
  /** Host header value (including a non-default port). */
  host: string;
  /** Absolute path, NOT yet encoded, e.g. "/bucket/videos/a b.mp4". */
  path: string;
  query?: Record<string, string>;
  /** Extra headers to sign (lower-case names). `host` is always signed. */
  headers?: Record<string, string>;
  payloadHash: string;
  region: string;
  service?: string;
  credentials: Credentials;
  now: Date;
}

function canonicalize(input: SignInput, signedQuery: Record<string, string>) {
  const headers: Record<string, string> = { host: input.host };
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = Object.entries(signedQuery)
    .map(([k, v]) => [uriEncode(k), uriEncode(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : 1))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalUri = uriEncode(input.path, false);
  const canonicalRequest = [input.method.toUpperCase(), canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, input.payloadHash].join('\n');
  return { canonicalRequest, signedHeaders, canonicalQuery, canonicalUri };
}

function signature(input: SignInput, canonicalRequest: string): { sig: string; scope: string } {
  const { date, datetime } = amzDate(input.now);
  const service = input.service ?? 's3';
  const scope = `${date}/${input.region}/${service}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', datetime, scope, sha256Hex(canonicalRequest)].join('\n');
  const key = deriveSigningKey(input.credentials.secretAccessKey, date, input.region, service);
  return { sig: createHmac('sha256', key).update(stringToSign, 'utf8').digest('hex'), scope };
}

/** Query-string signing: returns the complete query (including X-Amz-Signature) for the URL. */
export function presignQuery(input: SignInput & { expiresSeconds: number }): string {
  if (!Number.isInteger(input.expiresSeconds) || input.expiresSeconds < 1 || input.expiresSeconds > 604_800) {
    throw new RangeError('expiresSeconds must be an integer between 1 and 604800');
  }
  const { datetime } = amzDate(input.now);
  const { date } = amzDate(input.now);
  const service = input.service ?? 's3';
  const base: Record<string, string> = {
    ...(input.query ?? {}),
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${input.credentials.accessKeyId}/${date}/${input.region}/${service}/aws4_request`,
    'X-Amz-Date': datetime,
    'X-Amz-Expires': String(input.expiresSeconds),
    'X-Amz-SignedHeaders': '',
  };
  const names = ['host', ...Object.keys(input.headers ?? {}).map((h) => h.toLowerCase())].sort();
  base['X-Amz-SignedHeaders'] = names.join(';');
  const { canonicalRequest, canonicalQuery } = canonicalize(input, base);
  const { sig } = signature(input, canonicalRequest);
  return `${canonicalQuery}&X-Amz-Signature=${sig}`;
}

/** Header signing: returns the headers to send (Authorization, x-amz-date, x-amz-content-sha256 + the given ones). */
export function signHeaders(input: SignInput): Record<string, string> {
  const { datetime } = amzDate(input.now);
  const headers = {
    ...(input.headers ?? {}),
    'x-amz-content-sha256': input.payloadHash,
    'x-amz-date': datetime,
  };
  const withHeaders = { ...input, headers };
  const { canonicalRequest, signedHeaders } = canonicalize(withHeaders, input.query ?? {});
  const { sig, scope } = signature(withHeaders, canonicalRequest);
  return {
    ...headers,
    authorization: `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
  };
}
