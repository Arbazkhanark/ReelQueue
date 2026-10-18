import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadMigrations, runMigrations, stripOwnTransaction, MigrationError } from '../src';
import { PsqlPool, postgresAvailable } from './helpers/psql-executor';

const SQL_DIR = join(__dirname, '../../../apps/api/migrations-sql');
const DB = `reelqueue_migr_${process.pid}`;
const sh = (db: string, args: string[]) => execFileSync('psql', ['-X', '-q', '-v', 'ON_ERROR_STOP=1', '-d', db, ...args]);
let pool: PsqlPool | null = null;

before(async () => {
  if (!(await postgresAvailable('postgres'))) return;
  sh('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]); sh('postgres', ['-c', `CREATE DATABASE ${DB}`]);
  pool = new PsqlPool(DB, 6);
});
after(() => { pool?.close(); try { sh('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB} WITH (FORCE)`]); } catch { /* best effort */ } });

describe('migration runner (real PostgreSQL)', () => {
  it('strips only top-level BEGIN/COMMIT lines', () => {
    assert.equal(stripOwnTransaction('BEGIN;\nCREATE TABLE a(x int);\nCOMMIT;\n').trim(), 'CREATE TABLE a(x int);');
    assert.ok(stripOwnTransaction("INSERT INTO t VALUES ('BEGIN;');").includes("'BEGIN;'"));
  });

  it('applies every real migration once, records checksums, is idempotent, and the result passes the invariant checks', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const db = pool.executor(); const files = loadMigrations(SQL_DIR);
    assert.deepEqual(files.map((f) => f.name.slice(0, 4)), ['0001', '0002', '0003', '0004', '0005']);
    const r1 = await runMigrations(db, files);
    assert.deepEqual(r1.applied, files.map((f) => f.name)); assert.deepEqual(r1.skipped, []);
    const r2 = await runMigrations(db, files);
    assert.deepEqual([r2.applied, r2.skipped.length], [[], 5]);
    assert.equal(Number((await db.query(`SELECT count(*) c FROM schema_migrations`))[0]!.c), 5);
    for (const v of readdirSync(join(SQL_DIR, 'verify')).sort()) sh(DB, ['-f', join(SQL_DIR, 'verify', v)]); // every invariant holds on the migrator-built schema
  });

  it('refuses to continue when an applied migration file was edited', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const files = loadMigrations(SQL_DIR);
    const tampered = files.map((f, i) => (i === 1 ? { ...f, sql: f.sql + '\n-- edited', checksum: 'deadbeef' } : f));
    await assert.rejects(runMigrations(pool.executor(), tampered), (e) => e instanceof MigrationError && /0002_sequence_per_cycle_and_login\.sql was modified/.test(e.message));
  });

  it('concurrent runners (two replicas booting) apply each migration exactly once', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const DB2 = `${DB}_b`;
    sh('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB2} WITH (FORCE)`]); sh('postgres', ['-c', `CREATE DATABASE ${DB2}`]);
    const p2 = new PsqlPool(DB2, 8);
    try {
      const files = loadMigrations(SQL_DIR); const db = p2.executor();
      await db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
      const rs = await Promise.all([runMigrations(db, files), runMigrations(db, files), runMigrations(db, files)]);
      assert.equal(rs.reduce((n, r) => n + r.applied.length, 0), 5, 'five migrations applied in total across three racers');
      assert.equal(Number((await db.query(`SELECT count(*) c FROM schema_migrations`))[0]!.c), 5);
    } finally { p2.close(); sh('postgres', ['-c', `DROP DATABASE IF EXISTS ${DB2} WITH (FORCE)`]); }
  });

  it('a failing migration rolls back completely and is not recorded', async (t) => {
    if (!pool) return t.skip('no PostgreSQL');
    const dir = mkdtempSync(join(tmpdir(), 'mig-'));
    writeFileSync(join(dir, '0001_good.sql'), 'BEGIN;\nCREATE TABLE mig_ok (x int);\nCOMMIT;\n');
    writeFileSync(join(dir, '0002_bad.sql'), 'BEGIN;\nCREATE TABLE mig_half (x int);\nINSERT INTO does_not_exist VALUES (1);\nCOMMIT;\n');
    const db = pool.executor();
    await assert.rejects(runMigrations(db, loadMigrations(dir)), /does_not_exist/);
    assert.equal((await db.query(`SELECT to_regclass('mig_ok') AS t`))[0]!.t, 'mig_ok', 'the good migration before it stays applied');
    assert.equal((await db.query(`SELECT to_regclass('mig_half') AS t`))[0]!.t, null, 'the half-applied table was rolled back');
    assert.equal(Number((await db.query(`SELECT count(*) c FROM schema_migrations WHERE name = '0002_bad.sql'`))[0]!.c), 0);
  });
});
