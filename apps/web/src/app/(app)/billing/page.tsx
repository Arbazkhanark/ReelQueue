// apps/web/src/app/(app)/billing/page.tsx
'use client';

import { useEffect, useRef, useState } from 'react';
import type { BillingPlanCode } from '@reelqueue/shared';
import { call, errorMessage } from '@/lib/api';
import { invalidate, useApi } from '@/lib/use-api';
import { useNow } from '@/lib/use-now';
import { browserTimezone, formatDateTime } from '@/lib/format';
import { defaultPlanCode, formatMoney, planTotal, remainingText } from '@/lib/billing-ui';
import { CheckoutCancelled, loadRazorpay, openCheckout } from '@/lib/razorpay';
import { Badge, Button, Card, ErrorState, Notice, PageHeader, SelectField, SkeletonBlock } from '@/components/ui';
import { useToast } from '@/components/toast';

const PLAN_TEXT: Record<BillingPlanCode, { title: string; note: string }> = {
  UPI_INR: { title: 'India · UPI', note: 'Pay in rupees with any UPI app.' },
  INTL_USD: { title: 'International · Card', note: 'Charged in US dollars. Works with international (non-Indian) debit and credit cards.' },
};

export default function BillingPage() {
  const toast = useToast();
  const now = useNow(30_000);
  const q = useApi('billingStatus', { refreshMs: 30_000 });
  const [picked, setPicked] = useState<BillingPlanCode | null>(null);
  const [weeks, setWeeks] = useState(1);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const synced = useRef(false);

  // Orders that were paid but never confirmed (tab closed, network drop) are reconciled once when this page opens.
  useEffect(() => {
    if (!q.data || synced.current || q.data.pendingOrders === 0) return;
    synced.current = true;
    void call('billingSync').then(() => invalidate('billingStatus')).catch(() => undefined);
  }, [q.data]);

  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={() => void q.reload()} />;
  if (!q.data) return <SkeletonBlock />;
  const s = q.data;
  if (!s.enabled) {
    return (<><PageHeader title="Billing" description="Plans and payments." /><Notice tone="info">Billing is not switched on for this server, so everything is available without a plan.</Notice></>);
  }

  const code = picked ?? defaultPlanCode(browserTimezone());
  const plan = s.plans.find((p) => p.code === code) ?? s.plans[0];
  const left = s.accessUntil && now ? Date.parse(s.accessUntil) - now : null;

  async function pay() {
    if (!plan) return;
    setBusy(true);
    try {
      const co = await call('billingCheckout', { body: { plan: plan.code, weeks } });
      await loadRazorpay();
      const r = await openCheckout(co);
      await call('billingVerify', { body: { orderId: r.razorpay_order_id, paymentId: r.razorpay_payment_id, signature: r.razorpay_signature } });
      toast.success('Payment received. Your access has been extended.');
    } catch (e) {
      if (e instanceof CheckoutCancelled) toast.info('Payment cancelled.'); else toast.error(errorMessage(e));
    } finally { invalidate('billingStatus'); setBusy(false); }
  }
  async function checkStatus() {
    setChecking(true);
    try { await call('billingSync'); invalidate('billingStatus'); toast.info('Payment status refreshed.'); }
    catch (e) { toast.error(errorMessage(e)); } finally { setChecking(false); }
  }

  const payLabel = plan ? `Pay ${formatMoney(planTotal(plan, weeks), plan.currency)}${plan.code === 'UPI_INR' ? ' with UPI' : ''}` : 'Pay';

  return (
    <>
      <PageHeader title="Billing" description="7 days free for new accounts, then pay weekly. Paid weeks are added after the time you already have, so no days are lost." />
      <Card title="Your access" className="mb-4" actions={s.state === 'ACTIVE' ? <Badge tone="ok">Active</Badge> : s.state === 'TRIAL' ? <Badge tone="sim">Free trial</Badge> : <Badge>Expired</Badge>}>
        <div className="space-y-1 text-sm">
          {s.state === 'EXPIRED' ? <p className="text-danger">Your access has ended. Choose a plan below to continue.</p> : left !== null ? <p><strong>{remainingText(left)}</strong> of access left.</p> : null}
          <p className="text-muted">Free trial {Date.parse(s.trialEndsAt) > now ? 'ends' : 'ended'} {formatDateTime(s.trialEndsAt)}{s.paidUntil ? ` · paid until ${formatDateTime(s.paidUntil)}` : ''}</p>
          {!s.enforced ? <p className="text-muted">Test mode: access is not blocked while BILLING_ENFORCE is off.</p> : null}
        </div>
      </Card>

      <Card title="Choose how to pay" className="mb-4">
        <div role="radiogroup" aria-label="Payment option" className="grid gap-3 md:grid-cols-2">
          {s.plans.map((p) => {
            const on = plan !== undefined && p.code === plan.code;
            return (
              <button key={p.code} type="button" role="radio" aria-checked={on} onClick={() => setPicked(p.code)}
                className={`rounded-lg border p-3 text-left ${on ? 'border-ink bg-sunken' : 'border-line hover:bg-sunken'}`}>
                <p className="font-semibold">{PLAN_TEXT[p.code].title}</p>
                <p className="text-2xl font-semibold">{formatMoney(p.weeklyAmountMinor, p.currency)} <span className="text-sm font-normal text-muted">/ week</span></p>
                <p className="mt-1 text-xs text-muted">{PLAN_TEXT[p.code].note}</p>
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <SelectField label="Weeks to buy" value={String(weeks)} onChange={(e) => setWeeks(Number(e.target.value))}>
            {Array.from({ length: s.maxWeeks }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n} week{n === 1 ? '' : 's'}</option>)}
          </SelectField>
          <Button variant="primary" loading={busy} disabled={!plan} onClick={() => void pay()}>{payLabel}</Button>
          {s.pendingOrders > 0 ? <Button loading={checking} onClick={() => void checkStatus()}>Check payment status</Button> : null}
        </div>
        <p className="mt-3 text-xs text-muted">Payments are processed securely by Razorpay. ReelQueue never sees your card or UPI details. You pay for the weeks you choose; nothing renews automatically.</p>
      </Card>

      <Card title="Payment history">
        {s.payments.length === 0 ? <p className="text-sm text-muted">No payments yet.</p> : (
          <ul className="divide-y divide-line text-sm">
            {s.payments.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                <span>{formatDateTime(p.createdAt)} · {p.weeks} week{p.weeks === 1 ? '' : 's'} · {formatMoney(p.amountMinor, p.currency)}</span>
                <span className={p.state === 'PAID' ? '' : 'text-muted'} title={p.failureReason ?? undefined}>{p.state === 'PAID' ? 'Paid' : p.state === 'FAILED' ? 'Failed — you can try again' : p.state === 'EXPIRED' ? 'Expired' : 'Pending'}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}