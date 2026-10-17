import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { json, type HttpRequest, type HttpResponse } from './http';

export interface NodeServerOptions { maxBodyBytes?: number; trustProxy?: boolean }

async function readBody(req: IncomingMessage, max: number): Promise<Buffer | 'TOO_LARGE'> {
  const chunks: Buffer[] = []; let n = 0;
  for await (const c of req) {
    const b = c as Buffer; n += b.length;
    if (n > max) return 'TOO_LARGE'; // stop buffering; the caller answers 413 and closes the connection
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, r: HttpResponse): void {
  const payload = r.body === undefined ? undefined : JSON.stringify(r.body);
  const headers: Record<string, string | string[]> = { ...r.headers };
  if (r.cookies.length) headers['set-cookie'] = r.cookies;
  if (payload !== undefined) { headers['content-type'] = 'application/json; charset=utf-8'; headers['content-length'] = String(Buffer.byteLength(payload)); }
  res.writeHead(r.status, headers);
  res.end(payload);
}

/** Thin node:http adapter around the framework-free handler. Body size is capped; only JSON bodies are accepted. */
export function createNodeServer(handle: (r: HttpRequest) => Promise<HttpResponse>, opts: NodeServerOptions = {}): Server {
  const max = opts.maxBodyBytes ?? 1024 * 1024;
  const server = createServer(async (incoming, res) => {
    try {
      const url = new URL(incoming.url ?? '/', 'http://local');
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(incoming.headers)) headers[k] = Array.isArray(v) ? v.join(', ') : v;
      let body: unknown;
      if (incoming.method !== 'GET' && incoming.method !== 'HEAD' && incoming.method !== 'OPTIONS') {
        const raw = await readBody(incoming, max);
        if (raw === 'TOO_LARGE') {
          const r = json(413, { error: { code: 'VALIDATION_FAILED', message: 'Request body too large.' } });
          r.headers.connection = 'close';
          res.once('finish', () => incoming.destroy()); // answer first, then drop the rest of the upload
          return send(res, r);
        }
        if (raw.length) {
          if (!(headers['content-type'] ?? '').toLowerCase().startsWith('application/json')) return send(res, json(415, { error: { code: 'VALIDATION_FAILED', message: 'Content-Type must be application/json.' } }));
          try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, json(400, { error: { code: 'VALIDATION_FAILED', message: 'Malformed JSON.' } })); }
        }
      }
      const fwd = opts.trustProxy ? headers['x-forwarded-for']?.split(',')[0]?.trim() : undefined;
      send(res, await handle({ method: incoming.method ?? 'GET', path: url.pathname, query: Object.fromEntries(url.searchParams), headers, body, ip: fwd || incoming.socket.remoteAddress || 'unknown' }));
    } catch {
      if (!res.headersSent) send(res, json(500, { error: { code: 'INTERNAL', message: 'Something went wrong.' } }));
    }
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  return server;
}
