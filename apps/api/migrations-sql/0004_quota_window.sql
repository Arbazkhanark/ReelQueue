-- 0004: remember the quota window length reported by the provider next to the usage numbers (never assumed to be 24 h).
BEGIN;
ALTER TABLE instagram_accounts ADD COLUMN last_quota_window_seconds integer CHECK (last_quota_window_seconds > 0);
COMMIT;
