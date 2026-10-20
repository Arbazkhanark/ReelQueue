/**
 * Typed API client built from the shared ROUTES table (the single source of truth for method/path/types).
 * Request and response types come from the RouteSpec phantom members; nothing is redefined here.
 */
import { ROUTES } from '@reelqueue/shared';
import type { RouteName } from '@reelqueue/shared';
import { createHttpClient } from './http';
import type { CallOptions, PathParams } from './http';

export { ApiError, errorMessage, fieldErrors, isApiError } from './http';

export const API_ORIGIN: string = process.env.NEXT_PUBLIC_API_ORIGIN ?? 'https://reelqueue-api.onrender.com';

type Routes = typeof ROUTES;
type ReqOf<S> = S extends { _req?: infer Q } ? Exclude<Q, undefined> : never;
type ResOf<S> = S extends { _res?: infer R } ? Exclude<R, undefined> : never;

export type RouteRequest<K extends RouteName> = ReqOf<Routes[K]>;
export type RouteResponse<K extends RouteName> = ResOf<Routes[K]>;

export interface TypedCallOptions<K extends RouteName> {
  params?: PathParams;
  query?: object;
  body?: RouteRequest<K>;
  signal?: AbortSignal;
  noAuthRedirect?: boolean;
}

const http = createHttpClient({
  baseUrl: API_ORIGIN,
  refreshRoute: ROUTES.refresh,
});

export function setUnauthenticatedHandler(fn: (() => void) | undefined): void {
  http.setUnauthenticatedHandler(fn);
}

export function call<K extends RouteName>(name: K, opts: TypedCallOptions<K> = {}): Promise<RouteResponse<K>> {
  const o: CallOptions = {};
  if (opts.params) o.params = opts.params;
  if (opts.query) o.query = opts.query;
  if (opts.body !== undefined) o.body = opts.body;
  if (opts.signal) o.signal = opts.signal;
  if (opts.noAuthRedirect) o.noAuthRedirect = true;
  return http.request<RouteResponse<K>>(ROUTES[name], o);
}

export const api = { call };
