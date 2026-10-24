// apps/worker/src/main.ts
/**
 * UNVERIFIED: depends on `pg`, `bullmq`, `ioredis` (npm registry was blocked). Excluded from tsconfig until they are installed.
 * The logic it wires (BullWakeQueue, makeProcessor, Sweeper, SchedulerRunner, PublishExecutor) is tested with fakes and real PostgreSQL.
 * Not compiled, not run against a real Redis. Verify BullMQ API usage (Worker options, lock settings) against the installed version.
 */
import { Pool } from 'pg';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { SystemClock } from '@reelqueue/core';
import { PgSqlExecutor } from '@reelqueue/db';
import { S3StorageProvider } from '@reelqueue/integrations';
import { BullWakeQueue, QUEUE_NAME, compose, loadConfig, ConfigError } from '@reelqueue/runtime';
import { makeProcessor } from './processor';
import { Sweeper } from './sweeper';
import { PeriodicTask, runMaintenance } from './maintenance';

const out = (level: string) => (o: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ level, msg, time: new Date().toISOString(), svc: 'worker', ...o }));
const logger = { info: out('info'), error: out('error'), warn: out('warn') };

async function main(): Promise<void> {
  let cfg;
  try { cfg = loadConfig(process.env); } catch (e) { if (e instanceof ConfigError) { console.error(e.message); process.exit(1); } throw e; }
  const pool = new Pool({ connectionString: cfg.databaseUrl, max: cfg.worker.concurrency + 2 });
  const db = new PgSqlExecutor(pool);
  const redis = new Redis(cfg.redisUrl, { maxRetriesPerRequest: null });
  const clock = new SystemClock();
  const queue = new BullWakeQueue(new Queue(QUEUE_NAME, { connection: redis }), () => clock.now(), logger);
  const storage = new S3StorageProvider({ endpoint: cfg.s3.endpoint, region: cfg.s3.region, bucket: cfg.s3.bucket, credentials: { accessKeyId: cfg.s3.accessKeyId, secretAccessKey: cfg.s3.secretAccessKey }, forcePathStyle: cfg.s3.forcePathStyle }, { clock });
  const { runner, tokenRefresh, retention, uploads, rateStore } = compose({ cfg, db, clock, queue, storage, logger, mailer: { sendVerificationEmail: async () => undefined, sendPasswordResetEmail: async () => undefined } /* the worker never sends mail */ });

  const workerId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
  const process_ = makeProcessor(runner, workerId, logger);
  const worker = new Worker(QUEUE_NAME, async (job) => process_({ name: job.name, data: job.data }), { connection: redis, concurrency: cfg.worker.concurrency });
  worker.on('failed', (job, err) => logger.error({ name: job?.name, id: job?.data?.id, err: err.message }, 'wake job failed'));

  const sweeper = new Sweeper(runner, { intervalMs: cfg.worker.sweepIntervalMs, jitterMs: cfg.worker.sweepJitterMs }, logger);
  await sweeper.runOnce(); // recover anything lost while no worker was running
  sweeper.start();
  const maintenance = new PeriodicTask(async () => { const r = await runMaintenance({ ...(tokenRefresh ? { tokenRefresh } : {}), retention, uploads, rateStore, now: () => clock.now() }, logger); logger.info(r, 'maintenance'); }, { intervalMs: cfg.retention.intervalMs, jitterMs: 30_000 }, logger, 'maintenance');
  await maintenance.runOnce();
  maintenance.start();
  logger.info({ workerId, concurrency: cfg.worker.concurrency, instagramProvider: cfg.instagramProvider }, 'worker started');

  const shutdown = async (sig: string) => {
    logger.info({ sig }, 'shutting down');
    setTimeout(() => process.exit(1), 30_000).unref();
    await Promise.all([sweeper.stop(), maintenance.stop()]);
    await worker.close(); // waits for in-flight jobs; unfinished leases expire and the sweeper re-wakes them elsewhere
    await Promise.allSettled([pool.end(), redis.quit()]);
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}
void main();
