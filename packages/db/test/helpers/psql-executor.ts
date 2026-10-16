import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { SqlExecutor } from '../../src/sql';

/**
 * TEST-ONLY SqlExecutor backed by persistent `psql` sessions (no npm driver is installable in the build workspace).
 * It lets the production SQL run, unchanged, against a real PostgreSQL with real concurrency (one session per
 * connection). Parameters are inlined as escaped literals here only; production uses native $n binding.
 * Needs `psql` on PATH and standard PG* env vars (or a role matching the OS user).
 */
const DONE = '@@DONE@@';
const FAIL = '@@FAIL@@';

export function literal(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('non-finite number');
    return String(v);
  }
  if (v instanceof Date) return `'${v.toISOString()}'::timestamptz`;
  if (Array.isArray(v)) return `ARRAY[${v.map(literal).join(',')}]::text[]`;
  return `'${String(v).replace(/\0/g, '').replace(/'/g, "''")}'`;
}

export function inline(sql: string, params: readonly unknown[] = []): string {
  return sql.replace(/\$(\d+)/g, (_m, n: string) => {
    const i = Number(n) - 1;
    if (i < 0 || i >= params.length) throw new Error(`missing parameter $${n}`);
    return literal(params[i]);
  });
}

export class PsqlError extends Error {
  constructor(readonly code: string, message: string, readonly constraint?: string) {
    super(message);
  }
}

class Session {
  private proc: ChildProcessWithoutNullStreams;
  private out = '';
  private err = '';
  private waiter: (() => void) | null = null;
  busy = false;

  constructor(database: string | undefined) {
    const args = ['-X', '-A', '-t', '-v', 'ON_ERROR_STOP=0', '-v', 'VERBOSITY=verbose'];
    if (database) args.push('-d', database);
    this.proc = spawn('psql', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.stdout.on('data', (d: Buffer) => {
      this.out += d.toString();
      this.waiter?.();
    });
    this.proc.stderr.on('data', (d: Buffer) => (this.err += d.toString()));
  }

  async run(statement: string): Promise<{ stdout: string; failed: boolean; stderr: string }> {
    this.out = '';
    this.err = '';
    const done = new Promise<void>((resolve) => {
      this.waiter = () => {
        if (this.out.includes(DONE)) resolve();
      };
    });
    // \echo is client-side: it still works inside an aborted transaction (a SELECT sentinel would not)
    this.proc.stdin.write(`${statement};\n\\if :ERROR\n\\echo ${FAIL}\n\\endif\n\\echo ${DONE}\n`);
    await done;
    await new Promise((r) => setTimeout(r, 5)); // let stderr drain
    const failed = this.out.includes(FAIL);
    return { stdout: this.out.replace(FAIL, '').replace(DONE, ''), failed, stderr: this.err };
  }

  close(): void {
    this.proc.stdin.end('\\q\n');
  }
}

function toError(stderr: string): PsqlError {
  const m = /ERROR:\s+(\w{5}):\s+(.*)/.exec(stderr);
  const c = /constraint "([^"]+)"/.exec(stderr)?.[1];
  return new PsqlError(m?.[1] ?? 'XX000', m?.[2] ?? stderr.trim(), c);
}

async function runOn(session: Session, sql: string, params: readonly unknown[], mode: 'rows' | 'count'): Promise<any> {
  const text = inline(sql, params);
  if (mode === 'rows') {
    const r = await session.run(`WITH q AS (${text}) SELECT coalesce(json_agg(row_to_json(q)), '[]'::json) FROM q`);
    if (r.failed) throw toError(r.stderr);
    return JSON.parse(r.stdout.trim().split('\n').filter(Boolean).pop() ?? '[]');
  }
  const r = await session.run(text);
  if (r.failed) throw toError(r.stderr);
  const m = /^(?:INSERT \d+|UPDATE|DELETE|SELECT|MERGE) (\d+)\s*$/m.exec(r.stdout);
  return m ? Number(m[1]) : 0;
}

export class PsqlPool {
  private sessions: Session[] = [];
  private waiting: ((s: Session) => void)[] = [];
  constructor(private readonly database?: string, private readonly max = 8) {}

  private async acquire(): Promise<Session> {
    const free = this.sessions.find((s) => !s.busy);
    if (free) {
      free.busy = true;
      return free;
    }
    if (this.sessions.length < this.max) {
      const s = new Session(this.database);
      s.busy = true;
      this.sessions.push(s);
      return s;
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(s: Session): void {
    const next = this.waiting.shift();
    if (next) next(s);
    else s.busy = false;
  }

  executor(): SqlExecutor {
    const pool = this;
    const bind = (getSession: () => Promise<{ s: Session; done: () => void }>, inTx: boolean): SqlExecutor => ({
      async query(sql, params = []) {
        const { s, done } = await getSession();
        try {
          return await runOn(s, sql, params, 'rows');
        } finally {
          done();
        }
      },
      async exec(sql, params = []) {
        const { s, done } = await getSession();
        try {
          return await runOn(s, sql, params, 'count');
        } finally {
          done();
        }
      },
      async transaction(fn) {
        if (inTx) return fn(this); // nested: join the outer transaction
        const s = await pool.acquire();
        try {
          const b = await s.run('BEGIN');
          if (b.failed) throw toError(b.stderr);
          const tx = bind(async () => ({ s, done: () => {} }), true);
          try {
            const result = await fn(tx);
            const c = await s.run('COMMIT');
            if (c.failed) throw toError(c.stderr);
            return result;
          } catch (err) {
            await s.run('ROLLBACK');
            throw err;
          }
        } finally {
          pool.release(s);
        }
      },
    });
    return bind(async () => {
      const s = await pool.acquire();
      return { s, done: () => pool.release(s) };
    }, false);
  }

  async close(): Promise<void> {
    this.sessions.forEach((s) => s.close());
    this.sessions = [];
  }
}

/** True when a local PostgreSQL is reachable with the current PG* settings. */
export async function postgresAvailable(database?: string): Promise<boolean> {
  const pool = new PsqlPool(database, 1);
  try {
    await pool.executor().query('SELECT 1 AS ok');
    return true;
  } catch {
    return false;
  } finally {
    await pool.close();
  }
}
