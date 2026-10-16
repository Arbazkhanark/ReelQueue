'use client';

import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes, SelectHTMLAttributes } from 'react';
import { errorMessage, isApiError } from '@/lib/http';
import type { Tone } from '@/lib/job-status';

/* ------------------------------------------------------------------ Button */
type Variant = 'primary' | 'secondary' | 'danger' | 'ghost';
export function Button({
  variant = 'secondary',
  small,
  loading,
  disabledReason,
  className = '',
  children,
  disabled,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  small?: boolean;
  loading?: boolean;
  /** When set the button is disabled and the reason is exposed as tooltip + accessible description. */
  disabledReason?: string | null;
}) {
  const reasonId = useId();
  const isDisabled = Boolean(disabled || loading || disabledReason);
  return (
    <>
      <button
        type="button"
        {...rest}
        disabled={isDisabled}
        title={disabledReason ?? rest.title}
        aria-describedby={disabledReason ? reasonId : rest['aria-describedby']}
        aria-busy={loading || undefined}
        className={`btn-${variant} ${small ? 'btn-sm' : ''} ${className}`}
      >
        {loading ? <Spinner /> : null}
        {children}
      </button>
      {disabledReason ? (
        <span id={reasonId} className="sr-only">
          {disabledReason}
        </span>
      ) : null}
    </>
  );
}

export function Spinner() {
  return <span aria-hidden="true" className="inline-block h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />;
}

/* -------------------------------------------------------------------- Card */
export function Card({ title, actions, children, className = '', as: Tag = 'section' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; as?: 'section' | 'div' | 'article' }) {
  return (
    <Tag className={`card ${className}`}>
      {title || actions ? (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title ? <h2 className="text-lg font-semibold">{title}</h2> : <span />}
          {actions}
        </div>
      ) : null}
      {children}
    </Tag>
  );
}

export function PageHeader({ title, description, actions }: { title: string; description?: ReactNode; actions?: ReactNode }) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-3xl font-semibold">{title}</h1>
        {description ? <p className="mt-1 max-w-prose text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
    </header>
  );
}

/* ------------------------------------------------------------------- Badge */
const TONE_CLASS: Record<Tone, string> = {
  neutral: 'border-line bg-sunken text-ink',
  info: 'border-info/50 bg-info/10 text-info',
  ok: 'border-ok/50 bg-ok/10 text-ok',
  warn: 'border-warn/50 bg-warn/10 text-warn',
  danger: 'border-danger/50 bg-danger/10 text-danger',
  sim: 'border-sim/50 bg-sim/10 text-sim',
};
export function Badge({ tone = 'neutral', glyph, children, title }: { tone?: Tone; glyph?: string; children: ReactNode; title?: string }) {
  return (
    <span className={`badge ${TONE_CLASS[tone]}`} title={title}>
      {glyph ? (
        <span aria-hidden="true" className="font-mono">
          {glyph}
        </span>
      ) : null}
      {children}
    </span>
  );
}

/* ------------------------------------------------------------ states */
export function Skeleton({ className = 'h-4 w-full' }: { className?: string }) {
  return <div className={`skeleton ${className}`} aria-hidden="true" />;
}
export function SkeletonBlock({ rows = 4, label = 'Loading' }: { rows?: number; label?: string }) {
  return (
    <div role="status" aria-busy="true" className="space-y-3">
      <span className="sr-only">{label}&hellip;</span>
      {Array.from({ length: rows }, (_, i) => (
        <Skeleton key={i} className={`h-5 ${i % 3 === 2 ? 'w-2/3' : 'w-full'}`} />
      ))}
    </div>
  );
}
export function EmptyState({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed border-line px-6 py-10 text-center">
      <p className="font-display text-lg font-semibold">{title}</p>
      {children ? <div className="mx-auto mt-1 max-w-md text-sm text-muted">{children}</div> : null}
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  );
}
export function ErrorState({ error, onRetry, title = 'Could not load this' }: { error: unknown; onRetry?: () => void; title?: string }) {
  return (
    <div role="alert" className="rounded-lg border border-danger/60 bg-danger/10 p-4 text-sm">
      <p className="font-semibold text-danger">{title}</p>
      <p className="mt-1">{errorMessage(error)}</p>
      {isApiError(error) ? <p className="mt-1 font-mono text-xs text-muted">{error.code}</p> : null}
      {onRetry ? (
        <Button className="mt-3" small onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
export function Notice({ tone = 'info', title, children }: { tone?: 'info' | 'warn' | 'danger' | 'ok' | 'sim'; title?: string; children: ReactNode }) {
  const cls = { info: 'border-info/50 bg-info/10', warn: 'border-warn/60 bg-warn/10', danger: 'border-danger/60 bg-danger/10', ok: 'border-ok/50 bg-ok/10', sim: 'border-sim/50 bg-sim/10' }[tone];
  const glyph = { info: 'i', warn: '!', danger: '✕', ok: '✓', sim: '◇' }[tone];
  return (
    <div role={tone === 'danger' ? 'alert' : 'note'} className={`flex gap-3 rounded-md border p-3 text-sm ${cls}`}>
      <span aria-hidden="true" className="font-mono font-bold">
        {glyph}
      </span>
      <div>
        {title ? <p className="font-semibold">{title}</p> : null}
        <div>{children}</div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ fields */
export function TextField({
  label,
  hint,
  error,
  className = '',
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; error?: string | null }) {
  const id = useId();
  const hintId = `${id}-hint`;
  const errId = `${id}-err`;
  return (
    <div className={className}>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={[hint ? hintId : '', error ? errId : ''].filter(Boolean).join(' ') || undefined}
        {...rest}
      />
      {hint ? (
        <p id={hintId} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errId} className="mt-1 text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function SelectField({
  label,
  hint,
  error,
  className = '',
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement> & { label: string; hint?: ReactNode; error?: string | null }) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="label">
        {label}
      </label>
      <select
        id={id}
        className="input"
        aria-invalid={error ? true : undefined}
        aria-describedby={[hint ? `${id}-hint` : '', error ? `${id}-err` : ''].filter(Boolean).join(' ') || undefined}
        {...rest}
      >
        {children}
      </select>
      {hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-err`} className="mt-1 text-xs font-medium text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function CheckboxField({ label, hint, checked, onChange, disabled }: { label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  const id = useId();
  return (
    <div className="flex items-start gap-3">
      <input id={id} type="checkbox" className="mt-1 h-4 w-4 accent-accent" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-describedby={hint ? `${id}-hint` : undefined} />
      <div>
        <label htmlFor={id} className="text-sm font-medium">
          {label}
        </label>
        {hint ? (
          <p id={`${id}-hint`} className="text-xs text-muted">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- progress */
export function ProgressBar({ value, label, tone = 'accent', className = '' }: { value: number; label: string; tone?: 'accent' | 'ok' | 'warn' | 'danger'; className?: string }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const bar = { accent: 'bg-accent', ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger' }[tone];
  return (
    <div className={className}>
      <div role="progressbar" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} className="h-2.5 w-full overflow-hidden rounded-full bg-sunken">
        <div className={`h-full ${bar} transition-[width] duration-200`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- modal */
export function Modal({ open, title, onClose, children, footer, wide }: { open: boolean; title: string; onClose: () => void; children: ReactNode; footer?: ReactNode; wide?: boolean }) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onClose={onClose}
      onClick={(e) => {
        if (e.target === ref.current) onClose();
      }}
      className={`w-[calc(100%-2rem)] ${wide ? 'max-w-2xl' : 'max-w-md'} rounded-lg border border-line bg-surface p-0 text-ink shadow-card`}
    >
      {open ? (
        <div className="p-5">
          <h2 id={titleId} className="text-xl font-semibold">
            {title}
          </h2>
          <div className="mt-3 space-y-3 text-sm">{children}</div>
          {footer ? <div className="mt-5 flex flex-wrap justify-end gap-2">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}

/** Confirm dialog. `requireAck` adds a checkbox that must be ticked (used for the stronger in-use warning). */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  cancelLabel = 'Cancel',
  tone = 'danger',
  pending,
  requireAck,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: 'danger' | 'primary';
  pending?: boolean;
  requireAck?: string;
  onConfirm: () => void | Promise<void>;
  onClose: () => void;
}) {
  const [ack, setAck] = useState(false);
  useEffect(() => {
    if (!open) setAck(false);
  }, [open]);
  return (
    <Modal
      open={open}
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant={tone} loading={pending} disabledReason={requireAck && !ack ? 'Tick the box to confirm.' : null} onClick={() => void onConfirm()}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      {children}
      {requireAck ? <CheckboxField label={requireAck} checked={ack} onChange={setAck} /> : null}
    </Modal>
  );
}

/* -------------------------------------------------------------- pagination */
export function Pagination({ page, pageSize, total, onPage }: { page: number; pageSize: number; total: number; onPage: (p: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <nav aria-label="Pagination" className="mt-4 flex flex-wrap items-center justify-between gap-2 text-sm">
      <p className="text-muted" aria-live="polite">
        Page {page} of {pages} &middot; {total} total
      </p>
      <div className="flex gap-2">
        <Button small onClick={() => onPage(page - 1)} disabledReason={page <= 1 ? 'You are on the first page.' : null}>
          Previous
        </Button>
        <Button small onClick={() => onPage(page + 1)} disabledReason={page >= pages ? 'You are on the last page.' : null}>
          Next
        </Button>
      </div>
    </nav>
  );
}

export function StatTile({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: string; tone?: Tone }) {
  const color = tone === 'danger' ? 'text-danger' : tone === 'sim' ? 'text-sim' : tone === 'ok' ? 'text-ok' : '';
  return (
    <div className="rounded-lg border border-line bg-surface p-4">
      <p className="text-xs font-semibold uppercase tracking-wide text-muted">{label}</p>
      <p className={`mt-1 font-display text-3xl font-semibold tabular-nums ${color}`}>{value}</p>
      {hint ? <p className="mt-1 text-xs text-muted">{hint}</p> : null}
    </div>
  );
}
