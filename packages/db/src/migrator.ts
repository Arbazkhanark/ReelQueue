import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SqlExecutor } from './sql';

/**
 * Forward-only SQL migration runner (explicit migrations, never `synchronize`).
 *  - files: NNNN_name.sql in lexical order; each runs in ONE transaction together with its bookkeeping row;
 *  - a pg advisory lock serialises concurrent runners (e.g. two API replicas booting together);
 *  - the SHA-256 of every applied file is recorded; if an applied file is edited later, the run REFUSES to continue.
 * A file's own top-level BEGIN;/COMMIT; lines are stripped (the runner owns the transaction).
 */
export interface MigrationFile { name: string; sql: string; checksum: string }
export const MIGRATION_LOCK_KEY = 7311001;
const NAME = /^\d{4}_[a-z0-9_]+\.sql$/;

export function loadMigrations(dir: string): MigrationFile[] {
  return readdirSync(dir).filter((f) => NAME.test(f)).sort().map((name) => {
    const sql = readFileSync(join(dir, name), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  });
}

export const stripOwnTransaction = (sql: string): string => sql.replace(/^\s*(BEGIN|COMMIT)\s*;\s*$/gim, '');

export class MigrationError extends Error {}

export async function runMigrations(db: SqlExecutor, files: readonly MigrationFile[], log: (msg: string) => void = () => undefined): Promise<{ applied: string[]; skipped: string[] }> {
  await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
  const applied: string[] = []; const skipped: string[] = [];
  for (const f of files) {
    await db.transaction(async (tx) => {
      await tx.exec(`SELECT pg_advisory_xact_lock(${MIGRATION_LOCK_KEY})`); // released at COMMIT/ROLLBACK
      const done = await tx.query<{ checksum: string }>(`SELECT checksum FROM schema_migrations WHERE name = $1`, [f.name]);
      if (done[0]) {
        if (done[0].checksum !== f.checksum) throw new MigrationError(`Migration ${f.name} was modified after it was applied (checksum mismatch). Never edit an applied migration; add a new one.`);
        skipped.push(f.name);
        return;
      }
      await tx.exec(stripOwnTransaction(f.sql));
      await tx.exec(`INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)`, [f.name, f.checksum]);
      applied.push(f.name);
      log(`applied ${f.name}`);
    });
  }
  return { applied, skipped };
}
