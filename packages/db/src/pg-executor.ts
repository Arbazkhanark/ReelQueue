import type { SqlExecutor } from './sql';

/**
 * PRODUCTION SqlExecutor over the `pg` driver. Written against structural types (no `pg` import) so it compiles and is
 * unit-tested without the driver installed; apps pass `new Pool(...)` from `pg`, which satisfies PgPoolLike.
 *
 * UNVERIFIED against a real `pg` Pool (the driver cannot be installed in the build workspace). The statement sequencing
 * (BEGIN / COMMIT / ROLLBACK / SAVEPOINT / release) is verified with a recording fake in test/pg-executor.test.ts, and the
 * SQL it carries is verified on real PostgreSQL through the psql test adapter.
 */
export interface PgQueryResult { rows: Record<string, unknown>[]; rowCount: number | null }
export interface PgClientLike {
  query(text: string, values?: readonly unknown[]): Promise<PgQueryResult>;
  /** Passing `true` destroys the connection instead of returning it to the pool (used when ROLLBACK itself failed). */
  release(destroy?: boolean): void;
}
export interface PgPoolLike {
  query(text: string, values?: readonly unknown[]): Promise<PgQueryResult>;
  connect(): Promise<PgClientLike>;
}

class ClientExecutor implements SqlExecutor {
  private savepoints = 0;
  constructor(private readonly client: PgClientLike) {}
  async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return (await this.client.query(sql, params)).rows as T[];
  }
  async exec(sql: string, params: readonly unknown[] = []): Promise<number> {
    return (await this.client.query(sql, params)).rowCount ?? 0;
  }
  /** Nested transactions become savepoints, so a store method that opens a transaction can be called inside another. */
  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const name = `sp_${++this.savepoints}`;
    await this.client.query(`SAVEPOINT ${name}`);
    try {
      const out = await fn(this);
      await this.client.query(`RELEASE SAVEPOINT ${name}`);
      return out;
    } catch (e) {
      await this.client.query(`ROLLBACK TO SAVEPOINT ${name}`);
      throw e;
    }
  }
}

export class PgSqlExecutor implements SqlExecutor {
  constructor(private readonly pool: PgPoolLike) {}
  async query<T = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<T[]> {
    return (await this.pool.query(sql, params)).rows as T[];
  }
  async exec(sql: string, params: readonly unknown[] = []): Promise<number> {
    return (await this.pool.query(sql, params)).rowCount ?? 0;
  }
  async transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let destroy = false;
    try {
      await client.query('BEGIN');
      try {
        const out = await fn(new ClientExecutor(client));
        await client.query('COMMIT');
        return out;
      } catch (e) {
        try { await client.query('ROLLBACK'); } catch { destroy = true; /* connection is in an unknown state: do not reuse it */ }
        throw e;
      }
    } finally {
      client.release(destroy);
    }
  }
}
