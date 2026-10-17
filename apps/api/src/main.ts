/**
 * UNVERIFIED: depends on `pg`, `bullmq` and `ioredis`, which could not be installed where this was written (npm registry 403).
 * Everything it calls (loadConfig, compose, runMigrations, PgSqlExecutor, createApi, createNodeServer) IS tested.
 * Not compiled, not run. Treat as a first draft until `pnpm install && pnpm --filter @reelqueue/api build` has been run.
 */
import { Pool } from 'pg';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { join } from 'node:path';
import { SystemClock } from '@reelqueue/core';
import { PgSqlExecutor, loadMigrations, runMigrations } from '@reelqueue/db';
import { S3StorageProvider } from '@reelqueue/integrations';
import { createApi, createNodeServer } from '@reelqueue/http';
import { BullWakeQueue, LogMailer, QUEUE_NAME, compose, loadConfig, ConfigError } from '@reelqueue/runtime';

const log = (level: 'info' | 'error') => (o: Record<string, unknown>, msg: string) => console[level === 'info' ? 'log' : 'error'](JSON.stringify({ level, msg, time: new Date().toISOString(), ...o }));
const logger = { info: log('info'), error: log('error') };

async function main(): Promise<void> {
  let cfg;
  try { cfg = loadConfig(process.env); } catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(1); } throw e; }

  const pool = new Pool({ connectionString: cfg.databaseUrl, max: 10 });
  const db = new PgSqlExecutor(pool);
  if (cfg.migrateOnBoot) {
    const dir = process.env.MIGRATIONS_DIR ?? join(__dirname, '../migrations-sql');
    const r = await runMigrations(db, loadMigrations(dir), (m) => logger.info({}, m));
    logger.info({ applied: r.applied.length, skipped: r.skipped.length }, 'migrations');
  }

  const redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const clock = new SystemClock();
  const queue = new BullWakeQueue(new Queue(QUEUE_NAME, { connection: redis }), () => clock.now(), { info: logger.info, warn: logger.info });
  const storage = new S3StorageProvider({ endpoint: cfg.s3.endpoint, region: cfg.s3.region, bucket: cfg.s3.bucket, credentials: { accessKeyId: cfg.s3.accessKeyId, secretAccessKey: cfg.s3.secretAccessKey }, forcePathStyle: cfg.s3.forcePathStyle }, { clock });
  const c = compose({ cfg, db, clock, queue, storage, logger, mailer: new LogMailer(logger.info, cfg.allowedOrigins[0]!) });

  const handle = createApi({
    ...c.apiDeps,
    checks: { database: async () => { try { await db.query('SELECT 1'); return true; } catch { return false; } }, redis: async () => { try { return (await redis.ping()) === 'PONG'; } catch { return false; } } },
  });
  const server = createNodeServer(handle, { maxBodyBytes: 256 * 1024, trustProxy: cfg.trustProxy });
  server.listen(cfg.port, () => logger.info({ port: cfg.port, instagramProvider: cfg.instagramProvider }, 'api listening'));

  const shutdown = (sig: string) => {
    logger.info({ sig }, 'shutting down');
    server.close(() => { void Promise.allSettled([pool.end(), redis.quit()]).then(() => process.exit(0)); });
    setTimeout(() => process.exit(1), 15_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
void main();
