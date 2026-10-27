// apps/web/src/components/ads.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import { useApi } from '@/lib/use-api';
import { adsAllowed, resolveAdMode } from '@/lib/billing-ui';

declare global { interface Window { adsbygoogle?: unknown[] } }

/** Next.js only inlines NEXT_PUBLIC_* when they are written out literally, so every variable is spelled out here. */
export const ADSENSE_CLIENT: string | undefined = process.env.NEXT_PUBLIC_ADSENSE_CLIENT || undefined;
const ADS_MODE_RAW = process.env.NEXT_PUBLIC_ADS_MODE;
export const HIDE_ADS_FOR_PAID = process.env.NEXT_PUBLIC_ADS_HIDE_FOR_PAID === 'true';
const SLOTS = {
  dashboard: process.env.NEXT_PUBLIC_ADSENSE_SLOT_DASHBOARD,
  cycles: process.env.NEXT_PUBLIC_ADSENSE_SLOT_CYCLES,
  jobs: process.env.NEXT_PUBLIC_ADSENSE_SLOT_JOBS,
  videos: process.env.NEXT_PUBLIC_ADSENSE_SLOT_VIDEOS,
} as const;
export type AdPlacement = keyof typeof SLOTS;

/** True only when AdSense is configured AND this person currently has access (never on a paywall, never before billing status is known). */
export function useAdsEnabled(): boolean {
  const b = useApi('billingStatus', { refreshMs: 60_000 });
  // placeholder mode needs no publisher id, so the check uses a dummy only to pass the "configured" test
  return adsAllowed(b.data, ADSENSE_CLIENT ?? (ADS_MODE_RAW?.trim().toLowerCase() === 'placeholder' ? 'placeholder' : undefined), HIDE_ADS_FOR_PAID);
}

/**
 * One clearly labelled responsive ad. Rules this component keeps on purpose:
 *  - it asks AdSense for an ad exactly ONCE per mount (no timers, no refresh: refreshing ads without a user action is against AdSense policy);
 *  - if AdSense has nothing to show (or an ad-blocker is on) the slot disappears instead of leaving an empty box;
 *  - it is a block of its own with space around it, never inside a card that holds buttons, and never on login, payment, settings or upload screens.
 */
export function AdSlot({ placement, className = '' }: { placement: AdPlacement; className?: string }) {
  const enabled = useAdsEnabled();
  const slot = SLOTS[placement];
  const mode = enabled ? resolveAdMode(ADS_MODE_RAW, ADSENSE_CLIENT, slot) : 'off';
  const show = mode === 'live';
  const ref = useRef<HTMLModElement>(null);
  const pushed = useRef(false);
  const [unfilled, setUnfilled] = useState(false);

  useEffect(() => {
    if (!show || pushed.current) return;
    pushed.current = true;
    try { (window.adsbygoogle = window.adsbygoogle || []).push({}); } catch { /* script blocked or not loaded: the slot simply stays empty */ }
  }, [show]);

  useEffect(() => {
    const el = ref.current;
    if (!show || !el) return;
    const mo = new MutationObserver(() => { if (el.getAttribute('data-ad-status') === 'unfilled') setUnfilled(true); });
    mo.observe(el, { attributes: true, attributeFilter: ['data-ad-status'] });
    return () => mo.disconnect();
  }, [show]);

  if (mode === 'placeholder') {
    return (
      <aside aria-label="Reserved ad area (no ad is being shown)" className={`mx-auto my-6 w-full max-w-3xl ${className}`}>
        <div className="rounded border border-dashed border-border px-3 py-6 text-center text-xs text-muted" style={{ minHeight: 100 }}>Reserved ad area — no ad is being shown</div>
      </aside>
    );
  }
  if (!show || unfilled) return null;
  return (
    <aside aria-label="Advertisement" className={`mx-auto my-6 w-full max-w-3xl ${className}`}>
      <p className="mb-1 text-center text-[10px] uppercase tracking-wide text-muted">Advertisement</p>
      <ins ref={ref} className="adsbygoogle" style={{ display: 'block', minHeight: 100 }} data-ad-client={ADSENSE_CLIENT} data-ad-slot={slot} data-ad-format="auto" data-full-width-responsive="true" />
    </aside>
  );
}