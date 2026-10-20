import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { MemoryRateLimitStore, RateLimiter, ScryptPasswordHasher, TokenCipher, type MediaMetadata } from '@reelqueue/core';
import { AccountStore, AuthStore, QueryStore, SchedulerStore, SettingsStore, VideoStore } from '@reelqueue/db';
import { AccountService, AuthService, CycleService, InstagramConnectService, type OAuthPort, DEFAULT_AUTH_CONFIG, DEFAULT_UPLOAD_CONFIG, MeService, ReadService, SettingsService, UploadFlow, UploadService, type Mailer } from '@reelqueue/services';
import { createApi, createNodeServer, type ApiConfig } from '../../src';
import { freshDatabase } from '../../../db/test/helpers/fixtures';
import type { PsqlPool } from '../../../db/test/helpers/psql-executor';
import { makeSim } from '../../../services/test/helpers/sim';
import { FakeStorage } from '../../../services/test/helpers/fake-storage';

export const WEB_ORIGIN = 'https://app.example.test';
export const PW = 'correct-horse-battery-staple';
export const MB = 1024 * 1024;
export const GOOD: MediaMetadata = { durationMs: 20_000, width: 720, height: 1280, videoCodec: 'h264', audioCodec: 'aac', container: 'mov,mp4' };

export interface Stack {
  pool: PsqlPool; sim: ReturnType<typeof makeSim>; storage: FakeStorage; mails: { kind: string; to: string; token: string }[];
  probe: { meta: MediaMetadata | null }; server: Server; url: string; close(): Promise<void>;
}

export async function startStack(over: { mockMode?: boolean; config?: Partial<ApiConfig>; oauth?: OAuthPort } = {}): Promise<Stack | null> {
  const pool = await freshDatabase();
  if (!pool) return null;
  const db = pool.executor();
  const sim = makeSim(db);
  const storage = new FakeStorage();
  const probe: { meta: MediaMetadata | null } = { meta: GOOD };
  const mails: Stack['mails'] = [];
  const mailer: Mailer = {
    async sendVerificationEmail(to, token) { mails.push({ kind: 'verify', to, token }); },
    async sendPasswordResetEmail(to, token) { mails.push({ kind: 'reset', to, token }); },
  };
  const providers = { resolve: () => sim.provider };
  const mockMode = over.mockMode ?? true;
  const videos = new VideoStore(db), query = new QueryStore(db), accounts = new AccountStore(db), settingsStore = new SettingsStore(db);
  const sched = new SchedulerStore(db);
  const limitsFor = async (userId: string) => { const s = await settingsStore.get(userId); return { quotaBytes: s.storageQuotaBytes, maxVideos: s.maxVideos, maxBatchFiles: s.maxUploadBatch }; };
  const uploads = new UploadService(videos, storage, { probe: async () => probe.meta }, sim.clock, { ...DEFAULT_UPLOAD_CONFIG, limits: { ...DEFAULT_UPLOAD_CONFIG.limits, quotaBytes: 200 * MB } }, undefined, limitsFor);
  const read = new ReadService({ cycles: sched, query, accounts, settings: settingsStore, uploads, videos, clock: sim.clock, mockMode });
  const cycles = new CycleService(sched, accounts, settingsStore, providers, sim.queue, read, sim.clock);
  const auth = new AuthService(new AuthStore(db), new ScryptPasswordHasher({ N: 1024, r: 8, p: 1, keyLen: 32, saltLen: 16 }), mailer, sim.clock, { ...DEFAULT_AUTH_CONFIG, jwtSecret: 'j'.repeat(48) });
  const config: ApiConfig = { allowedOrigins: [WEB_ORIGIN], secureCookies: true, sameSite: 'None', accessTtlSeconds: 900, refreshTtlSeconds: 30 * 86400, globalPerMinute: 10_000, webBaseUrl: WEB_ORIGIN, ...over.config };
  const cipher = new TokenCipher({ keys: { k1: Buffer.alloc(32, 5) }, activeKeyId: 'k1' });
  const instagramConnect = over.oauth ? new InstagramConnectService(accounts, over.oauth, cipher, sim.clock, { stateSecret: 'o'.repeat(40), stateMaxAgeMs: 600_000, requiredScopes: ['instagram_business_basic', 'instagram_business_content_publish'] }) : undefined;
  const api = createApi({
    ...(instagramConnect ? { instagramConnect } : {}),
    auth, uploads, read, cycles, config, clock: sim.clock,
    flow: new UploadFlow(uploads, query, videos, read), settings: new SettingsService(settingsStore, accounts, read),
    accounts: new AccountService(accounts, sched, providers, read, sim.clock, { mockMode }), me: new MeService(auth, sched, cycles),
    limiter: new RateLimiter(new MemoryRateLimitStore(), () => sim.clock.now()),
    logger: { info: () => undefined, error: () => undefined }, checks: { database: async () => true, redis: async () => true },
  });
  const server = createNodeServer(api, { maxBodyBytes: 64 * 1024, trustProxy: true });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { pool, sim, storage, mails, probe, server, url, close: async () => { await new Promise((r) => server.close(r)); server.closeAllConnections?.(); pool.close(); } };
}

export interface Res { status: number; body: any; headers: Headers; setCookies: string[] } // eslint-disable-line @typescript-eslint/no-explicit-any

/** A browser-like client: keeps cookies (honouring Max-Age=0 deletion), sends Origin on mutations. */
let ipCounter = 0;
export class Client {
  jar = new Map<string, string>();
  /** Each client is a distinct "IP" (via X-Forwarded-For, trustProxy is on in tests) so per-IP limits do not couple unrelated tests. */
  ip = `10.1.${Math.floor(++ipCounter / 250)}.${ipCounter % 250}`;
  constructor(private readonly base: string, public origin: string | null = WEB_ORIGIN) {}
  async req(method: string, path: string, body?: unknown, extra: Record<string, string> = {}): Promise<Res> {
    const headers: Record<string, string> = { 'x-forwarded-for': this.ip, ...extra };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.origin) headers.origin = this.origin;
    if (this.jar.size) headers.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const r = await fetch(this.base + path, { method, headers, ...(body !== undefined ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
    const setCookies = r.headers.getSetCookie();
    for (const c of setCookies) {
      const [pair, ...attrs] = c.split('; ');
      const [k, v] = pair!.split('=');
      if (attrs.some((a) => a.toLowerCase() === 'max-age=0')) this.jar.delete(k!); else this.jar.set(k!, v ?? '');
    }
    const text = await r.text();
    let parsed: unknown = undefined;
    try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    return { status: r.status, body: parsed, headers: r.headers, setCookies };
  }
  get = (p: string) => this.req('GET', p);
  post = (p: string, b?: unknown) => this.req('POST', p, b ?? {});
  patch = (p: string, b: unknown) => this.req('PATCH', p, b);
  put = (p: string, b: unknown) => this.req('PUT', p, b);
  del = (p: string, b?: unknown) => this.req('DELETE', p, b);
}

let n = 0;
/** Registers, verifies and logs in a fresh user. */
export async function signedInUser(stack: Stack, label = `user${++n}`): Promise<{ c: Client; email: string; id: string }> {
  const c = new Client(stack.url);
  const email = `${label}@example.test`;
  const reg = await c.post('/v1/auth/register', { email, password: PW });
  if (reg.status !== 202) throw new Error(`register failed: ${reg.status} ${JSON.stringify(reg.body)}`);
  await c.post('/v1/auth/verify-email', { token: stack.mails.filter((m) => m.kind === 'verify' && m.to === email).pop()!.token });
  const login = await c.post('/v1/auth/login', { email, password: PW });
  if (login.status !== 200) throw new Error(`login failed: ${login.status} ${JSON.stringify(login.body)}`);
  return { c, email, id: login.body.user.id };
}
