/**
 * Minimal stale-while-revalidate cache core (framework-free). The React hook in ./use-query.ts subscribes to it.
 * Entries are immutable snapshots so they can back useSyncExternalStore.
 */
export interface Entry<T = unknown> {
  data: T | undefined;
  error: unknown;
  hasData: boolean;
  updatedAt: number;
  validating: boolean;
  /** Set by invalidate(); the hook revalidates when it sees it. */
  stale: boolean;
}

export interface QueryCache {
  get<T>(key: string): Entry<T> | undefined;
  subscribe(key: string, fn: () => void): () => void;
  /** De-duplicates concurrent fetches per key. */
  fetch<T>(key: string, fetcher: () => Promise<T>): Promise<T | undefined>;
  set<T>(key: string, data: T): void;
  /** Marks every key starting with `prefix` stale and notifies subscribers. */
  invalidate(prefix: string): void;
  clear(): void;
}

export function createQueryCache(now: () => number = () => Date.now()): QueryCache {
  const entries = new Map<string, Entry>();
  const listeners = new Map<string, Set<() => void>>();
  const inflight = new Map<string, Promise<unknown>>();

  const notify = (key: string) => {
    for (const fn of listeners.get(key) ?? []) fn();
  };
  const put = (key: string, patch: Partial<Entry>) => {
    const prev = entries.get(key) ?? { data: undefined, error: undefined, hasData: false, updatedAt: 0, validating: false, stale: false };
    entries.set(key, { ...prev, ...patch });
    notify(key);
  };

  return {
    get: <T,>(key: string) => entries.get(key) as Entry<T> | undefined,
    subscribe(key, fn) {
      let set = listeners.get(key);
      if (!set) listeners.set(key, (set = new Set()));
      set.add(fn);
      return () => {
        set?.delete(fn);
        if (set && set.size === 0) listeners.delete(key);
      };
    },
    fetch<T>(key: string, fetcher: () => Promise<T>): Promise<T | undefined> {
      const existing = inflight.get(key) as Promise<T | undefined> | undefined;
      if (existing) return existing;
      put(key, { validating: true, stale: false });
      const p = (async () => {
        try {
          const data = await fetcher();
          put(key, { data, hasData: true, error: undefined, updatedAt: now(), validating: false });
          return data;
        } catch (error) {
          put(key, { error, validating: false });
          return undefined;
        } finally {
          inflight.delete(key);
        }
      })();
      inflight.set(key, p);
      return p;
    },
    set(key, data) {
      put(key, { data, hasData: true, error: undefined, updatedAt: now() });
    },
    invalidate(prefix) {
      for (const key of [...entries.keys()]) {
        if (key.startsWith(prefix)) put(key, { stale: true });
      }
    },
    clear() {
      entries.clear();
      inflight.clear();
    },
  };
}

export const queryCache = createQueryCache();
