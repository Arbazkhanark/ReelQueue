-- 0008_billing.sql  —  7-day trial + paid weeks (Razorpay). Idempotent: safe to run twice.
--
--  * billing_accounts: one row per user, created lazily on first use (trial starts then, so existing users are not locked out by the migration).
--  * billing_payments: one row per Razorpay order. The unique indexes + the status guard in the UPDATE make crediting exactly-once.
--  * Amount, currency and weeks are decided by the SERVER; CHECKs keep plan/currency consistent even if code has a bug.

BEGIN;

CREATE TABLE IF NOT EXISTS billing_accounts (
  user_id        uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  trial_ends_at  timestamptz NOT NULL,
  paid_until     timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS billing_payments (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider             text NOT NULL DEFAULT 'RAZORPAY' CHECK (provider IN ('RAZORPAY')),
  plan                 text NOT NULL CHECK (plan IN ('UPI_INR', 'INTL_USD')),
  currency             text NOT NULL CHECK (currency IN ('INR', 'USD')),
  amount_minor         integer NOT NULL CHECK (amount_minor > 0),
  weeks                integer NOT NULL CHECK (weeks BETWEEN 1 AND 52),
  status               text NOT NULL DEFAULT 'CREATED' CHECK (status IN ('CREATED', 'PAID', 'FAILED')),
  provider_order_id    text NOT NULL,
  provider_payment_id  text,
  paid_at              timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT billing_payments_plan_currency CHECK ((plan = 'UPI_INR' AND currency = 'INR') OR (plan = 'INTL_USD' AND currency = 'USD')),
  CONSTRAINT billing_payments_paid_consistent CHECK ((status = 'PAID') = (paid_at IS NOT NULL AND provider_payment_id IS NOT NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS billing_payments_order_key ON billing_payments (provider_order_id);
CREATE UNIQUE INDEX IF NOT EXISTS billing_payments_payment_key ON billing_payments (provider_payment_id) WHERE provider_payment_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS billing_payments_user_idx ON billing_payments (user_id, created_at DESC);

-- Why the last attempt on an order failed (a short, sanitised provider text). The order stays payable: the customer can retry inside the same checkout.
ALTER TABLE billing_payments ADD COLUMN IF NOT EXISTS last_failure    text CHECK (last_failure IS NULL OR length(last_failure) <= 200);
ALTER TABLE billing_payments ADD COLUMN IF NOT EXISTS last_failure_at timestamptz;

-- Webhook de-duplication. A row is CLAIMED when processing starts and finished (processed_at) when it succeeds, so a delivery that
-- crashed half-way is retried by the provider, while a delivery that already succeeded is skipped.
CREATE TABLE IF NOT EXISTS billing_webhook_events (
  event_id      text PRIMARY KEY CHECK (length(event_id) BETWEEN 1 AND 100),
  event_type    text NOT NULL CHECK (length(event_type) <= 60),
  attempts      integer NOT NULL DEFAULT 1,
  received_at   timestamptz NOT NULL DEFAULT now(),
  processed_at  timestamptz
);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'billing_accounts_set_updated_at') THEN
    CREATE TRIGGER billing_accounts_set_updated_at BEFORE UPDATE ON billing_accounts FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'billing_payments_set_updated_at') THEN
    CREATE TRIGGER billing_payments_set_updated_at BEFORE UPDATE ON billing_payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  END IF;
END $$;

COMMIT;