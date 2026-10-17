import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { PgSqlExecutor, type PgClientLike, type PgPoolLike, type PgQueryResult } from '../src';

function fakePool(opts: { failOn?: RegExp; failRollback?: boolean } = {}) {
  const log: string[] = []; const releases: boolean[] = [];
  const result = (rows: Record<string, unknown>[] = [], rowCount: number | null = rows.length): PgQueryResult => ({ rows, rowCount });
  const run = async (text: string, values?: readonly unknown[]): Promise<PgQueryResult> => {
    log.push(values && values.length ? `${text} <${JSON.stringify(values)}>` : text);
    if (opts.failRollback && text === 'ROLLBACK') throw new Error('conn dead');
    if (opts.failOn && opts.failOn.test(text)) throw Object.assign(new Error('boom'), { code: '23505' });
    return /^SELECT/.test(text) ? result([{ id: 1 }]) : result([], 3);
  };
  const client: PgClientLike = { query: run, release: (d) => { releases.push(Boolean(d)); } };
  const pool: PgPoolLike = { query: run, connect: async () => { log.push('CONNECT'); return client; } };
  return { pool, log, releases };
}

describe('PgSqlExecutor (statement sequencing with a recording fake pool; real pg driver NOT exercised)', () => {
  it('query/exec go straight to the pool with $n parameters; exec returns the row count', async () => {
    const f = fakePool(); const db = new PgSqlExecutor(f.pool);
    assert.deepEqual(await db.query('SELECT 1 WHERE x = $1', ['a']), [{ id: 1 }]);
    assert.equal(await db.exec('UPDATE t SET a = $1', [1]), 3);
    assert.deepEqual(f.log, ['SELECT 1 WHERE x = $1 <["a"]>', 'UPDATE t SET a = $1 <[1]>']);
  });
  it('transaction: one connection, BEGIN ... COMMIT, released once', async () => {
    const f = fakePool(); const db = new PgSqlExecutor(f.pool);
    const out = await db.transaction(async (tx) => { await tx.exec('UPDATE a SET x = 1'); return tx.query('SELECT 2'); });
    assert.deepEqual(out, [{ id: 1 }]);
    assert.deepEqual(f.log, ['CONNECT', 'BEGIN', 'UPDATE a SET x = 1', 'SELECT 2', 'COMMIT']);
    assert.deepEqual(f.releases, [false]);
  });
  it('an error rolls back, rethrows the ORIGINAL error (code intact) and still releases', async () => {
    const f = fakePool({ failOn: /^INSERT/ }); const db = new PgSqlExecutor(f.pool);
    await assert.rejects(db.transaction(async (tx) => { await tx.exec('INSERT INTO t VALUES (1)'); }), (e: Error & { code?: string }) => e.message === 'boom' && e.code === '23505');
    assert.deepEqual(f.log, ['CONNECT', 'BEGIN', 'INSERT INTO t VALUES (1)', 'ROLLBACK']);
    assert.deepEqual(f.releases, [false]);
  });
  it('a failed ROLLBACK destroys the connection instead of returning it to the pool', async () => {
    const f = fakePool({ failOn: /^INSERT/, failRollback: true }); const db = new PgSqlExecutor(f.pool);
    await assert.rejects(db.transaction(async (tx) => { await tx.exec('INSERT INTO t VALUES (1)'); }), /boom/);
    assert.deepEqual(f.releases, [true]);
  });
  it('nested transactions use savepoints; an inner failure rolls back only the inner part', async () => {
    const f = fakePool(); const db = new PgSqlExecutor(f.pool);
    await db.transaction(async (tx) => {
      await tx.exec('UPDATE a SET x = 1');
      await assert.rejects(tx.transaction(async (inner) => { await inner.exec('UPDATE b SET y = 1'); throw new Error('inner'); }), /inner/);
      await tx.transaction(async (inner) => { await inner.exec('UPDATE c SET z = 1'); });
    });
    assert.deepEqual(f.log, ['CONNECT', 'BEGIN', 'UPDATE a SET x = 1', 'SAVEPOINT sp_1', 'UPDATE b SET y = 1', 'ROLLBACK TO SAVEPOINT sp_1',
      'SAVEPOINT sp_2', 'UPDATE c SET z = 1', 'RELEASE SAVEPOINT sp_2', 'COMMIT']);
  });
});
