// packages/db/src/billing-store.ts
import { toDate, toDateOrNull, toStrOrNull, type Row, type SqlExecutor } from './sql';

export interface BillingAccountRow { userId: string; trialEndsAt: Date; paidUntil: Date | null }
export interface PaymentRow {
  id: string; userId: string; plan: 'UPI_INR' | 'INTL_USD'; currency: 'INR' | 'USD'; amountMinor: number; weeks: number;
  status: 'CREATED' | 'PAID' | 'FAILED'; providerOrderId: string; providerPaymentId: string | null; paidAt: Date | null; createdAt: Date; lastFailure: string | null; lastFailureAt: Date | null;
}

const mapAccount = (r: Row): BillingAccountRow => ({ userId: String(r.user_id), trialEndsAt: toDate(r.trial_ends_at), paidUntil: toDateOrNull(r.paid_until) });
const mapPayment = (r: Row): PaymentRow => ({
  id: String(r.id), userId: String(r.user_id), plan: r.plan === 'INTL_USD' ? 'INTL_USD' : 'UPI_INR', currency: r.currency === 'USD' ? 'USD' : 'INR',
  amountMinor: Number(r.amount_minor), weeks: Number(r.weeks), status: r.status === 'PAID' ? 'PAID' : r.status === 'FAILED' ? 'FAILED' : 'CREATED',
  providerOrderId: String(r.provider_order_id), providerPaymentId: toStrOrNull(r.provider_payment_id), paidAt: toDateOrNull(r.paid_at), createdAt: toDate(r.created_at),
  lastFailure: toStrOrNull(r.last_failure), lastFailureAt: toDateOrNull(r.last_failure_at),
});

const DAY_MS = 24 * 3600 * 1000;

/** Trial + payment persistence. Every method is keyed by the session-derived userId. */
export class BillingStore {
  constructor(private readonly db: SqlExecutor) {}

  /** The user's billing row; the first call starts the trial. Race-safe (two concurrent first calls create one row). */
  async getOrStartTrial(userId: string, now: Date, trialDays: number): Promise<BillingAccountRow> {
    await this.db.exec(`INSERT INTO billing_accounts (user_id, trial_ends_at) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`, [userId, new Date(now.getTime() + trialDays * DAY_MS)]);
    const r = (await this.db.query(`SELECT user_id, trial_ends_at, paid_until FROM billing_accounts WHERE user_id = $1`, [userId]))[0];
    if (!r) throw new Error('billing account row missing after upsert');
    return mapAccount(r);
  }

  async createPayment(p: { id: string; userId: string; plan: PaymentRow['plan']; currency: PaymentRow['currency']; amountMinor: number; weeks: number; orderId: string; now: Date }): Promise<PaymentRow> {
    const r = await this.db.query(
      `INSERT INTO billing_payments (id, user_id, plan, currency, amount_minor, weeks, provider_order_id, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *`,
      [p.id, p.userId, p.plan, p.currency, p.amountMinor, p.weeks, p.orderId, p.now]);
    return mapPayment(r[0]!);
  }

  async getPaymentByOrder(userId: string, orderId: string): Promise<PaymentRow | null> {
    const r = (await this.db.query(`SELECT * FROM billing_payments WHERE user_id = $1 AND provider_order_id = $2`, [userId, orderId]))[0];
    return r ? mapPayment(r) : null;
  }

  /** Webhook path only: the caller has already proven the event is genuine (signature, or a fresh read from the provider). Never expose to a request that carries a userId. */
  async getPaymentByOrderAny(orderId: string): Promise<PaymentRow | null> {
    const r = (await this.db.query(`SELECT * FROM billing_payments WHERE provider_order_id = $1`, [orderId]))[0];
    return r ? mapPayment(r) : null;
  }

  /** Remembers why the last attempt failed. Only touches an open order; a paid order is never changed. */
  async recordFailure(orderId: string, reason: string, now: Date): Promise<void> {
    await this.db.exec(`UPDATE billing_payments SET last_failure = $2, last_failure_at = $3 WHERE provider_order_id = $1 AND status = 'CREATED'`, [orderId, reason.slice(0, 200), now]);
  }

  /** 'CLAIMED' = this call should process the event (first delivery, or an earlier attempt never finished); 'DONE' = already processed, skip. */
  async claimWebhookEvent(eventId: string, eventType: string, now: Date): Promise<'CLAIMED' | 'DONE'> {
    const r = await this.db.query(
      `INSERT INTO billing_webhook_events (event_id, event_type, received_at) VALUES ($1, $2, $3)
       ON CONFLICT (event_id) DO UPDATE SET attempts = billing_webhook_events.attempts + 1 WHERE billing_webhook_events.processed_at IS NULL
       RETURNING event_id`, [eventId, eventType.slice(0, 60), now]);
    return r.length > 0 ? 'CLAIMED' : 'DONE';
  }

  async finishWebhookEvent(eventId: string, now: Date): Promise<void> {
    await this.db.exec(`UPDATE billing_webhook_events SET processed_at = $2 WHERE event_id = $1 AND processed_at IS NULL`, [eventId, now]);
  }

  async listPayments(userId: string, limit: number): Promise<PaymentRow[]> {
    return (await this.db.query(`SELECT * FROM billing_payments WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2`, [userId, limit])).map(mapPayment);
  }

  /** Orders that were created but never confirmed, newest first. `since` bounds how far back we bother Razorpay. */
  async listPending(userId: string, since: Date, limit: number): Promise<PaymentRow[]> {
    return (await this.db.query(`SELECT * FROM billing_payments WHERE user_id = $1 AND status = 'CREATED' AND created_at >= $2 ORDER BY created_at DESC LIMIT $3`, [userId, since, limit])).map(mapPayment);
  }

  /**
   * Exactly-once credit. The UPDATE only matches a CREATED row, so when the browser verify call and the reconcile job race,
   * one of them credits and the other gets credited=false. New paid time starts after whatever access the user already has
   * (trial remainder included), so paying early never wastes days.
   */
  async markPaid(a: { userId: string; orderId: string; paymentId: string; now: Date; trialDays: number }): Promise<{ credited: boolean; paidUntil: Date | null }> {
    return this.db.transaction(async (tx) => {
      await tx.exec(`INSERT INTO billing_accounts (user_id, trial_ends_at) VALUES ($1, $2) ON CONFLICT (user_id) DO NOTHING`, [a.userId, new Date(a.now.getTime() + a.trialDays * DAY_MS)]);
      const hit = (await tx.query(
        `UPDATE billing_payments SET status = 'PAID', provider_payment_id = $3, paid_at = $4 WHERE user_id = $1 AND provider_order_id = $2 AND status = 'CREATED' RETURNING weeks`,
        [a.userId, a.orderId, a.paymentId, a.now]))[0];
      if (!hit) {
        const cur = (await tx.query(`SELECT paid_until FROM billing_accounts WHERE user_id = $1`, [a.userId]))[0];
        return { credited: false, paidUntil: cur ? toDateOrNull(cur.paid_until) : null };
      }
      const upd = (await tx.query(
        `UPDATE billing_accounts SET paid_until = GREATEST($2::timestamptz, COALESCE(paid_until, $2::timestamptz), trial_ends_at) + make_interval(days => $3::int * 7) WHERE user_id = $1 RETURNING paid_until`,
        [a.userId, a.now, Number(hit.weeks)]))[0];
      return { credited: true, paidUntil: upd ? toDateOrNull(upd.paid_until) : null };
    });
  }
}