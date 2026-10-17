import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { PsqlPool, postgresAvailable } from './psql-executor';
import type { SqlExecutor } from '../../src/sql';

// One scratch database PER PROCESS (node --test runs files in parallel processes) and dropped on exit.
export const TEST_DB = `${process.env.REELQUEUE_TEST_DB ?? 'reelqueue_dbtest'}_${process.pid}`;
const SQL_DIR = join(__dirname, '../../../../apps/api/migrations-sql');

/** Creates (or recreates) the scratch database, applies every migration, returns a pool. Returns null if Postgres is unavailable. */
export async function freshDatabase(): Promise<PsqlPool | null> {
  if (!(await postgresAvailable('postgres'))) return null;
  execFileSync('psql', ['-X', '-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`]);
  execFileSync('psql', ['-X', '-q', '-d', 'postgres', '-c', `CREATE DATABASE ${TEST_DB}`]);
  for (const f of readdirSync(SQL_DIR).filter((n) => /^\d{4}_.*\.sql$/.test(n)).sort()) {
    execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', TEST_DB, '-f', join(SQL_DIR, f)]);
  }
  process.on('exit', () => {
    try { execFileSync('psql', ['-X', '-q', '-d', 'postgres', '-c', `DROP DATABASE IF EXISTS ${TEST_DB} WITH (FORCE)`]); } catch { /* best effort */ }
  });
  return new PsqlPool(TEST_DB, 8);
}

export interface Seed {
  userId: string;
  accountId: string;
  videoIds: string[];
}

let counter = 0;
/** One tenant with one (mock) Instagram account and `n` READY videos at positions 0..n-1. */
export async function seedTenant(db: SqlExecutor, n: number, label = `u${++counter}`): Promise<Seed> {
  const u = await db.query(`INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`, [`${label}@example.test`]);
  const userId = String(u[0]!.id);
  const a = await db.query(
    `INSERT INTO instagram_accounts (user_id, provider, provider_account_id, access_token_enc)
     VALUES ($1, 'MOCK', $2, 'v1:k:i:c:t') RETURNING id`,
    [userId, `mock_${label}`],
  );
  const videoIds: string[] = [];
  for (let i = 0; i < n; i++) {
    const v = await db.query(
      `INSERT INTO videos (user_id, original_filename, storage_key, content_type, size_bytes, status, position)
       VALUES ($1, $2, $3, 'video/mp4', 1000, 'READY', $4) RETURNING id`,
      [userId, `v${i}.mp4`, `${label}/v${i}`, i],
    );
    videoIds.push(String(v[0]!.id));
  }
  return { userId, accountId: String(a[0]!.id), videoIds };
}
