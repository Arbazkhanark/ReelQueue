'use client';

import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { errorMessage } from '@/lib/http';

type ToastKind = 'success' | 'error' | 'info';
interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}
interface ToastApi {
  success(message: string): void;
  info(message: string): void;
  error(message: string): void;
  /** Convenience: toast the message of any thrown value. */
  fail(e: unknown): void;
}

const Ctx = createContext<ToastApi | null>(null);

export function useToast(): ToastApi {
  const v = useContext(Ctx);
  if (!v) throw new Error('useToast must be used inside <ToastProvider>');
  return v;
}

const TTL: Record<ToastKind, number> = { success: 5000, info: 5000, error: 9000 };

/** Success/info go to a polite live region; errors to an assertive one (role=alert). */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const seq = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((t) => t.filter((x) => x.id !== id)), []);
  const push = useCallback(
    (kind: ToastKind, message: string) => {
      const id = ++seq.current;
      setToasts((t) => [...t.slice(-4), { id, kind, message }]);
      window.setTimeout(() => dismiss(id), TTL[kind]);
    },
    [dismiss],
  );

  const api = useMemo<ToastApi>(
    () => ({
      success: (m) => push('success', m),
      info: (m) => push('info', m),
      error: (m) => push('error', m),
      fail: (e) => push('error', errorMessage(e)),
    }),
    [push],
  );

  const render = (list: Toast[]) =>
    list.map((t) => (
      <div
        key={t.id}
        className={`pointer-events-auto flex items-start gap-3 rounded-md border px-4 py-3 text-sm shadow-card ${
          t.kind === 'error' ? 'border-danger bg-surface text-ink' : t.kind === 'success' ? 'border-ok bg-surface text-ink' : 'border-line bg-surface text-ink'
        }`}
      >
        <span aria-hidden="true" className={t.kind === 'error' ? 'text-danger' : t.kind === 'success' ? 'text-ok' : 'text-info'}>
          {t.kind === 'error' ? '✕' : t.kind === 'success' ? '✓' : 'i'}
        </span>
        <span className="flex-1">
          <span className="sr-only">{t.kind === 'error' ? 'Error: ' : t.kind === 'success' ? 'Success: ' : 'Info: '}</span>
          {t.message}
        </span>
        <button type="button" className="rounded px-1 text-muted hover:text-ink" onClick={() => dismiss(t.id)} aria-label="Dismiss notification">
          {'×'}
        </button>
      </div>
    ));

  return (
    <Ctx.Provider value={api}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-0 z-50 flex flex-col items-center gap-2 p-4 sm:items-end">
        <div role="status" aria-live="polite" className="flex w-full max-w-sm flex-col gap-2">
          {render(toasts.filter((t) => t.kind !== 'error'))}
        </div>
        <div role="alert" aria-live="assertive" className="flex w-full max-w-sm flex-col gap-2">
          {render(toasts.filter((t) => t.kind === 'error'))}
        </div>
      </div>
    </Ctx.Provider>
  );
}
