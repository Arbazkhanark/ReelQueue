/**
 * Queue cursor.
 *
 * The cursor stores the POSITION of the last video released, not an array index,
 * so inserting, deleting or reordering videos while a cycle is active never
 * corrupts it: the next batch is simply "the eligible videos whose position is
 * greater than the last released position".
 */
export interface QueueVideo {
  id: string;
  position: number;
}

export interface CursorState {
  /** Position of the last video released in the current pass; -1 before the first. */
  lastPosition: number;
  /** 1-based pass number over the queue (increments when looping wraps). */
  iteration: number;
}

export const INITIAL_CURSOR: CursorState = { lastPosition: -1, iteration: 1 };

export interface BatchItem {
  videoId: string;
  position: number;
  iteration: number;
}

export interface BatchSelection {
  items: BatchItem[];
  next: CursorState;
  /** True when no further video would be released after this batch (loop disabled). */
  drainedAfter: boolean;
  /** True when the cursor wrapped to the start of the queue during selection. */
  wrapped: boolean;
}

/**
 * Selects up to `size` videos in position order. A batch never contains the same
 * video twice (size is capped at the number of eligible videos). With looping,
 * the cursor wraps to the start and `iteration` increments; without looping the
 * selection stops at the end of the queue.
 */
export function selectBatch(args: {
  videos: readonly QueueVideo[];
  state: CursorState;
  size: number;
  loopEnabled: boolean;
}): BatchSelection {
  const sorted = [...args.videos].sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const cap = Math.max(0, Math.min(Math.floor(args.size), sorted.length));

  let last = args.state.lastPosition;
  let iteration = args.state.iteration;
  let wrapped = false;
  const items: BatchItem[] = [];

  while (items.length < cap) {
    const next = sorted.find((v) => v.position > last);
    if (!next) {
      if (!args.loopEnabled) break;
      iteration += 1;
      last = -1;
      wrapped = true;
      continue;
    }
    items.push({ videoId: next.id, position: next.position, iteration });
    last = next.position;
  }

  const drainedAfter = !args.loopEnabled && !sorted.some((v) => v.position > last);

  return { items, next: { lastPosition: last, iteration }, drainedAfter, wrapped };
}
