// apps/web/src/lib/razorpay.ts
// Loads Razorpay Checkout on demand and wraps it in a promise. UPI / card details are typed inside Razorpay's own window; ReelQueue never sees them.
import type { CreateCheckoutResponse } from '@reelqueue/shared';

export interface RazorpaySuccess { razorpay_payment_id: string; razorpay_order_id: string; razorpay_signature: string }
interface RazorpayFailure { error?: { description?: string } }
interface RazorpayOptions {
  key: string; order_id: string; amount: number; currency: string; name: string; description: string;
  theme?: { color: string };
  config?: unknown;
  handler: (r: RazorpaySuccess) => void;
  modal?: { ondismiss?: () => void };
}
interface RazorpayInstance { open(): void; on(event: 'payment.failed', cb: (r: RazorpayFailure) => void): void }
declare global { interface Window { Razorpay?: new (o: RazorpayOptions) => RazorpayInstance } }

export class CheckoutCancelled extends Error { constructor() { super('Checkout closed'); this.name = 'CheckoutCancelled'; } }

const SRC = 'https://checkout.razorpay.com/v1/checkout.js';

export function loadRazorpay(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('Checkout only works in the browser.'));
  if (window.Razorpay) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(`script[src="${SRC}"]`);
    const s = existing ?? Object.assign(document.createElement('script'), { src: SRC, async: true });
    s.addEventListener('load', () => resolve(), { once: true });
    s.addEventListener('error', () => reject(new Error('Could not load the payment window. Check your connection or ad-blocker and try again.')), { once: true });
    if (!existing) document.head.appendChild(s);
  });
}

/** Opens Razorpay Checkout for an order the server created. The India option shows UPI only; the dollar option shows Razorpay's normal international card flow. */
export function openCheckout(c: CreateCheckoutResponse): Promise<RazorpaySuccess> {
  return new Promise((resolve, reject) => {
    const Rzp = window.Razorpay;
    if (!Rzp) { reject(new Error('The payment window is not available. Please reload and try again.')); return; }
    const upiOnly = c.plan === 'UPI_INR';
    const rzp = new Rzp({
      key: c.keyId, order_id: c.orderId, amount: c.amountMinor, currency: c.currency, name: 'ReelQueue', description: c.description, theme: { color: '#111827' },
      ...(upiOnly ? { config: { display: { blocks: { upi: { name: 'Pay with UPI', instruments: [{ method: 'upi' }] } }, sequence: ['block.upi'], preferences: { show_default_blocks: false } } } } : {}),
      handler: (r) => resolve(r),
      modal: { ondismiss: () => reject(new CheckoutCancelled()) },
    });
    rzp.on('payment.failed', (r) => reject(new Error((r.error?.description ?? 'The payment failed. You were not charged, or the amount will be refunded by your bank.').slice(0, 200))));
    rzp.open();
  });
}