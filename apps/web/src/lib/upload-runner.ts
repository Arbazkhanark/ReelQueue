import { isSettled, nextToStart, uploadReducer, initialUploadState } from './upload-queue';
import type { UploadAction, UploadState } from './upload-queue';

export type UploadFn = (
  item: { index: number; videoId: string },
  signal: AbortSignal,
  onProgress: (loadedBytes: number) => void,
) => Promise<void>;

export interface UploadSession {
  getState(): UploadState;
  /** Load the init response; does not start anything. */
  init(action: Extract<UploadAction, { type: 'INIT' }>): void;
  /** Start pumping. Resolves each time the queue becomes settled (nothing queued/uploading). */
  start(): Promise<void>;
  retry(index: number): Promise<void>;
  retryAll(): Promise<void>;
  /** Abort in-flight transfers and mark queued files cancelled. */
  cancel(): void;
}

/**
 * Drives the pure reducer: starts at most `state.concurrency` uploads at a time, reports progress and
 * failures. Failed files stay failed until retry()/retryAll() is called (no hidden automatic retries).
 */
export function createUploadSession(upload: UploadFn, onChange: (s: UploadState) => void = () => undefined): UploadSession {
  let state: UploadState = initialUploadState;
  let controller = new AbortController();
  let waiters: (() => void)[] = [];

  const dispatch = (a: UploadAction) => {
    const next = uploadReducer(state, a);
    if (next !== state) {
      state = next;
      onChange(state);
    }
  };

  const flushIfSettled = () => {
    if (isSettled(state)) {
      const w = waiters;
      waiters = [];
      for (const r of w) r();
    }
  };

  const run = async (index: number, videoId: string) => {
    try {
      await upload({ index, videoId }, controller.signal, (loaded) => dispatch({ type: 'PROGRESS', index, loaded }));
      dispatch({ type: 'SUCCESS', index });
    } catch (e) {
      dispatch({ type: 'FAILURE', index, error: e instanceof Error && e.message ? e.message : 'Upload failed' });
    }
    pump();
  };

  const pump = () => {
    if (!controller.signal.aborted) {
      for (const index of nextToStart(state)) {
        const item = state.items.find((it) => it.index === index);
        if (!item || item.videoId === null) continue;
        dispatch({ type: 'START', index });
        void run(index, item.videoId);
      }
    }
    flushIfSettled();
  };

  const settled = () =>
    new Promise<void>((resolve) => {
      if (isSettled(state)) resolve();
      else waiters.push(resolve);
    });

  return {
    getState: () => state,
    init(action) {
      controller = new AbortController();
      state = uploadReducer(initialUploadState, action);
      onChange(state);
    },
    start() {
      const p = settled();
      pump();
      return p;
    },
    retry(index) {
      if (controller.signal.aborted) controller = new AbortController();
      dispatch({ type: 'RETRY', index });
      const p = settled();
      pump();
      return p;
    },
    retryAll() {
      if (controller.signal.aborted) controller = new AbortController();
      dispatch({ type: 'RETRY_ALL' });
      const p = settled();
      pump();
      return p;
    },
    cancel() {
      controller.abort();
      dispatch({ type: 'CANCEL_QUEUED' });
      flushIfSettled();
    },
  };
}
