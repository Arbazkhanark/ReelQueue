// packages/services/src/billing-config.ts
export interface BillingEnv { keyId: string; keySecret: string; webhookSecret?: string; enforce: boolean }

/**
 * Billing is OFF (nothing charged, nothing locked) until both Razorpay keys exist.
 *   RAZORPAY_KEY_ID      rzp_test_... or rzp_live_...
 *   RAZORPAY_KEY_SECRET  the matching secret (server only)
 *   RAZORPAY_WEBHOOK_SECRET  optional; the secret you typed in Dashboard > Webhooks. Without it webhooks are still safe (the payment is re-read from Razorpay before crediting).
 *   BILLING_ENFORCE      optional; "false" keeps payments working but never blocks anyone (handy while testing)
 */
export function loadBillingConfig(env: Record<string, string | undefined>): BillingEnv | null {
  const keyId = env.RAZORPAY_KEY_ID?.trim();
  const keySecret = env.RAZORPAY_KEY_SECRET?.trim();
  if (!keyId || !keySecret) return null;
  if (!/^rzp_(test|live)_[A-Za-z0-9]{6,}$/.test(keyId)) throw new Error('RAZORPAY_KEY_ID is not a valid Razorpay key id (expected rzp_test_... or rzp_live_...).');
  const webhookSecret = env.RAZORPAY_WEBHOOK_SECRET?.trim();
  return { keyId, keySecret, ...(webhookSecret ? { webhookSecret } : {}), enforce: env.BILLING_ENFORCE?.trim().toLowerCase() !== 'false' };
}