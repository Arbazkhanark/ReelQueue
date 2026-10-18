'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { call, errorMessage, fieldErrors } from '@/lib/api';
import { invalidate, useApi } from '@/lib/use-api';
import { isValidTimezone } from '@/lib/format';
import { validateNewPassword, validateScheduler } from '@/lib/validate';
import { Button, Card, CheckboxField, ConfirmDialog, ErrorState, Notice, PageHeader, SkeletonBlock, TextField } from '@/components/ui';
import { useToast } from '@/components/toast';

export default function SettingsPage() {
  const toast = useToast();
  const router = useRouter();
  const me = useApi('me');
  const q = useApi('getSettings');
  const [f, setF] = useState<{ batchSize: string; intervalMinutes: string; cycleDurationHours: string; loop: boolean; timezone: string } | null>(null);
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [pw, setPw] = useState({ current: '', next: '' });
  const [pwErr, setPwErr] = useState<string | null>(null);
  const [delOpen, setDelOpen] = useState(false);
  const [delPw, setDelPw] = useState('');

  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={() => void q.reload()} />;
  if (!q.data) return <SkeletonBlock />;
  const s = q.data;
  const v = f ?? { batchSize: String(s.batchSize), intervalMinutes: String(s.intervalMinutes), cycleDurationHours: String(s.cycleDurationHours), loop: s.loopEnabled, timezone: s.timezone };

  async function save(e: FormEvent) {
    e.preventDefault();
    const val = validateScheduler(v, s.limits);
    const next: Record<string, string> = { ...(val.ok ? {} : val.errors) };
    if (!isValidTimezone(v.timezone)) next.timezone = 'Enter a valid IANA timezone, e.g. Asia/Kolkata.';
    setErrs(next);
    if (!val.ok || next.timezone) return;
    setBusy(true);
    try { await call('updateSettings', { body: { ...val.value, loopEnabled: v.loop, timezone: v.timezone } }); setF(null); invalidate('getSettings', 'dashboard'); toast.success('Settings saved.'); }
    catch (x) { setErrs(fieldErrors(x)); toast.error(errorMessage(x)); } finally { setBusy(false); }
  }
  async function changePw(e: FormEvent) {
    e.preventDefault();
    const bad = validateNewPassword(pw.next); if (bad) { setPwErr(bad); return; }
    setBusy(true); setPwErr(null);
    try { await call('changePassword', { body: { currentPassword: pw.current, newPassword: pw.next } }); setPw({ current: '', next: '' }); toast.success('Password changed.'); }
    catch (x) { setPwErr(errorMessage(x)); } finally { setBusy(false); }
  }
  async function del() {
    setBusy(true);
    try { await call('deleteAccount', { body: { password: delPw } }); invalidate('me'); setDelOpen(false); setDelPw(''); toast.info('Account scheduled for deletion.'); }
    catch (x) { toast.error(errorMessage(x)); } finally { setBusy(false); }
  }
  async function cancelDel() {
    try { await call('cancelDeletion'); invalidate('me'); toast.success('Deletion cancelled.'); } catch (x) { toast.error(errorMessage(x)); }
  }
  void router;

  return (
    <>
      <PageHeader title="Settings" />
      <Card title="Publishing defaults" className="mb-4">
        <form onSubmit={save} className="grid gap-3 md:grid-cols-2" noValidate>
          <TextField label="Batch size" inputMode="numeric" value={v.batchSize} error={errs.batchSize ?? null} hint={`${s.limits.batchSize.min}–${s.limits.batchSize.max}`} onChange={(e) => setF({ ...v, batchSize: e.target.value })} />
          <TextField label="Interval (minutes)" inputMode="numeric" value={v.intervalMinutes} error={errs.intervalMinutes ?? null} hint={`Default 20. ${s.limits.intervalMinutes.min}–${s.limits.intervalMinutes.max}`} onChange={(e) => setF({ ...v, intervalMinutes: e.target.value })} />
          <TextField label="Cycle duration (hours)" inputMode="numeric" value={v.cycleDurationHours} error={errs.cycleDurationHours ?? null} hint={`${s.limits.cycleDurationHours.min}–${s.limits.cycleDurationHours.max}`} onChange={(e) => setF({ ...v, cycleDurationHours: e.target.value })} />
          <TextField label="Timezone" value={v.timezone} error={errs.timezone ?? null} onChange={(e) => setF({ ...v, timezone: e.target.value })} />
          <CheckboxField label="Loop by default" checked={v.loop} onChange={(x) => setF({ ...v, loop: x })} />
          <div className="md:col-span-2"><Button type="submit" variant="primary" loading={busy}>Save settings</Button></div>
        </form>
      </Card>
      <Card title="Change password" className="mb-4">
        <form onSubmit={changePw} className="grid gap-3 md:grid-cols-2" noValidate>
          <TextField label="Current password" type="password" autoComplete="current-password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} />
          <TextField label="New password" type="password" autoComplete="new-password" value={pw.next} error={pwErr} onChange={(e) => setPw({ ...pw, next: e.target.value })} />
          <div><Button type="submit" loading={busy}>Change password</Button></div>
        </form>
      </Card>
      <Card title="Delete account">
        {me.data?.status === 'PENDING_DELETION' ? (
          <div className="space-y-2"><Notice tone="warn">Deletion is scheduled. Cancel to keep your account and data.</Notice><Button onClick={() => void cancelDel()}>Cancel deletion</Button></div>
        ) : (
          <><p className="mb-2 text-sm text-muted">Running cycles are stopped and your data is removed after a grace period.</p><Button variant="danger" onClick={() => setDelOpen(true)}>Delete my account</Button></>
        )}
      </Card>
      <ConfirmDialog open={delOpen} title="Delete your account?" confirmLabel="Delete account" pending={busy} onConfirm={() => void del()} onClose={() => setDelOpen(false)}>
        <TextField label="Confirm with your password" type="password" autoComplete="current-password" value={delPw} onChange={(e) => setDelPw(e.target.value)} />
      </ConfirmDialog>
    </>
  );
}
