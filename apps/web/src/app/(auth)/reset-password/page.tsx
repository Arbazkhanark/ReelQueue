'use client';

import { Suspense, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { call, errorMessage } from '@/lib/api';
import { validateNewPassword } from '@/lib/validate';
import { Button, Notice, TextField } from '@/components/ui';

function Reset() {
  const token = useSearchParams().get('token');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!token) { setErr('This link is missing its token.'); return; }
    const v = validateNewPassword(password); if (v) { setErr(v); return; }
    setBusy(true); setErr(null);
    try { await call('resetPassword', { body: { token, password }, noAuthRedirect: true }); setDone(true); }
    catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  }
  if (done) return <div className="space-y-3"><Notice tone="ok">Password changed. Sign in with the new password.</Notice><Link href="/login" className="btn-primary">Sign in</Link></div>;
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <h2 className="text-xl font-semibold">Choose a new password</h2>
      <TextField label="New password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} error={err} hint="At least 12 characters." />
      <Button type="submit" variant="primary" loading={busy} className="w-full">Change password</Button>
    </form>
  );
}
export default function ResetPasswordPage() { return <Suspense fallback={null}><Reset /></Suspense>; }
