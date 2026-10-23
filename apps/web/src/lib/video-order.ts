// apps/web/src/lib/video-order.ts
// Pure helpers that decide the publishing sequence. No React, no network: easy to test.
import type { VideoDto } from '@reelqueue/shared';

export type SortKey = 'name' | 'size' | 'uploaded' | 'duration';
export type SortDir = 'asc' | 'desc';
export type OrderItem = Pick<VideoDto, 'id' | 'filename' | 'sizeBytes' | 'durationMs' | 'createdAt'>;

export const SORT_LABELS: Record<SortKey, string> = {
  name: 'File name (natural, 2 before 10)',
  size: 'File size',
  uploaded: 'Upload time',
  duration: 'Duration',
};

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
const byTie = (a: OrderItem, b: OrderItem): number => collator.compare(a.filename, b.filename) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Returns the ids in the requested order. Stable: equal keys fall back to file name, then id. Unknown durations always go last. */
export function sortIds(items: readonly OrderItem[], key: SortKey, dir: SortDir): string[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...items]
    .sort((a, b) => {
      let c = 0;
      switch (key) {
        case 'name': c = collator.compare(a.filename, b.filename) * sign; break;
        case 'size': c = (a.sizeBytes - b.sizeBytes) * sign; break;
        case 'uploaded': c = (Date.parse(a.createdAt) - Date.parse(b.createdAt)) * sign; break;
        case 'duration': {
          if (a.durationMs === null && b.durationMs === null) c = 0;
          else if (a.durationMs === null) return 1;
          else if (b.durationMs === null) return -1;
          else c = (a.durationMs - b.durationMs) * sign;
          break;
        }
      }
      return c !== 0 ? c : byTie(a, b);
    })
    .map((x) => x.id);
}

/** Fisher-Yates. `rng` is injectable so tests are deterministic. */
export function shuffleIds(ids: readonly string[], rng: () => number = Math.random): string[] {
  const out = [...ids];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

export const reverseIds = (ids: readonly string[]): string[] => [...ids].reverse();

/** Moves one id to an absolute index (0 = first, length-1 = last). */
export function moveTo(ids: readonly string[], from: number, to: number): string[] {
  if (from < 0 || from >= ids.length) return [...ids];
  const t = Math.min(Math.max(to, 0), ids.length - 1);
  const out = [...ids];
  const [x] = out.splice(from, 1);
  out.splice(t, 0, x!);
  return out;
}

/** Applies a draft order to the current READY list: ids that disappeared are dropped, new ids are appended. */
export function applyDraft<T extends { id: string }>(ready: readonly T[], draft: readonly string[] | null): T[] {
  if (!draft) return [...ready];
  const byId = new Map(ready.map((v) => [v.id, v] as const));
  const seen = new Set<string>();
  const out: T[] = [];
  for (const id of draft) { const v = byId.get(id); if (v && !seen.has(id)) { out.push(v); seen.add(id); } }
  for (const v of ready) if (!seen.has(v.id)) out.push(v);
  return out;
}

/* ------------------------------------------------------------- Drive import order */
export type DriveSortKey = 'name' | 'size' | 'modified';
export interface DriveItem { id: string; name: string; sizeBytes: number | null; modifiedTime: string | null }

export function sortDrive<T extends DriveItem>(files: readonly T[], key: DriveSortKey, dir: SortDir): T[] {
  const sign = dir === 'asc' ? 1 : -1;
  return [...files].sort((a, b) => {
    let c = 0;
    if (key === 'name') c = collator.compare(a.name, b.name) * sign;
    else if (key === 'size') c = ((a.sizeBytes ?? 0) - (b.sizeBytes ?? 0)) * sign;
    else c = ((a.modifiedTime ? Date.parse(a.modifiedTime) : 0) - (b.modifiedTime ? Date.parse(b.modifiedTime) : 0)) * sign;
    return c !== 0 ? c : collator.compare(a.name, b.name) || (a.id < b.id ? -1 : 1);
  });
}