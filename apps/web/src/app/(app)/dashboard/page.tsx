// // apps/web/src/app/\(app\)/dashboard/page.tsx
// 'use client';

// import Link from 'next/link';
// import { POLL_MS, useApi } from '@/lib/use-api';
// import { useNow } from '@/lib/use-now';
// import { formatBytes, formatDateTime, formatCountdown } from '@/lib/format';
// import { effectiveCycleStatus, isLiveCycle } from '@/lib/cycle-ui';
// import { Card, EmptyState, ErrorState, Notice, PageHeader, ProgressBar, SkeletonBlock, StatTile } from '@/components/ui';
// import { AccountStatusBadge } from '@/components/status';

// export default function DashboardPage() {
//   const q = useApi('dashboard', { refreshMs: POLL_MS });
//   const now = useNow();
//   if (q.error && !q.data) return <ErrorState error={q.error} onRetry={() => void q.reload()} />;
//   if (!q.data) return <SkeletonBlock />;
//   const d = q.data;
//   const c = d.currentCycle;
//   const live = isLiveCycle(c, now) ? c : null;
//   const steps = [
//     { done: d.accounts.length > 0, label: 'Connect an Instagram account', href: '/accounts' },
//     { done: d.totals.readyVideos > 0, label: 'Upload videos', href: '/uploads' },
//     { done: !!c, label: 'Start a publishing cycle', href: '/cycles' },
//   ];
//   return (
//     <>
//       <PageHeader title="Dashboard" description="Where your queue stands right now." />
//       {steps.some((s) => !s.done) ? (
//         <Card title="Get started" className="mb-4">
//           <ol className="list-decimal space-y-1 pl-5 text-sm">
//             {steps.map((s) => <li key={s.href} className={s.done ? 'text-muted line-through' : ''}><Link href={s.href} className="underline">{s.label}</Link></li>)}
//           </ol>
//         </Card>
//       ) : null}
//       <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4">
//         <StatTile label="Ready videos" value={d.totals.readyVideos} />
//         <StatTile label="Published" value={d.totals.published} tone="ok" hint="Accepted or confirmed by Instagram" />
//         <StatTile label="Simulated" value={d.totals.simulated} tone="sim" hint="Mock mode only" />
//         <StatTile label="Failed" value={d.totals.failed} tone={d.totals.failed ? 'danger' : undefined} />
//       </div>
//       <div className="grid gap-4 md:grid-cols-2">
//         <Card title="Current cycle" actions={<Link href="/cycles" className="text-sm underline">Manage</Link>}>
//           {c ? (
//             <div className="space-y-2 text-sm">
//               <p><strong>{effectiveCycleStatus(c, now)}</strong>{c.isMock ? ' · simulation' : ''} · {c.batchSize} per batch every {c.intervalMinutes} min{c.loopEnabled ? ' · looping' : ''}</p>
//               {live && c.nextBatchAt && live.status === 'ACTIVE' ? <p>Next batch {formatDateTime(c.nextBatchAt)}{now ? ` (in ${formatCountdown(Date.parse(c.nextBatchAt) - now)})` : ''}</p> : null}
//               <p className="text-muted">Window ends {formatDateTime(c.endsAt)}</p>
//               <p>Queued {c.counts.queued} · pending {c.counts.pending} · published {c.counts.published} · simulated {c.counts.simulated} · failed {c.counts.failed}</p>
//               {c.warnings.map((w) => <Notice key={w.code} tone="warn">{w.message}</Notice>)}
//             </div>
//           ) : <EmptyState title="No cycle yet">Start one from the Cycles page.</EmptyState>}
//         </Card>
//         <Card title="Storage">
//           <ProgressBar value={d.storage.percentUsed / 100} label="Storage used" tone={d.storage.level === 'OK' ? 'accent' : d.storage.level === 'WARNING' ? 'warn' : 'danger'} />
//           <p className="mt-2 text-sm">{formatBytes(d.storage.bytesUsed)} of {formatBytes(d.storage.quotaBytes)} · {d.storage.videoCount} / {d.storage.maxVideos} videos</p>
//           {d.storage.level !== 'OK' ? <div className="mt-2"><Notice tone={d.storage.level === 'FULL' ? 'danger' : 'warn'}>{d.storage.level === 'FULL' ? 'Storage is full: uploads are blocked.' : 'Storage is almost full.'}</Notice></div> : null}
//         </Card>
//         <Card title="Instagram accounts" className="md:col-span-2">
//           {d.accounts.length === 0 ? <EmptyState title="No accounts">Connect one on the Accounts page.</EmptyState> : (
//             <ul className="divide-y divide-line text-sm">
//               {d.accounts.map((a) => (
//                 <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
//                   <span>@{a.username ?? 'unknown'}{a.isMock ? ' (mock)' : ''}</span>
//                   <span className="flex items-center gap-3"><span className="text-muted">{a.quota ? `${a.quota.remaining} of ${a.quota.total} posts left` : 'quota unknown'}</span><AccountStatusBadge status={a.status} /></span>
//                 </li>
//               ))}
//             </ul>
//           )}
//         </Card>
//       </div>
//     </>
//   );
// }





















// apps/web/src/app/(app)/dashboard/page.tsx
'use client';

import Link from 'next/link';
import { POLL_MS, useApi } from '@/lib/use-api';
import { useNow } from '@/lib/use-now';
import {
  formatBytes,
  formatDateTime,
  formatCountdown,
} from '@/lib/format';
import {
  effectiveCycleStatus,
  isLiveCycle,
} from '@/lib/cycle-ui';
import {
  Card,
  EmptyState,
  ErrorState,
  Notice,
  PageHeader,
  ProgressBar,
  SkeletonBlock,
  StatTile,
} from '@/components/ui';
import { AccountStatusBadge } from '@/components/status';

function ArrowIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      className="h-4 w-4"
      aria-hidden="true"
    >
      <path
        d="M5 12h14m-6-6 6 6-6 6"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function DashboardIcon({ type }: { type: 'video' | 'check' | 'play' | 'alert' }) {
  const paths = {
    video: (
      <>
        <rect x="3" y="5" width="18" height="14" rx="3" />
        <path d="m10 9 5 3-5 3z" />
      </>
    ),
    check: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m8 12 2.5 2.5L16 9" />
      </>
    ),
    play: (
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="m10 8 6 4-6 4z" />
      </>
    ),
    alert: (
      <>
        <path d="M10.3 4.4 2.8 17.3A2 2 0 0 0 4.5 20h15a2 2 0 0 0 1.7-2.7L13.7 4.4a2 2 0 0 0-3.4 0Z" />
        <path d="M12 9v4m0 3h.01" />
      </>
    ),
  };

  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="h-5 w-5"
      aria-hidden="true"
    >
      {paths[type]}
    </svg>
  );
}

function QuickAction({
  href,
  title,
  description,
  icon,
}: {
  href: string;
  title: string;
  description: string;
  icon: React.ReactNode;
}) {
  return (
    <Link
      href={href}
      className="group flex min-w-0 items-center gap-3 rounded-2xl border border-line bg-bg p-4 transition duration-200 hover:-translate-y-0.5 hover:border-orange-500/40 hover:shadow-md"
    >
      <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-orange-500/10 text-orange-500 transition group-hover:bg-orange-500 group-hover:text-white">
        {icon}
      </span>

      <span className="min-w-0 flex-1">
        <span className="block font-semibold">{title}</span>
        <span className="mt-1 block text-xs leading-5 text-muted">
          {description}
        </span>
      </span>

      <span className="text-muted transition group-hover:translate-x-1 group-hover:text-orange-500">
        <ArrowIcon />
      </span>
    </Link>
  );
}

export default function DashboardPage() {
  const q = useApi('dashboard', { refreshMs: POLL_MS });
  const now = useNow();

  if (q.error && !q.data) {
    return <ErrorState error={q.error} onRetry={() => void q.reload()} />;
  }

  if (!q.data) {
    return <SkeletonBlock />;
  }

  const d = q.data;
  const c = d.currentCycle;
  const live = isLiveCycle(c, now) ? c : null;

  const steps = [
    {
      done: d.accounts.length > 0,
      label: 'Connect an Instagram account',
      href: '/accounts',
      number: '01',
    },
    {
      done: d.totals.readyVideos > 0,
      label: 'Upload videos',
      href: '/uploads',
      number: '02',
    },
    {
      done: !!c,
      label: 'Start a publishing cycle',
      href: '/cycles',
      number: '03',
    },
  ];

  const progress = (steps.filter((step) => step.done).length / steps.length) * 100;

  return (
    <div className="space-y-6 pb-8">
      {/* Header */}
      <div className="relative overflow-hidden rounded-3xl border border-line bg-bg p-5 sm:p-7 lg:p-8">
        <div
          className="pointer-events-none absolute -right-12 -top-20 h-56 w-56 rounded-full bg-orange-500/10 blur-3xl"
          aria-hidden="true"
        />

        <div className="relative flex flex-col justify-between gap-5 sm:flex-row sm:items-center">
          <div className="min-w-0">
            <div className="mb-3 inline-flex items-center gap-2 rounded-full border border-orange-500/20 bg-orange-500/5 px-3 py-1.5 text-xs font-semibold text-orange-600 dark:text-orange-400">
              <span className="h-1.5 w-1.5 rounded-full bg-orange-500" />
              YOUR WORKSPACE
            </div>

            <PageHeader
              title="Dashboard"
              description="Your content, publishing activity, and account health — all in one place."
            />
          </div>

          <Link
            href="/uploads"
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-xl bg-orange-600 px-5 py-3 text-sm font-semibold text-white shadow-sm transition hover:bg-orange-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500 focus-visible:ring-offset-2"
          >
            <DashboardIcon type="video" />
            Upload videos
            <ArrowIcon />
          </Link>
        </div>
      </div>

      {/* Statistics */}
      <section aria-label="Publishing statistics">
        <div className="mb-3 flex items-center justify-between gap-3">
          <h2 className="text-sm font-semibold tracking-wide">
            Publishing overview
          </h2>
          <span className="text-xs text-muted">Current totals</span>
        </div>

        <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
          <div className="min-w-0 rounded-2xl border border-line bg-bg p-3 transition hover:shadow-sm sm:p-4">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-orange-500/10 text-orange-500">
              <DashboardIcon type="video" />
            </div>
            <StatTile
              label="Ready videos"
              value={d.totals.readyVideos}
            />
            <p className="mt-1 text-xs text-muted">Ready for your queue</p>
          </div>

          <div className="min-w-0 rounded-2xl border border-line bg-bg p-3 transition hover:shadow-sm sm:p-4">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-emerald-500/10 text-emerald-600">
              <DashboardIcon type="check" />
            </div>
            <StatTile
              label="Published"
              value={d.totals.published}
              tone="ok"
              hint="Accepted or confirmed by Instagram"
            />
            <p className="mt-1 text-xs text-muted">Accepted or confirmed</p>
          </div>

          <div className="min-w-0 rounded-2xl border border-line bg-bg p-3 transition hover:shadow-sm sm:p-4">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-sky-500/10 text-sky-600">
              <DashboardIcon type="play" />
            </div>
            <StatTile
              label="Simulated"
              value={d.totals.simulated}
              tone="sim"
              hint="Mock mode only"
            />
            <p className="mt-1 text-xs text-muted">Simulation mode only</p>
          </div>

          <div className="min-w-0 rounded-2xl border border-line bg-bg p-3 transition hover:shadow-sm sm:p-4">
            <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-xl bg-rose-500/10 text-rose-600">
              <DashboardIcon type="alert" />
            </div>
            <StatTile
              label="Failed"
              value={d.totals.failed}
              tone={d.totals.failed ? 'danger' : undefined}
            />
            <p className="mt-1 text-xs text-muted">Failed publishing attempts</p>
          </div>
        </div>
      </section>

      {/* Quick actions */}
      <section>
        <div className="mb-3">
          <h2 className="text-sm font-semibold tracking-wide">Quick actions</h2>
          <p className="mt-1 text-xs text-muted">
            Pick up where you left off.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          <QuickAction
            href="/uploads"
            title="Upload content"
            description="Add videos to your publishing library"
            icon={<DashboardIcon type="video" />}
          />

          <QuickAction
            href="/cycles"
            title="Manage cycles"
            description="Configure your publishing schedule"
            icon={<DashboardIcon type="play" />}
          />

          <QuickAction
            href="/accounts"
            title="Instagram accounts"
            description="Review your connected accounts"
            icon={<DashboardIcon type="check" />}
          />
        </div>
      </section>

      {/* Setup checklist */}
      {steps.some((step) => !step.done) ? (
        <section className="rounded-2xl border border-line bg-bg p-5 sm:p-6">
          <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-widest text-orange-600 dark:text-orange-400">
                Getting started
              </p>
              <h2 className="mt-2 text-lg font-bold">Set up your workspace</h2>
              <p className="mt-1 text-sm text-muted">
                Complete these steps to get ready for publishing.
              </p>
            </div>

            <span className="w-fit rounded-full bg-sunken px-3 py-1.5 text-xs font-semibold">
              {steps.filter((step) => step.done).length} of {steps.length} complete
            </span>
          </div>

          <div className="mt-5 h-2 overflow-hidden rounded-full bg-sunken">
            <div
              className="h-full rounded-full bg-orange-500 transition-all duration-500"
              style={{ width: `${progress}%` }}
            />
          </div>

          <ol className="mt-5 space-y-2">
            {steps.map((step) => (
              <li key={step.href}>
                <Link
                  href={step.href}
                  className="group flex items-center gap-3 rounded-xl border border-transparent p-3 transition hover:border-line hover:bg-sunken/50"
                >
                  <span
                    className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-xs font-bold ${
                      step.done
                        ? 'bg-emerald-500/10 text-emerald-600'
                        : 'bg-sunken text-muted'
                    }`}
                  >
                    {step.done ? (
                      <DashboardIcon type="check" />
                    ) : (
                      step.number
                    )}
                  </span>

                  <span
                    className={`min-w-0 flex-1 text-sm font-medium ${
                      step.done ? 'text-muted line-through' : ''
                    }`}
                  >
                    {step.label}
                  </span>

                  <span className="text-muted transition group-hover:translate-x-1 group-hover:text-orange-500">
                    <ArrowIcon />
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      {/* Main dashboard panels */}
      <div className="grid min-w-0 gap-4 xl:grid-cols-2">
        {/* Current cycle */}
        <Card
          title="Current cycle"
          actions={
            <Link
              href="/cycles"
              className="inline-flex items-center gap-1.5 text-sm font-medium text-orange-600 transition hover:text-orange-700 dark:text-orange-400"
            >
              Manage
              <ArrowIcon />
            </Link>
          }
        >
          {c ? (
            <div className="space-y-5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center rounded-full border border-line bg-sunken px-3 py-1 text-xs font-semibold">
                  {effectiveCycleStatus(c, now)}
                </span>

                {c.isMock ? (
                  <span className="inline-flex items-center rounded-full bg-sky-500/10 px-3 py-1 text-xs font-semibold text-sky-700 dark:text-sky-300">
                    Simulation
                  </span>
                ) : null}

                {c.loopEnabled ? (
                  <span className="inline-flex items-center rounded-full bg-orange-500/10 px-3 py-1 text-xs font-semibold text-orange-700 dark:text-orange-300">
                    Loop enabled
                  </span>
                ) : null}
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-sunken/60 p-3">
                  <p className="text-xs text-muted">Batch size</p>
                  <p className="mt-1 text-xl font-bold">{c.batchSize}</p>
                  <p className="mt-1 text-xs text-muted">Videos per batch</p>
                </div>

                <div className="rounded-xl bg-sunken/60 p-3">
                  <p className="text-xs text-muted">Interval</p>
                  <p className="mt-1 text-xl font-bold">
                    {c.intervalMinutes}
                    <span className="ml-1 text-sm font-medium text-muted">min</span>
                  </p>
                  <p className="mt-1 text-xs text-muted">Between batches</p>
                </div>
              </div>

              {live && c.nextBatchAt && live.status === 'ACTIVE' ? (
                <div className="rounded-xl border border-orange-500/20 bg-orange-500/5 p-4">
                  <p className="text-xs font-semibold uppercase tracking-wide text-orange-600 dark:text-orange-400">
                    Next scheduled batch
                  </p>
                  <p className="mt-2 text-base font-bold">
                    {formatDateTime(c.nextBatchAt)}
                  </p>
                  {now ? (
                    <p className="mt-1 text-sm text-muted">
                      In {formatCountdown(Date.parse(c.nextBatchAt) - now)}
                    </p>
                  ) : null}
                </div>
              ) : null}

              <div className="border-t border-line pt-4">
                <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">
                  Publishing window
                </p>
                <p className="text-sm">
                  Ends {formatDateTime(c.endsAt)}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {[
                  ['Queued', c.counts.queued],
                  ['Pending', c.counts.pending],
                  ['Published', c.counts.published],
                  ['Simulated', c.counts.simulated],
                  ['Failed', c.counts.failed],
                ].map(([label, value]) => (
                  <div
                    key={label}
                    className="rounded-xl border border-line p-3"
                  >
                    <p className="text-xs text-muted">{label}</p>
                    <p className="mt-1 text-lg font-bold">{value}</p>
                  </div>
                ))}
              </div>

              {c.warnings.map((w) => (
                <Notice key={w.code} tone="warn">
                  {w.message}
                </Notice>
              ))}
            </div>
          ) : (
            <EmptyState title="No cycle yet">
              Start one from the Cycles page.
              <div className="mt-3">
                <Link
                  href="/cycles"
                  className="inline-flex items-center gap-2 rounded-xl bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-orange-700"
                >
                  Set up a cycle
                  <ArrowIcon />
                </Link>
              </div>
            </EmptyState>
          )}
        </Card>

        {/* Storage */}
        <Card title="Storage">
          <div className="space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <p className="text-sm text-muted">Used storage</p>
                <p className="mt-1 text-2xl font-bold tracking-tight">
                  {formatBytes(d.storage.bytesUsed)}
                </p>
                <p className="mt-1 text-xs text-muted">
                  of {formatBytes(d.storage.quotaBytes)} available
                </p>
              </div>

              <Link
                href="/storage"
                className="inline-flex items-center gap-1.5 rounded-xl border border-line px-3 py-2 text-xs font-semibold transition hover:bg-sunken"
              >
                Manage
                <ArrowIcon />
              </Link>
            </div>

            <ProgressBar
              value={d.storage.percentUsed / 100}
              label="Storage used"
              tone={
                d.storage.level === 'OK'
                  ? 'accent'
                  : d.storage.level === 'WARNING'
                    ? 'warn'
                    : 'danger'
              }
            />

            <div className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted">Storage utilization</span>
              <span className="font-semibold">
                {d.storage.percentUsed}%
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div className="rounded-xl border border-line p-4">
                <p className="text-xs text-muted">Videos stored</p>
                <p className="mt-1 text-xl font-bold">
                  {d.storage.videoCount}
                </p>
              </div>

              <div className="rounded-xl border border-line p-4">
                <p className="text-xs text-muted">Video limit</p>
                <p className="mt-1 text-xl font-bold">
                  {d.storage.maxVideos}
                </p>
              </div>
            </div>

            {d.storage.level !== 'OK' ? (
              <Notice
                tone={d.storage.level === 'FULL' ? 'danger' : 'warn'}
              >
                {d.storage.level === 'FULL'
                  ? 'Storage is full: uploads are blocked.'
                  : 'Storage is almost full.'}
              </Notice>
            ) : (
              <div className="flex items-center gap-2 rounded-xl bg-emerald-500/5 p-3 text-sm text-emerald-700 dark:text-emerald-300">
                <DashboardIcon type="check" />
                Storage is within your current limit.
              </div>
            )}
          </div>
        </Card>
      </div>

      {/* Instagram accounts */}
      <Card
        title="Instagram accounts"
        actions={
          <Link
            href="/accounts"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-orange-600 transition hover:text-orange-700 dark:text-orange-400"
          >
            View all
            <ArrowIcon />
          </Link>
        }
      >
        {d.accounts.length === 0 ? (
          <EmptyState title="No accounts">
            Connect an Instagram account from the Accounts page.
            <div className="mt-3">
              <Link
                href="/accounts"
                className="inline-flex items-center gap-2 rounded-xl bg-orange-600 px-4 py-2.5 text-sm font-semibold text-white transition hover:bg-orange-700"
              >
                Connect account
                <ArrowIcon />
              </Link>
            </div>
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {d.accounts.map((a) => (
              <li
                key={a.id}
                className="flex flex-col gap-3 py-4 first:pt-0 last:pb-0 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-orange-500/10 text-sm font-bold text-orange-600 dark:text-orange-400">
                    {(a.username ?? 'IG').replace(/^@/, '').slice(0, 2).toUpperCase()}
                  </div>

                  <div className="min-w-0">
                    <p className="break-all text-sm font-semibold">
                      @{a.username ?? 'unknown'}
                    </p>
                    <p className="mt-1 text-xs text-muted">
                      {a.isMock ? 'Simulation account' : 'Instagram account'}
                    </p>
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-3 sm:justify-end">
                  <span className="text-xs text-muted">
                    {a.quota
                      ? `${a.quota.remaining} of ${a.quota.total} posts left`
                      : 'Quota unknown'}
                  </span>
                  <AccountStatusBadge status={a.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}