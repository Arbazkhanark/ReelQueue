// apps/web/src/components/paywall.tsx
'use client';

import Link from 'next/link';
import { useApi } from '@/lib/use-api';
import { Notice } from '@/components/ui';

/** Shown on pages whose actions need a plan (cycles, uploads, videos) once the trial or paid time has run out. Renders nothing otherwise. */
export function PaywallNotice() {
  const b = useApi('billingStatus', { refreshMs: 60_000 });
  if (!b.data || !b.data.enabled || b.data.hasAccess) return null;
  return (
    <div className="mb-4">
      <Notice tone="danger" title="Plan required">
        Your free trial or plan has ended, so starting cycles, uploading and importing videos are paused. <Link href="/billing" className="underline">Choose a plan</Link> to continue.
      </Notice>
    </div>
  );
}

/** For disabling buttons: true when billing is on and this person is locked out. The server enforces the same rule (HTTP 402). */
export function useLockedOut(): boolean {
  const b = useApi('billingStatus', { refreshMs: 60_000 });
  return !!b.data && b.data.enabled && !b.data.hasAccess;
}