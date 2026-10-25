// apps/web/src/app/\(app\)/cycles/page.tsx
'use client';

import { useMemo, useState } from 'react';
import { call, errorMessage, fieldErrors } from '@/lib/api';
import { invalidate, POLL_MS, useApi } from '@/lib/use-api';
import { useNow } from '@/lib/use-now';
import { cycleControls, effectiveCycleStatus } from '@/lib/cycle-ui';
import { validateScheduler } from '@/lib/validate';
import { formatCountdown, formatDateTime } from '@/lib/format';
import { Button, Card, CheckboxField, ConfirmDialog, EmptyState, ErrorState, Notice, PageHeader, SelectField, SkeletonBlock, StatTile, TextField } from '@/components/ui';
import { useToast } from '@/components/toast';

export default function CyclesPage() {
  const toast = useToast();
  const now = useNow();
  const cycle = useApi('currentCycle', { refreshMs: POLL_MS });
  const settings = useApi('getSettings');
  const accounts = useApi('listAccounts');
  const dash = useApi('dashboard', { refreshMs: POLL_MS });
  const history = useApi('listCycles', { query: { page: 1, pageSize: 10 } });

  const [accountId, setAccountId] = useState('');
  const [form, setForm] = useState<{ batchSize: string; intervalMinutes: string; cycleDurationHours: string; loop: boolean } | null>(null);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);

  const s = settings.data;
  const values = form ?? (s ? { batchSize: String(s.batchSize), intervalMinutes: String(s.intervalMinutes), cycleDurationHours: String(s.cycleDurationHours), loop: s.loopEnabled } : null);
  const connected = (accounts.data ?? []).filter((a) => a.status === 'CONNECTED');
  const chosen = connected.find((a) => a.id === accountId) ?? connected.find((a) => a.id === s?.defaultInstagramAccountId) ?? connected[0];
  const validation = useMemo(() => (s && values ? validateScheduler(values, s.limits) : null), [s, values]);
  const c = cycle.data ?? null;
  const ctl = cycleControls({ cycle: c, nowMs: now, account: chosen, readyVideos: dash.data ? dash.data.totals.readyVideos : null, settingsValid: validation?.ok === true, busy });
  const errs = { ...(validation && !validation.ok ? validation.errors : {}), ...serverErrors };

  async function act(fn: () => Promise<unknown>, ok: string) {
    setBusy(true); setServerErrors({});
    try { await fn(); invalidate('currentCycle', 'listCycles', 'dashboard', 'upcomingJobs', 'listJobs'); toast.success(ok); }
    catch (e) { setServerErrors(fieldErrors(e)); toast.error(errorMessage(e)); }
    finally { setBusy(false); }
  }
  const start = () => {
    if (!validation?.ok || !chosen || !values) return;
    void act(() => call('startCycle', { body: { instagramAccountId: chosen.id, batchSize: validation.value.batchSize, intervalMinutes: validation.value.intervalMinutes, durationHours: validation.value.cycleDurationHours, loopEnabled: values.loop } }), 'Cycle started.');
  };

  if (cycle.error && !cycle.data && cycle.data !== null) return <ErrorState error={cycle.error} onRetry={() => void cycle.reload()} />;
  if (!s || !values) return <SkeletonBlock />;
  const eff = c ? effectiveCycleStatus(c, now) : null;
  const live = eff === 'ACTIVE' || eff === 'PAUSED';

  return (
    <>
      <PageHeader title="Publishing cycles" description="One cycle at a time per account: a batch every interval, for up to the cycle duration." />
      {c ? (
        <Card title={`Current cycle · ${eff}`} className="mb-4">
          <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-5">
            <StatTile label="Queued" value={c.counts.queued} />
            <StatTile label="Pending" value={c.counts.pending} />
            <StatTile label="Published" value={c.counts.published} tone="ok" />
            <StatTile label="Simulated" value={c.counts.simulated} tone="sim" />
            <StatTile label="Failed" value={c.counts.failed} tone={c.counts.failed ? 'danger' : undefined} />
          </div>
          <p className="text-sm">{c.batchSize} per batch every {c.intervalMinutes} min · iteration {c.iteration}{c.isMock ? ' · simulation' : ''}</p>
          <p className="text-sm text-muted">Started {formatDateTime(c.startedAt)} · window ends {formatDateTime(c.endsAt)}{c.endedAt ? ` · ended ${formatDateTime(c.endedAt)}${c.endReason ? ` (${c.endReason})` : ''}` : ''}</p>
          {live && eff === 'ACTIVE' && c.nextBatchAt && now ? <p className="text-sm">Next batch in {formatCountdown(Date.parse(c.nextBatchAt) - now)}</p> : null}
          {c.pauseReason ? <p className="text-sm text-warn">Paused: {c.pauseReason}</p> : null}
          <div className="mt-2 space-y-2">{c.warnings.map((w) => <Notice key={w.code} tone="warn">{w.message}</Notice>)}</div>
          {live ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <Button disabled={!ctl.pause.enabled} disabledReason={ctl.pause.reason} loading={busy} onClick={() => void act(() => call('pauseCycle', { params: { id: c.id } }), 'Cycle paused.')}>Pause</Button>
              <Button disabled={!ctl.resume.enabled} disabledReason={ctl.resume.reason} loading={busy} onClick={() => void act(() => call('resumeCycle', { params: { id: c.id } }), 'Cycle resumed.')}>Resume</Button>
              <Button variant="danger" disabled={!ctl.stop.enabled} disabledReason={ctl.stop.reason} onClick={() => setConfirmStop(true)}>Stop</Button>
              <CheckboxField label="Loop when all videos have been published" checked={c.loopEnabled} disabled={busy} onChange={(v) => void act(() => call('updateCycle', { params: { id: c.id }, body: { loopEnabled: v } }), v ? 'Looping on.' : 'Looping off.')} />
            </div>
          ) : null}
        </Card>
      ) : null}
      {!live ? (
        <Card title="Start a cycle" className="mb-4">
          {connected.length === 0 ? <EmptyState title="No connected account">Connect an Instagram account first.</EmptyState> : (
            <div className="grid gap-3 md:grid-cols-2">
              <SelectField label="Instagram account" value={chosen?.id ?? ''} onChange={(e) => setAccountId(e.target.value)}>
                {connected.map((a) => <option key={a.id} value={a.id}>@{a.username}{a.isMock ? ' (mock)' : ''}</option>)}
              </SelectField>
              <TextField label="Batch size" inputMode="numeric" value={values.batchSize} error={errs.batchSize ?? null} onChange={(e) => setForm({ ...values, batchSize: e.target.value })} hint="Videos released per interval." />
              <TextField label="Interval (minutes)" inputMode="numeric" value={values.intervalMinutes} error={errs.intervalMinutes ?? null} onChange={(e) => setForm({ ...values, intervalMinutes: e.target.value })} hint="Time between batch starts." />
              <TextField label="Cycle duration (hours)" inputMode="numeric" value={values.cycleDurationHours} error={errs.cycleDurationHours ?? null} onChange={(e) => setForm({ ...values, cycleDurationHours: e.target.value })} />
              <CheckboxField label="Loop" hint="Start over from the first video once every video has been used." checked={values.loop} onChange={(v) => setForm({ ...values, loop: v })} />
            </div>
          )}
          <div className="mt-3">
            <Button variant="primary" disabled={!ctl.start.enabled} disabledReason={ctl.start.reason} loading={busy} onClick={start}>Start cycle</Button>
            {!ctl.start.enabled && ctl.start.reason ? <p className="mt-1 text-xs text-muted">{ctl.start.reason}</p> : null}
          </div>
        </Card>
      ) : null}
      <Card title="Recent cycles">
        {!history.data ? <SkeletonBlock rows={2} /> : history.data.items.length === 0 ? <p className="text-sm text-muted">No cycles yet.</p> : (
          <ul className="divide-y divide-line text-sm">
            {history.data.items.map((h) => <li key={h.id} className="flex flex-wrap justify-between gap-2 py-2"><span>{formatDateTime(h.startedAt)} · {effectiveCycleStatus(h, now)}{h.isMock ? ' · simulation' : ''}</span><span className="text-muted">published {h.counts.published} · simulated {h.counts.simulated} · failed {h.counts.failed}</span></li>)}
          </ul>
        )}
      </Card>
      <ConfirmDialog open={confirmStop} title="Stop this cycle?" confirmLabel="Stop cycle" pending={busy} onClose={() => setConfirmStop(false)} onConfirm={() => { if (c) void act(() => call('stopCycle', { params: { id: c.id } }), 'Cycle stopped.').then(() => setConfirmStop(false)); }}>
        Jobs that have not run yet are cancelled. This cannot be resumed; you can start a new cycle afterwards.
      </ConfirmDialog>
    </>
  );
}
