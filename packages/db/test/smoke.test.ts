import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { freshDatabase, seedTenant } from './helpers/fixtures';
import { inline } from './helpers/psql-executor';

describe('psql test adapter', () => {
  it('inlines parameters safely', () => {
    assert.equal(inline('SELECT $1, $2, $1', ["o'brien", null]), "SELECT 'o''brien', NULL, 'o''brien'");
  });
  it('runs queries, counts and transactions on real PostgreSQL', async (t) => {
    const pool = await freshDatabase();
    if (!pool) return t.skip('PostgreSQL not available');
    after(() => pool.close());
    const db = pool.executor();
    const seed = await seedTenant(db, 3);
    assert.equal((await db.query('SELECT count(*)::int AS n FROM videos WHERE user_id = $1', [seed.userId]))[0]!.n, 3);
    assert.equal(await db.exec(`UPDATE videos SET caption = 'x' WHERE user_id = $1`, [seed.userId]), 3);
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.exec(`UPDATE videos SET caption = 'y' WHERE user_id = $1`, [seed.userId]);
        throw new Error('boom');
      }),
      /boom/,
    );
    assert.equal((await db.query(`SELECT caption FROM videos WHERE user_id = $1 LIMIT 1`, [seed.userId]))[0]!.caption, 'x');
    await assert.rejects(db.exec(`INSERT INTO users (email, password_hash) VALUES ('Bad@X.test', 'x')`), (e: any) => e.code === '23514');
  });
});
