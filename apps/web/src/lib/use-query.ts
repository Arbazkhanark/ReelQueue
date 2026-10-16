'use client';

import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import { queryCache } from './query-cache';
import type { Entry } from './query-cache';

export interface QueryOptions {
  /** Poll interval while the tab is visible. */
  refreshMs?: number;
  /** false = do not fetch (e.g. waiting for a prerequisite). */
  enabled?: boolean;
}

export interface QueryResult<T> {
  data: T | undefined;
  error: unknown;
  /** No data yet and a request is pending or about to start. */
  isLoading: boolean;
  isValidating: boolean;
  /** Revalidate now. */
  reload: () => Promise<void>;
  /** Replace cached data without a request (optimistic update). */
  setData: (data: T) => void;
}

const noopSubscribe = () => () => undefined;

/** SWR-like hook: cached data is shown immediately, then revalidated; polls while the tab is visible. */
export function useQuery<T>(key: string | null, fetcher: () => Promise<T>, opts: QueryOptions = {}): QueryResult<T> {
  const enabled = opts.enabled !== false && key !== null;
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const subscribe = useCallback((fn: () => void) => (key ? queryCache.subscribe(key, fn) : noopSubscribe()), [key]);
  const getSnapshot = useCallback((): Entry<T> | undefined => (key ? queryCache.get<T>(key) : undefined), [key]);
  const entry = useSyncExternalStore(subscribe, getSnapshot, () => undefined);

  const reload = useCallback(async () => {
    if (!key) return;
    await queryCache.fetch(key, () => fetcherRef.current());
  }, [key]);

  // initial + key change
  useEffect(() => {
    if (enabled) void reload();
  }, [enabled, reload]);

  // invalidate() marks entries stale -> revalidate
  const stale = entry?.stale === true;
  useEffect(() => {
    if (enabled && stale) void reload();
  }, [enabled, stale, reload]);

  // polling + revalidate on focus / tab becoming visible
  const refreshMs = opts.refreshMs;
  useEffect(() => {
    if (!enabled) return;
    const visible = () => document.visibilityState === 'visible';
    const onVisible = () => {
      if (visible()) void reload();
    };
    const id = refreshMs ? window.setInterval(() => visible() && void reload(), refreshMs) : undefined;
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      if (id !== undefined) window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, [enabled, refreshMs, reload]);

  const setData = useCallback(
    (data: T) => {
      if (key) queryCache.set(key, data);
    },
    [key],
  );

  const hasData = entry?.hasData === true;
  return {
    data: hasData ? entry?.data : undefined,
    error: entry?.error,
    isLoading: enabled && !hasData && !entry?.error,
    isValidating: entry?.validating === true,
    reload,
    setData,
  };
}
