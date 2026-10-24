// // packages/http/src/node-server.ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { json, type HttpRequest, type HttpResponse } from './http';

export interface NodeServerOptions {
  maxBodyBytes?: number;
  // NEW: separate limit for the authenticated Google Drive raw upload endpoint.
  maxUploadBytes?: number;
  trustProxy?: boolean;
}

async function readBody(req: IncomingMessage, max: number): Promise<Buffer | 'TOO_LARGE'> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req) {
    const b = c as Buffer;
    n += b.length;
    if (n > max) return 'TOO_LARGE';
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

async function sendStream(res: ServerResponse, r: HttpResponse): Promise<void> {
  const headers: Record<string, string | string[]> = { ...r.headers };
  if (r.cookies.length) headers['set-cookie'] = r.cookies;
  res.writeHead(r.status, headers);
  const it = r.stream![Symbol.asyncIterator]();
  let closed = false;
  res.once('close', () => { closed = true; void it.return?.(); });
  try {
    while (!closed) {
      const n = await it.next();
      if (n.done) break;
      if (!res.write(n.value) && !closed) {
        await new Promise<void>((ok) => { res.once('drain', ok); res.once('close', ok); });
      }
    }
    if (!closed) res.end();
  } catch {
    res.destroy();
  }
}

function send(res: ServerResponse, r: HttpResponse): void {
  if (r.stream) { void sendStream(res, r); return; }
  const payload = r.body === undefined ? undefined : JSON.stringify(r.body);
  const headers: Record<string, string | string[]> = { ...r.headers };
  if (r.cookies.length) headers['set-cookie'] = r.cookies;
  if (payload !== undefined) {
    headers['content-type'] = 'application/json; charset=utf-8';
    headers['content-length'] = String(Buffer.byteLength(payload));
  }
  res.writeHead(r.status, headers);
  res.end(payload);
}

/** Thin node:http adapter. JSON bodies stay small; Drive uploads get a separate bounded raw-byte path. */
export function createNodeServer(handle: (r: HttpRequest) => Promise<HttpResponse>, opts: NodeServerOptions = {}): Server {
  const maxJson = opts.maxBodyBytes ?? 1024 * 1024;
  // NEW: configure this from the same maximum as GoogleDriveConfig.maxFileBytes.
  const maxUpload = opts.maxUploadBytes ?? 100 * 1024 * 1024;

  const server = createServer(async (incoming, res) => {
    try {
      const url = new URL(incoming.url ?? '/', 'http://local');
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(incoming.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;

      let body: unknown;
      let rawBody: Uint8Array | undefined;
      const method = incoming.method ?? 'GET';
      if (method !== 'GET' && method !== 'HEAD' && method !== 'OPTIONS') {
        // NEW: only the Google Drive endpoint receives the larger raw-body allowance.
        const isDriveBinaryUpload = method === 'POST'
          && url.pathname === '/v1/google-drive/uploads'
          && (headers['content-type'] ?? '').toLowerCase().startsWith('application/octet-stream');
        const raw = await readBody(incoming, isDriveBinaryUpload ? maxUpload : maxJson);
        if (raw === 'TOO_LARGE') {
          const r = json(413, { error: { code: 'VALIDATION_FAILED', message: 'Request body too large.' } });
          r.headers.connection = 'close';
          res.once('finish', () => incoming.destroy());
          return send(res, r);
        }
        if (raw.length) {
          if (isDriveBinaryUpload) {
            // NEW: preserve bytes exactly; do not JSON.parse a video.
            rawBody = raw;
          } else {
            if (!(headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) {
              return send(res, json(415, { error: { code: 'VALIDATION_FAILED', message: 'Content-Type must be application/json.' } }));
            }
            try {
              body = JSON.parse(raw.toString('utf8'));
            } catch {
              return send(res, json(400, { error: { code: 'VALIDATION_FAILED', message: 'Malformed JSON.' } }));
            }
          }
        }
      }
      const fwd = opts.trustProxy ? headers['x-forwarded-for']?.split(',')[0]?.trim() : undefined;
      send(res, await handle({
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        headers,
        body,
        rawBody, // NEW
        ip: fwd || incoming.socket.remoteAddress || 'unknown',
      }));
    } catch {
      if (!res.headersSent) send(res, json(500, { error: { code: 'INTERNAL', message: 'Something went wrong.' } }));
    }
  });
  server.requestTimeout = 120_000; // CHANGED: allow longer bounded video uploads; proxy limits still apply.
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
