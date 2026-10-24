// apps/worker/src/lib/use-api.ts
'use client';

import type { RouteName } from '@reelqueue/shared';
import { call } from './api';
import type { RouteResponse } from './api';
import { queryCache } from './query-cache';
import { useQuery } from './use-query';
import type { QueryResult } from './use-query';
import type { PathParams } from './http';

export interface UseApiOptions {
  params?: PathParams;
  query?: object;
  refreshMs?: number;
  enabled?: boolean;
}

/** Poll interval for cycle / job data (spec: every 10 s while the tab is visible; no websockets). */
export const POLL_MS = 10_000;

const keyOf = (name: string, params?: PathParams, query?: object) => `${name}|${JSON.stringify(params ?? {})}|${JSON.stringify(query ?? {})}`;

/** Typed GET-style query for a ROUTES entry, cached and revalidated. */
export function useApi<K extends RouteName>(name: K, opts: UseApiOptions = {}): QueryResult<RouteResponse<K>> {
  const { params, query, refreshMs, enabled } = opts;
  return useQuery<RouteResponse<K>>(
    keyOf(name, params, query),
    () => {
      const o: { params?: PathParams; query?: object } = {};
      if (params) o.params = params;
      if (query) o.query = query;
      return call(name, o);
    },
    { ...(refreshMs !== undefined ? { refreshMs } : {}), ...(enabled !== undefined ? { enabled } : {}) },
  );
}

/** Marks every cached query for the given route names stale so mounted hooks refetch. */
export function invalidate(...names: RouteName[]): void {
  for (const n of names) queryCache.invalidate(`${n}|`);
}

export function clearApiCache(): void {
  queryCache.clear();
}
