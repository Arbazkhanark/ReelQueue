// apps/web/src/app/\(auth\)/login/page.tsx
'use client';

import { Suspense, useState } from 'react';
import type { FormEvent } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { call, errorMessage, fieldErrors } from '@/lib/api';
import { safeNextPath, validateEmail } from '@/lib/validate';
import { Button, Notice, TextField } from '@/components/ui';

function LoginForm() {
  const router = useRouter();
  const next = safeNextPath(useSearchParams().get('next'));
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const emailErr = validateEmail(email);
    if (emailErr || !password) { setErrors({ ...(emailErr ? { email: emailErr } : {}), ...(!password ? { password: 'Enter your password.' } : {}) }); return; }
    setBusy(true); setErrors({}); setFormError(null);
    try {
      await call('login', { body: { email: email.trim(), password }, noAuthRedirect: true });
      router.replace(next);
    } catch (err) {
      setErrors(fieldErrors(err));
      setFormError(errorMessage(err));
    } finally { setBusy(false); }
  }

  return (
    <form onSubmit={submit} className="space-y-4" noValidate>
      <h2 className="text-xl font-semibold">Sign in</h2>
      {formError ? <Notice tone="danger">{formError}</Notice> : null}
      <TextField label="Email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={errors.email ?? null} />
      <TextField label="Password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} error={errors.password ?? null} />
      <Button type="submit" variant="primary" loading={busy} className="w-full">Sign in</Button>
      <p className="text-sm text-muted">
        <Link href="/forgot-password" className="underline">Forgot password?</Link> · <Link href="/register" className="underline">Create an account</Link>
      </p>
    </form>
  );
}

export default function LoginPage() {
  return <Suspense fallback={null}><LoginForm /></Suspense>;
}
