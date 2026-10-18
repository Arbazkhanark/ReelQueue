'use client';

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { call, errorMessage } from '@/lib/api';
import { Notice, Spinner } from '@/components/ui';

function Verify() {
  const token = useSearchParams().get('token');
  const [state, setState] = useState<'working' | 'ok' | string>(token ? 'working' : 'This link is missing its token.');
  useEffect(() => {
    if (!token) return;
    let cancelled = false;
    call('verifyEmail', { body: { token }, noAuthRedirect: true })
      .then(() => { if (!cancelled) setState('ok'); })
      .catch((e: unknown) => { if (!cancelled) setState(errorMessage(e)); });
    return () => { cancelled = true; };
  }, [token]);
  return (
    <div className="space-y-3">
      <h2 className="text-xl font-semibold">Email verification</h2>
      {state === 'working' ? <Spinner /> : state === 'ok' ? <Notice tone="ok">Email verified. You can sign in now.</Notice> : <Notice tone="danger">{state}</Notice>}
      <Link href="/login" className="btn-secondary">Go to sign in</Link>
    </div>
  );
}
export default function VerifyEmailPage() { return <Suspense fallback={null}><Verify /></Suspense>; }
