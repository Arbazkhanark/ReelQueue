'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { call, errorMessage } from '@/lib/api';
import { validateEmail } from '@/lib/validate';
import { Button, Notice, TextField } from '@/components/ui';

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    const v = validateEmail(email); if (v) { setErr(v); return; }
    setBusy(true); setErr(null);
    try { await call('forgotPassword', { body: { email: email.trim() }, noAuthRedirect: true }); setSent(true); }
    catch (x) { setErr(errorMessage(x)); } finally { setBusy(false); }
  }
  if (sent) return <div className="space-y-3"><h2 className="text-xl font-semibold">Check your email</h2><Notice tone="info">If an account exists for that address, a reset link is on its way.</Notice><Link href="/login" className="btn-secondary">Back to sign in</Link></div>;
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <h2 className="text-xl font-semibold">Reset your password</h2>
      <TextField label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={err} />
      <Button type="submit" variant="primary" loading={busy} className="w-full">Send reset link</Button>
    </form>
  );
}
