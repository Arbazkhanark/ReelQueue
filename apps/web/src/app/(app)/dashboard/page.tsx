'use client';

import Link from 'next/link';
import { POLL_MS, useApi } from '@/lib/use-api';
import { useNow } from '@/lib/use-now';
import { formatBytes, formatDateTime, formatCountdown } from '@/lib/format';
import { effectiveCycleStatus, isLiveCycle } from '@/lib/cycle-ui';
import { Card, EmptyState, ErrorState, Notice, PageHeader, ProgressBar, SkeletonBlock, StatTile } from '@/components/ui';
import { AccountStatusBadge } from '@/components/status';

export default function DashboardPage() {
  const q = useApi('dashboard', { refreshMs: POLL_MS });
  const now = useNow();
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={() => void q.reload()} />;
  if (!q.data) return <SkeletonBlock />;
  const d = q.data;
  const c = d.currentCycle;
  const live = isLiveCycle(c, now) ? c : null;
  const steps = [
    { done: d.accounts.length > 0, label: 'Connect an Instagram account', href: '/accounts' },
    { done: d.totals.readyVideos > 0, label: 'Upload videos', href: '/uploads' },
    { done: !!c, label: 'Start a publishing cycle', href: '/cycles' },
  ];
  return (
    <>
      <PageHeader title="Dashboard" description="Where your queue stands right now." />
      {steps.some((s) => !s.done) ? (
        <Card title="Get started" className="mb-4">
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {steps.map((s) => <li key={s.href} className={s.done ? 'text-muted line-through' : ''}><Link href={s.href} className="underline">{s.label}</Link></li>)}
          </ol>
        </Card>
      ) : null}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatTile label="Ready videos" value={d.totals.readyVideos} />
        <StatTile label="Published" value={d.totals.published} tone="ok" hint="Accepted or confirmed by Instagram" />
        <StatTile label="Simulated" value={d.totals.simulated} tone="sim" hint="Mock mode only" />
        <StatTile label="Failed" value={d.totals.failed} tone={d.totals.failed ? 'danger' : undefined} />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card title="Current cycle" actions={<Link href="/cycles" className="text-sm underline">Manage</Link>}>
          {c ? (
            <div className="space-y-2 text-sm">
              <p><strong>{effectiveCycleStatus(c, now)}</strong>{c.isMock ? ' · simulation' : ''} · {c.batchSize} per batch every {c.intervalMinutes} min{c.loopEnabled ? ' · looping' : ''}</p>
              {live && c.nextBatchAt && live.status === 'ACTIVE' ? <p>Next batch {formatDateTime(c.nextBatchAt)}{now ? ` (in ${formatCountdown(Date.parse(c.nextBatchAt) - now)})` : ''}</p> : null}
              <p className="text-muted">Window ends {formatDateTime(c.endsAt)}</p>
              <p>Queued {c.counts.queued} · pending {c.counts.pending} · published {c.counts.published} · simulated {c.counts.simulated} · failed {c.counts.failed}</p>
              {c.warnings.map((w) => <Notice key={w.code} tone="warn">{w.message}</Notice>)}
            </div>
          ) : <EmptyState title="No cycle yet">Start one from the Cycles page.</EmptyState>}
        </Card>
        <Card title="Storage">
          <ProgressBar value={d.storage.percentUsed / 100} label="Storage used" tone={d.storage.level === 'OK' ? 'accent' : d.storage.level === 'WARNING' ? 'warn' : 'danger'} />
          <p className="mt-2 text-sm">{formatBytes(d.storage.bytesUsed)} of {formatBytes(d.storage.quotaBytes)} · {d.storage.videoCount} / {d.storage.maxVideos} videos</p>
          {d.storage.level !== 'OK' ? <div className="mt-2"><Notice tone={d.storage.level === 'FULL' ? 'danger' : 'warn'}>{d.storage.level === 'FULL' ? 'Storage is full: uploads are blocked.' : 'Storage is almost full.'}</Notice></div> : null}
        </Card>
        <Card title="Instagram accounts" className="md:col-span-2">
          {d.accounts.length === 0 ? <EmptyState title="No accounts">Connect one on the Accounts page.</EmptyState> : (
            <ul className="divide-y divide-line text-sm">
              {d.accounts.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span>@{a.username ?? 'unknown'}{a.isMock ? ' (mock)' : ''}</span>
                  <span className="flex items-center gap-3"><span className="text-muted">{a.quota ? `${a.quota.remaining} of ${a.quota.total} posts left` : 'quota unknown'}</span><AccountStatusBadge status={a.status} /></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </>
  );
}
