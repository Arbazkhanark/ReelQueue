import { MemoryRateLimitStore, RateLimiter, ScryptPasswordHasher, seededRng, TokenCipher, PublishExecutor, type Clock, type StorageProvider, type ProviderResolver, MockInstagramProvider, type InstagramProvider } from '@reelqueue/core';
import { AccountStore, AuthStore, PgJobStore, QueryStore, SchedulerStore, SettingsStore, VideoStore, DEFAULT_TICK_CONFIG, FallbackRateLimitStore, PgRateLimitStore, RetentionStore, type SqlExecutor } from '@reelqueue/db';
import { MetaInstagramProvider, MetaOAuthClient, probeVideo, type HttpFn } from '@reelqueue/integrations';
import { AccountService, AuthService, CompositeProviderResolver, CycleService, DbTokenResolver, DEFAULT_AUTH_CONFIG, DEFAULT_TOKEN_REFRESH_CONFIG, InstagramConnectService, OAUTH_STATE_MAX_AGE_MS, RetentionService, TokenRefreshService, DEFAULT_UPLOAD_CONFIG, MeService, ReadService, SchedulerRunner, SettingsService, StorageMediaUrlProvider, UploadFlow, UploadService, type Mailer, type MediaProbe, type WakeQueue } from '@reelqueue/services';
import type { ApiDeps, ApiLogger } from '@reelqueue/http';
import type { AppConfig } from './config';

export interface ComposeInput {
  cfg: AppConfig; db: SqlExecutor; clock: Clock; queue: WakeQueue; storage: StorageProvider; mailer: Mailer; logger: ApiLogger;
  /** Overridable for tests; production uses ffprobe. */
  probe?: MediaProbe;
  /** Overridable for tests (fake Meta HTTP); production uses global fetch. */
  metaHttp?: HttpFn;
  /** Deterministic randomness for tests; production seeds from the clock. */
  rngSeed?: number;
  mockProvider?: MockInstagramProvider;
}

/** The one place stores, adapters and services are assembled. Used by the API process AND the worker process. */
export function compose(i: ComposeInput) {
  const { cfg, db, clock } = i;
  const mockMode = cfg.instagramProvider === 'mock';
  const cipher = TokenCipher.fromEnv(cfg.tokenKeys, cfg.tokenActiveKeyId);

  const videos = new VideoStore(db), query = new QueryStore(db), accounts = new AccountStore(db), settingsStore = new SettingsStore(db), sched = new SchedulerStore(db);
  const mock = i.mockProvider ?? new MockInstagramProvider(() => clock.now());
  let meta: InstagramProvider | undefined;
  if (cfg.instagramProvider === 'meta') {
    if (!cfg.meta) throw new Error('META config missing');
    meta = new MetaInstagramProvider(cfg.meta, { tokens: new DbTokenResolver(accounts, cipher), clock, ...(i.metaHttp ? { http: i.metaHttp } : {}) });
  }
  // In meta mode the mock provider is still resolvable for MOCK accounts, but the API cannot create them (AccountService gate).
  const providers: ProviderResolver = new CompositeProviderResolver({ mock, ...(meta ? { meta } : {}) });

  const executor = new PublishExecutor({ store: new PgJobStore(db), providers, clock, rng: seededRng(i.rngSeed ?? clock.now().getTime() % 2 ** 31), media: new StorageMediaUrlProvider(videos, i.storage) });
  const runner = new SchedulerRunner({ store: sched, executor, providers, queue: i.queue, clock, tickConfig: DEFAULT_TICK_CONFIG, logger: { info: (o, m) => i.logger.info(o, m), warn: (o, m) => i.logger.info({ ...o, level: 'warn' }, m) } });

  const limitsFor = async (userId: string) => { const s = await settingsStore.get(userId); return { quotaBytes: s.storageQuotaBytes, maxVideos: s.maxVideos, maxBatchFiles: s.maxUploadBatch }; };
  const probe: MediaProbe = i.probe ?? { probe: (url) => probeVideo(url) };
  const uploads = new UploadService(videos, i.storage, probe, clock, DEFAULT_UPLOAD_CONFIG, undefined, limitsFor);
  const read = new ReadService({ cycles: sched, query, accounts, settings: settingsStore, uploads, videos, clock, mockMode });
  const cycles = new CycleService(sched, accounts, settingsStore, providers, i.queue, read, clock);
  const auth = new AuthService(new AuthStore(db), new ScryptPasswordHasher(), i.mailer, clock, { ...DEFAULT_AUTH_CONFIG, jwtSecret: cfg.jwtSecret });

  // Meta-only: OAuth connect + token refresh. In mock mode neither exists (the mock-connect route is the only way to add accounts).
  let instagramConnect: InstagramConnectService | undefined;
  let tokenRefresh: TokenRefreshService | undefined;
  const svcLog = { warn: (o: Record<string, unknown>, m: string) => i.logger.info({ ...o, level: 'warn' }, m) };
  if (cfg.instagramProvider === 'meta') {
    if (!cfg.meta || !cfg.oauth) throw new Error('META/OAuth config missing');
    const oauth = new MetaOAuthClient({ appId: cfg.oauth.appId, appSecret: cfg.oauth.appSecret, redirectUri: cfg.oauth.redirectUri, scopes: cfg.oauth.scopes, graphVersion: cfg.meta.graphVersion, requestTimeoutMs: cfg.meta.requestTimeoutMs }, { clock, ...(i.metaHttp ? { http: i.metaHttp } : {}) });
    instagramConnect = new InstagramConnectService(accounts, oauth, cipher, clock, { stateSecret: cfg.oauth.stateSecret, stateMaxAgeMs: OAUTH_STATE_MAX_AGE_MS, requiredScopes: cfg.oauth.scopes }, svcLog);
    tokenRefresh = new TokenRefreshService(accounts, oauth, cipher, clock, DEFAULT_TOKEN_REFRESH_CONFIG, svcLog);
  }

  // Shared (cross-replica) rate limiting in PostgreSQL; if the table is unreachable it degrades to a per-replica memory store.
  const rateStore = new PgRateLimitStore(db);
  let degradedLogged = 0;
  const limiter = new RateLimiter(new FallbackRateLimitStore(rateStore, new MemoryRateLimitStore(), () => { const t = clock.now().getTime(); if (t - degradedLogged > 60_000) { degradedLogged = t; i.logger.error({}, 'shared rate limiter unavailable; using per-replica memory fallback'); } }), () => clock.now());

  const retention = new RetentionService(new RetentionStore(db), videos, i.storage, clock, { videoRetentionDays: cfg.retention.videoDays, accountGraceDays: cfg.retention.accountGraceDays }, svcLog);

  const apiDeps: Omit<ApiDeps, 'checks'> = {
    auth, uploads, read, cycles, clock, logger: i.logger,
    config: { allowedOrigins: cfg.allowedOrigins, secureCookies: true, sameSite: 'None', accessTtlSeconds: DEFAULT_AUTH_CONFIG.accessTtlSeconds, refreshTtlSeconds: DEFAULT_AUTH_CONFIG.refreshTtlSeconds, globalPerMinute: 300, webBaseUrl: cfg.webBaseUrl },
    flow: new UploadFlow(uploads, query, videos, read), settings: new SettingsService(settingsStore, accounts, read),
    accounts: new AccountService(accounts, sched, providers, read, clock, { mockMode }), me: new MeService(auth, sched, cycles),
    limiter, ...(instagramConnect ? { instagramConnect } : {}),
  };
  return { apiDeps, runner, uploads, mockMode, providers, tokenRefresh, retention, rateStore };
}
