// apps/web/src/app/\(auth\)/register/page.tsx
'use client';

import { useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { call, errorMessage, fieldErrors } from '@/lib/api';
import { validateEmail, validateNewPassword } from '@/lib/validate';
import { Button, Notice, TextField } from '@/components/ui';

export default function RegisterPage() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const eErr = validateEmail(email); const pErr = validateNewPassword(password);
    if (eErr || pErr) { setErrors({ ...(eErr ? { email: eErr } : {}), ...(pErr ? { password: pErr } : {}) }); return; }
    setBusy(true); setErrors({}); setFormError(null);
    try {
      await call('register', { body: { email: email.trim(), password }, noAuthRedirect: true });
      setSent(true);
    } catch (err) {
      setErrors(fieldErrors(err)); setFormError(errorMessage(err));
    } finally { setBusy(false); }
  }

  if (sent) {
    return (
      <div className="space-y-3">
        <h2 className="text-xl font-semibold">Check your email</h2>
        <Notice tone="info">If this address can be registered, a verification link is on its way. You can sign in once you have verified it.</Notice>
        <Link href="/login" className="btn-secondary">Back to sign in</Link>
      </div>
    );
  }
  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <h2 className="text-xl font-semibold">Create your account</h2>
      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      <TextField label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email ?? null} />
      <TextField label="Password" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password ?? null} hint="At least 12 characters." />
      <Button type="submit" variant="primary" loading={busy} className="w-full">Create account</Button>
      <p className="text-sm text-muted">Already registered? <Link href="/login" className="underline">Sign in</Link></p>
    </form>
  );
}
