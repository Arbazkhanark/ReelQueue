// packages/shared/src/billing.ts
/**
 * Billing contract + the pure access rule. Shared by the API, the worker and the web app so they can never disagree.
 * Prices live HERE only. The client sends a plan code and a week count; the server computes the amount.
 */

export const BILLING_TRIAL_DAYS = 7;
export const BILLING_MAX_WEEKS = 12;
const DAY_MS = 24 * 3600 * 1000;

export const BILLING_PLANS = {
  /** India: UPI (Razorpay also shows cards / netbanking after UPI). 1000 INR = 100000 paise per week. */
  UPI_INR: { code: 'UPI_INR', currency: 'INR', unitAmountMinor: 100_000, label: 'UPI (India)' },
  /** Everyone else: charged in US dollars. 14.99 USD = 1499 cents per week. */
  INTL_USD: { code: 'INTL_USD', currency: 'USD', unitAmountMinor: 1_499, label: 'International (USD)' },
} as const;
export type BillingPlanCode = keyof typeof BILLING_PLANS;
export type BillingCurrency = (typeof BILLING_PLANS)[BillingPlanCode]['currency'];

export const isPlanCode = (v: unknown): v is BillingPlanCode => typeof v === 'string' && Object.prototype.hasOwnProperty.call(BILLING_PLANS, v);
export const planAmountMinor = (plan: BillingPlanCode, weeks: number): number => BILLING_PLANS[plan].unitAmountMinor * weeks;

export type AccessState = 'TRIAL' | 'ACTIVE' | 'EXPIRED';
export type PaymentStatus = 'CREATED' | 'PAID' | 'FAILED';
/** What the person sees: PENDING (order open), FAILED (last attempt failed, can retry), EXPIRED (open for over a day), PAID. */
export type PaymentState = 'PENDING' | 'FAILED' | 'EXPIRED' | 'PAID';
export const PAYMENT_EXPIRY_MS = 24 * 3600 * 1000;

/** Pure and server-computed (the browser never decides a payment's state). A late payment on an EXPIRED order is still credited and becomes PAID. */
export function paymentState(status: PaymentStatus, createdAtMs: number, hasFailure: boolean, nowMs: number): PaymentState {
  if (status === 'PAID') return 'PAID';
  if (status === 'FAILED') return 'FAILED';
  if (nowMs - createdAtMs >= PAYMENT_EXPIRY_MS) return 'EXPIRED';
  return hasFailure ? 'FAILED' : 'PENDING';
}

export interface PaymentDto {
  id: string;
  plan: BillingPlanCode;
  currency: BillingCurrency;
  amountMinor: number;
  weeks: number;
  status: PaymentStatus;
  state: PaymentState;
  failureReason: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface BillingPlanDto { code: BillingPlanCode; currency: BillingCurrency; weeklyAmountMinor: number }

export interface BillingStatusDto {
  /** Razorpay keys are configured on the server. When false, nothing is charged and nothing is locked. */
  enabled: boolean;
  /** Access is actually enforced (enabled and BILLING_ENFORCE is not "false"). */
  enforced: boolean;
  state: AccessState;
  /** What the person may do right now: false only when billing is enforced AND the trial / paid time is over. */
  hasAccess: boolean;
  trialEndsAt: string;
  paidUntil: string | null;
  /** End of the access that is currently running (trial or paid); null when expired. */
  accessUntil: string | null;
  /** Whole days left, rounded up (0 when expired). */
  daysLeft: number;
  /** Orders created but not confirmed yet (the web app asks the server to reconcile them). */
  pendingOrders: number;
  /** Most weeks that can be bought in one payment. */
  maxWeeks: number;
  /** Prices for the two payment options, so the UI never hard-codes them (the server still decides the real amount). */
  plans: BillingPlanDto[];
  /** Public Razorpay key id (safe for the browser); null when billing is disabled. */
  razorpayKeyId: string | null;
  payments: PaymentDto[];
}

export interface CreateCheckoutRequest { plan: BillingPlanCode; weeks: number }
export interface CreateCheckoutResponse {
  orderId: string;
  keyId: string;
  amountMinor: number;
  currency: BillingCurrency;
  plan: BillingPlanCode;
  weeks: number;
  description: string;
}
export interface VerifyPaymentRequest { orderId: string; paymentId: string; signature: string }

/** Trial wins until it ends, paid time wins while it lasts. Pure: callers pass the clock. */
export function computeAccess(nowMs: number, trialEndsAtMs: number, paidUntilMs: number | null): { state: AccessState; accessUntilMs: number | null } {
  const paidActive = paidUntilMs !== null && nowMs < paidUntilMs;
  const trialActive = nowMs < trialEndsAtMs;
  if (paidActive) return { state: 'ACTIVE', accessUntilMs: Math.max(paidUntilMs, trialActive ? trialEndsAtMs : 0) };
  if (trialActive) return { state: 'TRIAL', accessUntilMs: trialEndsAtMs };
  return { state: 'EXPIRED', accessUntilMs: null };
}

export const daysLeft = (nowMs: number, untilMs: number | null): number => (untilMs === null ? 0 : Math.max(0, Math.ceil((untilMs - nowMs) / DAY_MS)));

/** What /v1/billing/status returns when the server has no Razorpay keys: nothing is charged, nothing is locked. */
export function billingDisabledStatus(nowIso: string): BillingStatusDto {
  return { enabled: false, enforced: false, state: 'ACTIVE', hasAccess: true, trialEndsAt: nowIso, paidUntil: null, accessUntil: null, daysLeft: 0, pendingOrders: 0, maxWeeks: BILLING_MAX_WEEKS, plans: [], razorpayKeyId: null, payments: [] };
}

export const billingPlanList = (): BillingPlanDto[] => (Object.values(BILLING_PLANS) as (typeof BILLING_PLANS)[BillingPlanCode][]).map((p) => ({ code: p.code, currency: p.currency, weeklyAmountMinor: p.unitAmountMinor }));