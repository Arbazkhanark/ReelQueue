export interface HttpRequest {
  method: string;
  /** Path only, no query string. */
  path: string;
  query: Record<string, string>;
  /** Lower-cased header names. */
  headers: Record<string, string | undefined>;
  /** Parsed JSON body (undefined when none). */
  body: unknown;
  ip: string;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  /** Complete Set-Cookie header values. */
  cookies: string[];
  /** JSON-serialisable; omitted for 204. */
  body?: unknown;
}
export const json = (status: number, body?: unknown): HttpResponse => ({ status, headers: {}, cookies: [], ...(body === undefined ? {} : { body }) });
