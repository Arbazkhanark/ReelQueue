import { AppError } from '@reelqueue/shared';

/**
 * Minimal request validation (no schema library is installable here). Collects ALL problems, then throws one
 * VALIDATION_FAILED with field-level details. Unknown keys are ignored; handlers copy fields explicitly, so
 * mass-assignment is impossible.
 */
export class Fields {
  private readonly obj: Record<string, unknown>;
  constructor(body: unknown, private readonly prefix = '', private readonly errs: { field: string; message: string }[] = []) {
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      this.errs.push({ field: prefix || 'body', message: 'Expected a JSON object.' });
      this.obj = {};
    } else this.obj = body as Record<string, unknown>;
  }
  private bad(name: string, message: string) { this.errs.push({ field: this.prefix + name, message }); }
  private has(name: string): boolean { return this.obj[name] !== undefined; }

  str(name: string, o: { min?: number; max?: number } = {}): string {
    const v = this.obj[name];
    if (typeof v !== 'string') { this.bad(name, 'Must be a string.'); return ''; }
    const n = [...v].length;
    if (n < (o.min ?? 1)) this.bad(name, `Must be at least ${o.min ?? 1} character(s).`);
    if (n > (o.max ?? 1000)) this.bad(name, `Must be at most ${o.max ?? 1000} characters.`);
    return v;
  }
  optStr(name: string, o: { min?: number; max?: number } = {}): string | undefined { return this.has(name) ? this.str(name, o) : undefined; }
  nullableStr(name: string, max: number): string | null | undefined {
    if (!this.has(name)) { this.bad(name, 'Required.'); return undefined; }
    return this.obj[name] === null ? null : this.str(name, { min: 0, max });
  }
  int(name: string, o: { min?: number; max?: number } = {}): number {
    const v = this.obj[name];
    if (typeof v !== 'number' || !Number.isSafeInteger(v)) { this.bad(name, 'Must be an integer.'); return 0; }
    if (o.min !== undefined && v < o.min) this.bad(name, `Must be at least ${o.min}.`);
    if (o.max !== undefined && v > o.max) this.bad(name, `Must be at most ${o.max}.`);
    return v;
  }
  optInt(name: string, o: { min?: number; max?: number } = {}): number | undefined { return this.has(name) ? this.int(name, o) : undefined; }
  optBool(name: string): boolean | undefined {
    if (!this.has(name)) return undefined;
    const v = this.obj[name];
    if (typeof v !== 'boolean') { this.bad(name, 'Must be true or false.'); return undefined; }
    return v;
  }
  bool(name: string): boolean { const v = this.optBool(name); if (v === undefined) this.bad(name, 'Required.'); return v ?? false; }
  stringArray(name: string, o: { max: number; itemMax?: number }): string[] {
    const v = this.obj[name];
    if (!Array.isArray(v)) { this.bad(name, 'Must be an array.'); return []; }
    if (v.length > o.max) { this.bad(name, `At most ${o.max} items.`); return []; }
    const out: string[] = [];
    v.forEach((x, i) => { if (typeof x !== 'string' || x.length > (o.itemMax ?? 200)) this.bad(`${name}[${i}]`, 'Must be a string.'); else out.push(x); });
    return out;
  }
  optStringArray(name: string, o: { max: number }): string[] | undefined { return this.has(name) ? this.stringArray(name, o) : undefined; }
  objects(name: string, o: { min: number; max: number }): Fields[] {
    const v = this.obj[name];
    if (!Array.isArray(v)) { this.bad(name, 'Must be an array.'); return []; }
    if (v.length < o.min || v.length > o.max) { this.bad(name, `Must contain ${o.min}-${o.max} items.`); return []; }
    return v.map((x, i) => new Fields(x, `${this.prefix}${name}[${i}].`, this.errs));
  }
  done(): void { if (this.errs.length) throw new AppError('VALIDATION_FAILED', 'Invalid input.', [...this.errs]); }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** A malformed id can never name a resource: answer NOT_FOUND (also avoids a DB cast error). */
export function uuidParam(v: string | undefined, what: string): string {
  if (!v || !UUID.test(v)) throw new AppError('NOT_FOUND', `${what} not found.`);
  return v.toLowerCase();
}

export function queryInt(q: Record<string, string>, name: string, o: { min: number; max: number }): number | undefined {
  const raw = q[name];
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!/^\d{1,9}$/.test(raw) || n < o.min || n > o.max) throw new AppError('VALIDATION_FAILED', 'Invalid input.', [{ field: name, message: `Must be an integer between ${o.min} and ${o.max}.` }]);
  return n;
}
export function queryEnum<T extends string>(q: Record<string, string>, name: string, allowed: readonly T[]): T | undefined {
  const raw = q[name];
  if (raw === undefined) return undefined;
  if (!(allowed as readonly string[]).includes(raw)) throw new AppError('VALIDATION_FAILED', 'Invalid input.', [{ field: name, message: `Must be one of ${allowed.join(', ')}.` }]);
  return raw as T;
}
