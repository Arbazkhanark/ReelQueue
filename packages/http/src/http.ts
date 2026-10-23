export interface HttpRequest {
  method: string;
  /** Path only, no query string. */
  path: string;
  query: Record<string, string>;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  /** Parsed JSON body (undefined when none). */
  body: unknown;
  // NEW: Binary uploads are passed as raw bytes instead of being JSON-parsed.
  rawBody?: Uint8Array;
  ip: string;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** Complete Set-Cookie header values. */
  cookies: string[];
  /** JSON-serialisable; omitted for 204. */
  body?: unknown;

  // Google Drive HTTPS
  /** Optional raw byte stream (used by file downloads). When set, `body` is ignored and the adapter pipes the stream with back-pressure. */
  stream?: AsyncIterable<Uint8Array>;
}
export const json = (status: number, body?: unknown): HttpResponse => ({ status, headers: {}, cookies: [], ...(body === undefined ? {} : { body }) });
