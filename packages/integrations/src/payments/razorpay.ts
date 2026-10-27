// packages/integrations/src/payments/razorpay.ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Minimal Razorpay REST client (Orders + Payments). No SDK: plain fetch with HTTP Basic auth.
 * The key secret is used ONLY for the Authorization header and for HMAC checks. It is never logged, returned or put in an error.
 */
export interface RazorpayConfig { keyId: string; keySecret: string; /** Dashboard > Webhooks secret. Optional: without it, webhooks are verified by re-reading the payment from Razorpay instead. */ webhookSecret?: string; baseUrl?: string; requestTimeoutMs?: number }

export type RzpFetch = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ status: number; text(): Promise<string> }>;

export interface RzpPayment { id: string; orderId: string | null; status: string; amountMinor: number; currency: string; /** Sanitised provider text for a failed attempt (no URLs, max 200 chars). */ failureText: string | null }

export type RazorpayErrorKind = 'AUTH' | 'BAD_REQUEST' | 'UNAVAILABLE' | 'REJECTED';
export class RazorpayError extends Error {
  constructor(readonly kind: RazorpayErrorKind, readonly httpStatus: number | null, readonly providerCode: string | null, readonly providerDescription: string | null) {
    super(`Razorpay request failed (${kind}${httpStatus ? ` ${httpStatus}` : ''}${providerCode ? ` ${providerCode}` : ''})`);
    this.name = 'RazorpayError';
  }
}

/** Checkout signature: HMAC-SHA256(order_id + "|" + payment_id, key_secret), hex. Constant-time compare. */
export function verifyCheckoutSignature(keySecret: string, orderId: string, paymentId: string, signature: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', keySecret).update(`${orderId}|${paymentId}`).digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Webhook signature: HMAC-SHA256(raw request body, webhook secret), hex, in the X-Razorpay-Signature header. Must be computed over the EXACT bytes received. */
export function verifyWebhookSignature(webhookSecret: string, rawBody: Uint8Array, signature: string): boolean {
  if (!/^[0-9a-f]{64}$/i.test(signature)) return false;
  const expected = createHmac('sha256', webhookSecret).update(rawBody).digest();
  const given = Buffer.from(signature, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

const safeText = (s: unknown): string | null => (typeof s === 'string' ? s.replace(/https?:\/\/\S+/gi, '[url]').slice(0, 200) : null);

export class RazorpayClient {
  private readonly base: string;
  private readonly auth: string;
  private readonly timeoutMs: number;
  constructor(private readonly cfg: RazorpayConfig, private readonly fetchFn: RzpFetch = (u, i) => fetch(u, i)) {
    this.base = (cfg.baseUrl ?? 'https://api.razorpay.com').replace(/\/+$/, '');
    this.auth = `Basic ${Buffer.from(`${cfg.keyId}:${cfg.keySecret}`).toString('base64')}`;
    this.timeoutMs = cfg.requestTimeoutMs ?? 15_000;
  }

  verifySignature(orderId: string, paymentId: string, signature: string): boolean {
    return verifyCheckoutSignature(this.cfg.keySecret, orderId, paymentId, signature);
  }

  /** True/false when a webhook secret is configured; null when it is not (the caller then falls back to re-reading the payment). */
  verifyWebhook(rawBody: Uint8Array, signature: string): boolean | null {
    return this.cfg.webhookSecret ? verifyWebhookSignature(this.cfg.webhookSecret, rawBody, signature) : null;
  }

  async createOrder(i: { amountMinor: number; currency: string; receipt: string; notes: Record<string, string> }): Promise<{ id: string }> {
    const r = await this.call('POST', '/v1/orders', { amount: i.amountMinor, currency: i.currency, receipt: i.receipt, notes: i.notes });
    const id = (r as { id?: unknown }).id;
    if (typeof id !== 'string' || !/^order_[A-Za-z0-9]+$/.test(id)) throw new RazorpayError('REJECTED', null, null, 'unexpected order response');
    return { id };
  }

  async fetchPayment(paymentId: string): Promise<RzpPayment> {
    return toPayment(await this.call('GET', `/v1/payments/${encodeURIComponent(paymentId)}`));
  }

  async capturePayment(paymentId: string, amountMinor: number, currency: string): Promise<RzpPayment> {
    return toPayment(await this.call('POST', `/v1/payments/${encodeURIComponent(paymentId)}/capture`, { amount: amountMinor, currency }));
  }

  async listOrderPayments(orderId: string): Promise<RzpPayment[]> {
    const r = (await this.call('GET', `/v1/orders/${encodeURIComponent(orderId)}/payments`)) as { items?: unknown };
    return Array.isArray(r.items) ? r.items.map(toPayment) : [];
  }

  private async call(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.timeoutMs);
    try {
      const res = await this.fetchFn(`${this.base}${path}`, {
        method,
        headers: { authorization: this.auth, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: ctl.signal,
      });
      const text = await res.text();
      let json: unknown = null;
      try { json = text ? JSON.parse(text) : null; } catch { json = null; }
      if (res.status < 200 || res.status >= 300) {
        const err = (json as { error?: { code?: unknown; description?: unknown } } | null)?.error;
        const kind: RazorpayErrorKind = res.status === 401 || res.status === 403 ? 'AUTH' : res.status === 429 || res.status >= 500 ? 'UNAVAILABLE' : res.status === 400 || res.status === 404 || res.status === 422 ? 'BAD_REQUEST' : 'REJECTED';
        throw new RazorpayError(kind, res.status, typeof err?.code === 'string' ? err.code.slice(0, 60) : null, safeText(err?.description));
      }
      if (json === null || typeof json !== 'object') throw new RazorpayError('REJECTED', res.status, null, 'unreadable response');
      return json;
    } catch (e) {
      if (e instanceof RazorpayError) throw e;
      throw new RazorpayError('UNAVAILABLE', null, null, ctl.signal.aborted ? 'timeout' : 'network error'); // never forward the raw error (may carry the URL)
    } finally {
      clearTimeout(timer);
    }
  }
}

function toPayment(v: unknown): RzpPayment {
  const o = v as { id?: unknown; order_id?: unknown; status?: unknown; amount?: unknown; currency?: unknown; error_description?: unknown };
  if (typeof o?.id !== 'string' || typeof o.status !== 'string' || typeof o.amount !== 'number' || typeof o.currency !== 'string') throw new RazorpayError('REJECTED', null, null, 'unexpected payment response');
  return { id: o.id, orderId: typeof o.order_id === 'string' ? o.order_id : null, status: o.status, amountMinor: o.amount, currency: o.currency, failureText: safeText(o.error_description) };
}