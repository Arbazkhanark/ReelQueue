import type { HttpRequest, HttpResponse } from './http';

export type AuthLevel = 'none' | 'user' | 'admin';
export interface Principal { userId: string; role: 'USER' | 'ADMIN' }
export interface RouteContext { req: HttpRequest; params: Record<string, string>; principal: Principal | null; requestId: string }
export type Handler = (ctx: RouteContext) => Promise<HttpResponse>;
export interface RateRule { name: string; limit: number; windowMs: number; /** extra key part, e.g. a hashed email */ by?: (req: HttpRequest) => string | undefined }
export interface RouteDef { method: string; pattern: string; auth: AuthLevel; limits?: RateRule[]; handler: Handler }

interface Compiled extends RouteDef { segments: string[]; statics: number }

export class Router {
  private readonly routes: Compiled[] = [];
  add(def: RouteDef): this {
    const segments = def.pattern.split('/').filter(Boolean);
    this.routes.push({ ...def, segments, statics: segments.filter((s) => !s.startsWith(':')).length });
    return this;
  }
  /** Most specific match wins (`/videos/order` beats `/videos/:id`). Distinguishes "no such path" from "wrong method". */
  match(method: string, path: string): { route: RouteDef; params: Record<string, string> } | { status: 404 | 405; allow: string[] } {
    const parts = path.split('/').filter(Boolean);
    let best: { r: Compiled; params: Record<string, string> } | null = null;
    const allow = new Set<string>();
    for (const r of this.routes) {
      if (r.segments.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < parts.length; i++) {
        const s = r.segments[i]!;
        if (s.startsWith(':')) params[s.slice(1)] = decodeURIComponent(parts[i]!);
        else if (s !== parts[i]) { ok = false; break; }
      }
      if (!ok) continue;
      allow.add(r.method);
      if (r.method === method && (!best || r.statics > best.r.statics)) best = { r, params };
    }
    if (best) return { route: best.r, params: best.params };
    return allow.size ? { status: 405, allow: [...allow] } : { status: 404, allow: [] };
  }
}
