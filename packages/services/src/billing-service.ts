// packages/services/src/billing-service.ts
import { createHash, randomUUID } from 'node:crypto';
import type { Clock } from '@reelqueue/core';
import type { BillingStore, PaymentRow } from '@reelqueue/db';

import {
  AppError, BILLING_PLANS, billingPlanList, computeAccess, daysLeft, isPlanCode, paymentState, planAmountMinor, billingDisabledStatus,
  type AccessState, type BillingStatusDto, type CreateCheckoutResponse, type PaymentDto, type VerifyPaymentRequest,
} from '@reelqueue/shared';

/** What the service needs from a payment provider. RazorpayClient satisfies it structurally; tests use a fake. */
export interface GatewayPayment { id: string; orderId: string | null; status: string; amountMinor: number; currency: string; failureText?: string | null }
export interface PaymentGateway {
  createOrder(i: { amountMinor: number; currency: string; receipt: string; notes: Record<string, string> }): Promise<{ id: string }>;
  fetchPayment(paymentId: string): Promise<GatewayPayment>;
  capturePayment(paymentId: string, amountMinor: number, currency: string): Promise<GatewayPayment>;
  listOrderPayments(orderId: string): Promise<GatewayPayment[]>;
  verifySignature(orderId: string, paymentId: string, signature: string): boolean;
  /** Optional. true/false = signature checked; null/absent = no webhook secret, so the caller re-reads the payment from the provider instead. */
  verifyWebhook?(rawBody: Uint8Array, signature: string): boolean | null;
}

export interface BillingServiceConfig { keyId: string | null; enforce: boolean; trialDays: number; maxWeeks: number }
export interface BillingLogger { info(o: Record<string, unknown>, msg: string): void; warn(o: Record<string, unknown>, msg: string): void }
const NOOP: BillingLogger = { info: () => {}, warn: () => {} };

const DAY_MS = 24 * 3600 * 1000;
const PENDING_LOOKBACK_MS = 14 * DAY_MS;
const ORDER_RE = /^order_[A-Za-z0-9]{6,40}$/;
const PAYMENT_RE = /^pay_[A-Za-z0-9]{6,40}$/;
const WEBHOOK_EVENTS = new Set(['payment.captured', 'payment.authorized', 'order.paid', 'payment.failed']);
const SIGNATURE_RE = /^[0-9a-fA-F]{64}$/;

const toPaymentDto = (p: PaymentRow, nowMs: number): PaymentDto => ({
  id: p.id, plan: p.plan, currency: p.currency, amountMinor: p.amountMinor, weeks: p.weeks, status: p.status,
  state: paymentState(p.status, p.createdAt.getTime(), p.lastFailure !== null, nowMs), failureReason: p.status === 'PAID' ? null : p.lastFailure,
  createdAt: p.createdAt.toISOString(), paidAt: p.paidAt ? p.paidAt.toISOString() : null,
});
const errName = (e: unknown): string => (e instanceof Error ? e.name : 'unknown');

/**
 * Trial + paid weeks. Money is never taken on the client's word: the amount is computed here from the plan table, and a payment is only
 * credited after Razorpay itself (server to server, with our secret) says it is captured for exactly that order, amount and currency.
 */
export class BillingService {
  constructor(
    private readonly store: BillingStore,
    private readonly gateway: PaymentGateway | null,
    private readonly clock: Clock,
    private readonly cfg: BillingServiceConfig,
    private readonly log: BillingLogger = NOOP,
  ) {}

  get enabled(): boolean { return this.gateway !== null && this.cfg.keyId !== null; }
  get enforced(): boolean { return this.enabled && this.cfg.enforce; }

  private async access(userId: string): Promise<{ state: AccessState; accessUntilMs: number | null; trialEndsAt: Date; paidUntil: Date | null }> {
    const now = this.clock.now();
    const acc = await this.store.getOrStartTrial(userId, now, this.cfg.trialDays);
    const c = computeAccess(now.getTime(), acc.trialEndsAt.getTime(), acc.paidUntil ? acc.paidUntil.getTime() : null);
    return { ...c, trialEndsAt: acc.trialEndsAt, paidUntil: acc.paidUntil };
  }

  async status(userId: string): Promise<BillingStatusDto> {
    const now = this.clock.now();
    if (!this.enabled) return billingDisabledStatus(now.toISOString());
    const a = await this.access(userId);
    const payments = await this.store.listPayments(userId, 10);
    const pendingSince = now.getTime() - PENDING_LOOKBACK_MS;
    return {
      enabled: true, enforced: this.enforced, state: a.state, hasAccess: !this.enforced || a.state !== 'EXPIRED',
      trialEndsAt: a.trialEndsAt.toISOString(), paidUntil: a.paidUntil ? a.paidUntil.toISOString() : null,
      accessUntil: a.accessUntilMs === null ? null : new Date(a.accessUntilMs).toISOString(), daysLeft: daysLeft(now.getTime(), a.accessUntilMs),
      pendingOrders: payments.filter((p) => p.status === 'CREATED' && p.createdAt.getTime() >= pendingSince).length,
      maxWeeks: this.cfg.maxWeeks, plans: billingPlanList(),
      razorpayKeyId: this.cfg.keyId, payments: payments.map((x) => toPaymentDto(x, now.getTime())),
    };
  }

  /** True when the user may use the product right now. Always true while billing is off or not enforced. */
  async hasAccess(userId: string): Promise<boolean> {
    if (!this.enforced) return true;
    return (await this.access(userId)).state !== 'EXPIRED';
  }

  /** Guard for actions that use the product (start/resume a cycle, upload, import). 402 when the trial or paid time is over. */
  async assertAccess(userId: string): Promise<void> {
    if (!this.enforced) return;
    const a = await this.access(userId);
    if (a.state !== 'EXPIRED') return;
    throw new AppError('PAYMENT_REQUIRED', a.paidUntil ? 'Your paid access has ended. Renew it on the Billing page to continue.' : 'Your 7-day free trial has ended. Subscribe on the Billing page to continue.');
  }

  async checkout(userId: string, plan: unknown, weeks: unknown): Promise<CreateCheckoutResponse> {
    if (!this.gateway || !this.cfg.keyId) throw new AppError('NOT_FOUND', 'Billing is not enabled.');
    if (!isPlanCode(plan)) throw new AppError('VALIDATION_FAILED', 'Invalid input.', [{ field: 'plan', message: 'Unknown plan.' }]);
    if (typeof weeks !== 'number' || !Number.isInteger(weeks) || weeks < 1 || weeks > this.cfg.maxWeeks) {
      throw new AppError('VALIDATION_FAILED', 'Invalid input.', [{ field: 'weeks', message: `Choose between 1 and ${this.cfg.maxWeeks} weeks.` }]);
    }
    const now = this.clock.now();
    await this.store.getOrStartTrial(userId, now, this.cfg.trialDays);
    const p = BILLING_PLANS[plan];
    const amountMinor = planAmountMinor(plan, weeks);
    const id = randomUUID();
    let orderId: string;
    try {
      orderId = (await this.gateway.createOrder({ amountMinor, currency: p.currency, receipt: `rq_${id.replace(/-/g, '')}`, notes: { userId, plan, weeks: String(weeks) } })).id;
    } catch (e) {
      this.log.warn({ event: 'billing.order.failed', userId, plan, errName: errName(e), kind: (e as { kind?: unknown }).kind, httpStatus: (e as { httpStatus?: unknown }).httpStatus, providerCode: (e as { providerCode?: unknown }).providerCode }, 'could not create payment order');
      throw new AppError('PAYMENT_UNAVAILABLE', 'The payment provider could not start this payment. Please try again in a moment.');
    }
    await this.store.createPayment({ id, userId, plan, currency: p.currency, amountMinor, weeks, orderId, now });
    this.log.info({ event: 'billing.order.created', userId, plan, weeks, orderId }, 'payment order created');
    return { orderId, keyId: this.cfg.keyId, amountMinor, currency: p.currency, plan, weeks, description: `ReelQueue access · ${weeks} week${weeks === 1 ? '' : 's'}` };
  }

  /** Called by the browser right after Razorpay's checkout succeeds. */
  async verify(userId: string, req: VerifyPaymentRequest): Promise<BillingStatusDto> {
    if (!this.gateway) throw new AppError('NOT_FOUND', 'Billing is not enabled.');
    if (!ORDER_RE.test(req.orderId) || !PAYMENT_RE.test(req.paymentId) || !SIGNATURE_RE.test(req.signature)) throw new AppError('VALIDATION_FAILED', 'Invalid input.', [{ field: 'payment', message: 'Malformed payment details.' }]);
    const pay = await this.store.getPaymentByOrder(userId, req.orderId); // tenant check: someone else's order is "not found"
    if (!pay) throw new AppError('NOT_FOUND', 'Payment order not found.');
    if (pay.status === 'PAID') return this.status(userId); // already credited (idempotent)
    if (!this.gateway.verifySignature(req.orderId, req.paymentId, req.signature)) {
      this.log.warn({ event: 'billing.signature.mismatch', userId, orderId: req.orderId }, 'payment signature mismatch');
      throw new AppError('VALIDATION_FAILED', 'Invalid input.', [{ field: 'signature', message: 'Payment signature could not be verified.' }]);
    }
    let rp: GatewayPayment;
    try { rp = await this.gateway.fetchPayment(req.paymentId); }
    catch (e) { this.log.warn({ event: 'billing.fetch.failed', userId, errName: errName(e) }, 'could not read payment'); throw new AppError('PAYMENT_UNAVAILABLE', 'Could not confirm the payment yet. Use "Check payment status" in a minute.'); }
    await this.settle(userId, pay, rp);
    return this.status(userId);
  }

  /** Looks at this user's unconfirmed orders at Razorpay and credits the ones that were actually paid (tab closed, network drop, ...). */
  async sync(userId: string): Promise<BillingStatusDto> {
    if (!this.gateway) return this.status(userId);
    const now = this.clock.now();
    const pending = await this.store.listPending(userId, new Date(now.getTime() - PENDING_LOOKBACK_MS), 5);
    for (const pay of pending) {
      try {
        const hit = (await this.gateway.listOrderPayments(pay.providerOrderId)).find((x) => x.status === 'captured' || x.status === 'authorized');
        if (hit) await this.settle(userId, pay, hit);
      } catch (e) {
        if (e instanceof AppError && e.code === 'CONFLICT') continue;
        this.log.warn({ event: 'billing.sync.failed', userId, orderId: pay.providerOrderId, errName: errName(e) }, 'could not reconcile order');
      }
    }
    return this.status(userId);
  }

  /**
   * Razorpay webhook. Trust model: the body is never believed on its own.
   *  1. If a webhook secret is configured AND the HTTP layer kept the exact raw bytes, the HMAC must match (otherwise 400).
   *  2. Whatever the signature says, money is credited only from a FRESH server-to-server read of the payment from Razorpay,
   *     and only when order, amount and currency equal what we stored when we created the order.
   *  3. Each event id is claimed once; a delivery that already succeeded is skipped, one that crashed half-way is retried.
   * Returns quickly with an outcome string; throws PAYMENT_UNAVAILABLE (HTTP 502) when Razorpay could not be reached so Razorpay re-delivers.
   */
  async handleWebhook(i: { eventId: string | null; signature: string | null; rawBody?: Uint8Array; body: unknown }): Promise<'PROCESSED' | 'DUPLICATE' | 'IGNORED' | 'REJECTED'> {
    const gw = this.gateway;
    if (!gw) throw new AppError('NOT_FOUND', 'Billing is not enabled.');
    if (i.rawBody && gw.verifyWebhook) {
      const ok = gw.verifyWebhook(i.rawBody, i.signature ?? '');
      if (ok === false) { this.log.warn({ event: 'billing.webhook.bad_signature' }, 'webhook signature mismatch'); throw new AppError('VALIDATION_FAILED', 'Invalid webhook signature.'); }
    }
    const ev = i.body as { event?: unknown; payload?: { payment?: { entity?: { id?: unknown; order_id?: unknown } }; order?: { entity?: { id?: unknown } } } } | null;
    const type = typeof ev?.event === 'string' ? ev.event : '';
    if (!WEBHOOK_EVENTS.has(type)) return 'IGNORED';
    const pe = ev?.payload?.payment?.entity;
    const paymentId = typeof pe?.id === 'string' && PAYMENT_RE.test(pe.id) ? pe.id : null;
    const orderRaw = typeof pe?.order_id === 'string' ? pe.order_id : ev?.payload?.order?.entity?.id;
    const orderId = typeof orderRaw === 'string' && ORDER_RE.test(orderRaw) ? orderRaw : null;
    if (!orderId) return 'IGNORED';
    const eventId = i.eventId && i.eventId.length <= 100 ? i.eventId : `body_${createHash('sha256').update(JSON.stringify(i.body)).digest('hex')}`;

    const pay = await this.store.getPaymentByOrderAny(orderId);
    if (!pay) return 'IGNORED'; // not one of our orders (the Razorpay account may serve other products too)
    if ((await this.store.claimWebhookEvent(eventId, type, this.clock.now())) === 'DONE') return 'DUPLICATE';

    let outcome: 'PROCESSED' | 'IGNORED' | 'REJECTED' = 'IGNORED';
    try {
      if (type === 'payment.failed') {
        if (!paymentId) { outcome = 'IGNORED'; }
        else {
          const rp = await gw.fetchPayment(paymentId);
          if (rp.orderId === pay.providerOrderId && rp.status === 'failed') { await this.store.recordFailure(pay.providerOrderId, rp.failureText ?? 'The payment attempt failed.', this.clock.now()); outcome = 'PROCESSED'; }
        }
      } else {
        const rp = paymentId ? await gw.fetchPayment(paymentId) : (await gw.listOrderPayments(pay.providerOrderId)).find((x) => x.status === 'captured' || x.status === 'authorized');
        if (rp) {
          try { await this.settle(pay.userId, pay, rp); outcome = 'PROCESSED'; }
          catch (e) {
            if (e instanceof AppError && e.code === 'CONFLICT') outcome = 'IGNORED'; // not completed (yet): a later event will carry it
            else if (e instanceof AppError && e.code === 'VALIDATION_FAILED') outcome = 'REJECTED'; // amount / currency / order mismatch: never credited
            else throw e;
          }
        }
      }
    } catch (e) {
      this.log.warn({ event: 'billing.webhook.failed', eventType: type, orderId, errName: errName(e) }, 'webhook could not be processed; it will be retried');
      throw new AppError('PAYMENT_UNAVAILABLE', 'Could not process the event yet.'); // the claim stays unfinished, so the next delivery runs again
    }
    await this.store.finishWebhookEvent(eventId, this.clock.now());
    this.log.info({ event: 'billing.webhook', eventType: type, orderId, outcome }, 'webhook handled');
    return outcome;
  }

  private async settle(userId: string, pay: PaymentRow, reported: GatewayPayment): Promise<void> {
    if (!this.gateway) throw new AppError('NOT_FOUND', 'Billing is not enabled.');
    if (reported.orderId !== pay.providerOrderId || reported.amountMinor !== pay.amountMinor || reported.currency !== pay.currency) {
      this.log.warn({ event: 'billing.payment.mismatch', userId, orderId: pay.providerOrderId }, 'payment does not match its order');
      throw new AppError('VALIDATION_FAILED', 'Invalid input.', [{ field: 'payment', message: 'This payment does not match the order.' }]);
    }
    let rp = reported;
    if (rp.status === 'authorized') {
      try { rp = await this.gateway.capturePayment(rp.id, pay.amountMinor, pay.currency); }
      catch (e) { this.log.warn({ event: 'billing.capture.failed', userId, errName: errName(e) }, 'could not capture payment'); throw new AppError('PAYMENT_UNAVAILABLE', 'The payment is authorised but could not be completed yet. Try "Check payment status" shortly.'); }
    }
    if (rp.status !== 'captured') throw new AppError('CONFLICT', 'This payment is not completed yet.');
    const r = await this.store.markPaid({ userId, orderId: pay.providerOrderId, paymentId: rp.id, now: this.clock.now(), trialDays: this.cfg.trialDays });
    this.log.info({ event: 'billing.credited', userId, orderId: pay.providerOrderId, weeks: pay.weeks, credited: r.credited, paidUntil: r.paidUntil ? r.paidUntil.toISOString() : null }, 'payment confirmed');
  }
}