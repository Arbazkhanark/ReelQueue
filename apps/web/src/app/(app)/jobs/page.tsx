// apps/web/src/app/\(app\)/jobs/page.tsx
'use client';

import { useState } from 'react';
import { call, errorMessage } from '@/lib/api';
import { invalidate, POLL_MS, useApi } from '@/lib/use-api';
import { formatDateTime } from '@/lib/format';
import { JOB_STATUS_INFO } from '@/lib/job-status';
import type { JobStatus } from '@reelqueue/shared';
import { Button, Card, EmptyState, ErrorState, Notice, PageHeader, Pagination, SelectField, SkeletonBlock } from '@/components/ui';
import { JobStatusBadge } from '@/components/status';
import { useToast } from '@/components/toast';

const PAGE_SIZE = 20;

export default function JobsPage() {
  const toast = useToast();
  const [page, setPage] = useState(1);
  const [status, setStatus] = useState<JobStatus | ''>('');
  const upcoming = useApi('upcomingJobs', { refreshMs: POLL_MS });
  const q = useApi('listJobs', { query: { page, pageSize: PAGE_SIZE, ...(status ? { status } : {}) }, refreshMs: POLL_MS });
  const [busy, setBusy] = useState<string | null>(null);

  async function retry(id: string) {
    setBusy(id);
    try { await call('retryJob', { params: { id } }); invalidate('listJobs', 'upcomingJobs', 'currentCycle'); toast.success('Job queued for retry.'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setBusy(null); }
  }

  return (
    <>
      <PageHeader title="Publishing jobs" description="What is scheduled, what Instagram accepted, and what was only simulated." />
      <Notice tone="info">“Scheduled” is only our intent. “API accepted” means Instagram’s API accepted the post; “Confirmed” means it was verified. In simulation mode, results are “Simulated” and nothing is published.</Notice>
      <Card title="Upcoming" className="mt-4">
        {!upcoming.data ? <SkeletonBlock rows={2} /> : upcoming.data.length === 0 ? <p className="text-sm text-muted">Nothing scheduled.</p> : (
          <ul className="divide-y divide-line text-sm">
            {upcoming.data.map((j) => <li key={j.id} className="flex flex-wrap justify-between gap-2 py-2"><span className="break-all">{j.videoFilename ?? j.videoId}</span><span className="text-muted">{formatDateTime(j.nextAttemptAt)}</span></li>)}
          </ul>
        )}
      </Card>
      <Card title="History" className="mt-4" actions={
        <SelectField label="Status" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value as JobStatus | ''); }}>
          <option value="">All</option>
          {(Object.keys(JOB_STATUS_INFO) as JobStatus[]).map((k) => <option key={k} value={k}>{JOB_STATUS_INFO[k].label}</option>)}
        </SelectField>}>
        {q.error && !q.data ? <ErrorState error={q.error} onRetry={() => void q.reload()} /> : !q.data ? <SkeletonBlock /> : q.data.items.length === 0 ? <EmptyState title="No jobs yet" /> : (
          <>
            <ul className="divide-y divide-line text-sm">
              {q.data.items.map((j) => (
                <li key={j.id} className="flex flex-wrap items-start justify-between gap-2 py-3">
                  <div className="min-w-0">
                    <p className="break-all font-medium">#{j.sequenceNo} {j.videoFilename ?? j.videoId}</p>
                    <p className="text-xs text-muted">iteration {j.iteration} · attempts {j.attemptCount} · {formatDateTime(j.updatedAt)}{j.isMock ? ' · simulation' : ''}</p>
                    {j.deferredReason ? <p className="text-xs text-warn">{j.deferredReason}</p> : null}
                    {j.failureReason ? <p className="text-xs text-danger">{j.failureReason}{j.lastErrorCode ? ` (${j.lastErrorCode})` : ''}</p> : null}
                    {j.permalink ? <a href={j.permalink} target="_blank" rel="noopener noreferrer" className="text-xs underline">View on Instagram</a> : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <JobStatusBadge status={j.status} />
                    {j.status === 'FAILED' && j.retryable ? <Button small loading={busy === j.id} onClick={() => void retry(j.id)}>Retry</Button> : null}
                  </div>
                </li>
              ))}
            </ul>
            <Pagination page={page} pageSize={PAGE_SIZE} total={q.data.total} onPage={setPage} />
          </>
        )}
      </Card>
    </>
  );
}
