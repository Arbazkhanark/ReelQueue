/**
 * Minimal SQL port. Production adapter: TypeORM `EntityManager.query` / a `pg` Pool (placeholders `$1..$n`).
 * Test adapter: a persistent-psql pool (test/helpers/psql-executor.ts) so the SAME SQL is verified on real PostgreSQL.
 *
 * Contract:
 *  - `query` runs one statement that returns rows (SELECT, or INSERT/UPDATE/DELETE ... RETURNING).
 *  - `exec` runs one statement and returns the affected row count.
 *  - `transaction` runs `fn` on ONE connection inside BEGIN/COMMIT (ROLLBACK on throw).
 *  - bigint columns may come back as string or number, timestamptz as Date or ISO string: mappers normalise.
 */
export interface SqlExecutor {
  query<T = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<T[]>;
  exec(sql: string, params?: readonly unknown[]): Promise<number>;
  transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T>;
}

export type Row = Record<string, unknown>;

export const toDate = (v: unknown): Date => (v instanceof Date ? v : new Date(String(v)));
export const toDateOrNull = (v: unknown): Date | null => (v === null || v === undefined ? null : toDate(v));
export const toNum = (v: unknown): number => (typeof v === 'number' ? v : Number(v));
export const toStrOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

/** True for a PostgreSQL unique-violation (works for `pg` errors and the test adapter). */
export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = err as { code?: string; constraint?: string; message?: string };
  if (e?.code !== '23505') return false;
  return constraint ? e.constraint === constraint || (e.message ?? '').includes(constraint) : true;
}
