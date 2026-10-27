// apps/web/src/lib/billing-ui.ts
// Pure helpers for the billing UI (no React, no fetch). Prices shown here come from the server (`plans`); the server decides the real amount.
import type { BillingPlanCode, BillingPlanDto, BillingStatusDto } from '@reelqueue/shared';

const INDIA_TIMEZONES = new Set(['Asia/Kolkata', 'Asia/Calcutta']);

/** Pre-selected option: UPI (INR) for browsers set to an Indian timezone, US dollars for everyone else. The person can always switch. */
export function defaultPlanCode(timezone: string | null | undefined): BillingPlanCode {
  return timezone && INDIA_TIMEZONES.has(timezone) ? 'UPI_INR' : 'INTL_USD';
}

/** 100000 INR -> "₹1,000", 1499 USD -> "$14.99". Amounts are paise / cents. */
export function formatMoney(minor: number, currency: 'INR' | 'USD'): string {
  const major = minor / 100;
  return currency === 'INR'
    ? new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', minimumFractionDigits: major % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 }).format(major)
    : new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(major);
}

export const planTotal = (plan: Pick<BillingPlanDto, 'weeklyAmountMinor'>, weeks: number): number => plan.weeklyAmountMinor * weeks;

/** "5 days 3 hours", "3 hours 20 min", "12 min", "less than a minute". */
export function remainingText(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 60_000) return 'less than a minute';
  const mins = Math.floor(ms / 60_000), days = Math.floor(mins / 1440), hours = Math.floor((mins % 1440) / 60), m = mins % 60;
  const unit = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  if (days > 0) return hours > 0 ? `${unit(days, 'day')} ${unit(hours, 'hour')}` : unit(days, 'day');
  if (hours > 0) return m > 0 ? `${unit(hours, 'hour')} ${m} min` : unit(hours, 'hour');
  return `${m} min`;
}

export interface Banner { tone: 'info' | 'warn' | 'danger'; title: string; text: string }

/** The slim banner at the top of every app page; null = nothing to say. `nowMs` is 0 before hydration (then nothing is shown). */
export function bannerFor(s: Pick<BillingStatusDto, 'enabled' | 'enforced' | 'state' | 'accessUntil'> | undefined, nowMs: number): Banner | null {
  if (!s || !s.enabled || nowMs <= 0) return null;
  if (s.state === 'EXPIRED') {
    return s.enforced ? { tone: 'danger', title: 'Plan required', text: 'Your access has ended. Choose a plan to start cycles, upload and import videos again.' } : null;
  }
  const left = (s.accessUntil ? Date.parse(s.accessUntil) : NaN) - nowMs;
  if (!Number.isFinite(left)) return null;
  if (s.state === 'TRIAL') return { tone: left < 2 * 86_400_000 ? 'warn' : 'info', title: 'Free trial', text: `${remainingText(left)} left in your free trial.` };
  if (left < 86_400_000) return { tone: 'warn', title: 'Plan ending soon', text: `Your plan ends in ${remainingText(left)}. Renew to keep publishing.` };
  return null;
}

/** Ads only for people who currently have access (never on a paywall), only once billing status is known, only when AdSense is configured. */
export function adsAllowed(s: Pick<BillingStatusDto, 'enabled' | 'state' | 'hasAccess'> | undefined, adClient: string | undefined, hideForPaid: boolean): boolean {
  if (!adClient) return false;
  if (!s) return false; // wait for the billing status: no flash of ads for people who are blocked
  if (!s.enabled) return true;
  if (!s.hasAccess) return false;
  if (hideForPaid && s.state === 'ACTIVE') return false;
  return true;
}

export type AdMode = 'off' | 'placeholder' | 'live';

/**
 * NEXT_PUBLIC_ADS_MODE: unset/"off" = nothing; "placeholder" = a clearly labelled empty reserved area (for layout review before AdSense approval,
 * it never pretends to be an ad); "live" = real AdSense, and only when BOTH the publisher id and this placement's slot id exist.
 * Anything unrecognised, or "live" without ids, falls back to "off" so a typo can never show a fake or half-configured ad.
 */
export function resolveAdMode(raw: string | undefined, client: string | undefined, slot: string | undefined): AdMode {
  const m = (raw ?? '').trim().toLowerCase();
  if (m === 'placeholder') return 'placeholder';
  if (m === 'live' && client && /^ca-pub-\d{10,20}$/.test(client) && slot && /^\d{6,20}$/.test(slot)) return 'live';
  return 'off';
}