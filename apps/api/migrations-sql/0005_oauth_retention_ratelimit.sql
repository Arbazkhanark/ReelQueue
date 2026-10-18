-- 0005: token-refresh claim, hard-delete retention marker, shared rate-limit counters.
BEGIN;

-- Refresh claim (lease): at most one worker refreshes a given account's token at a time.
ALTER TABLE instagram_accounts ADD COLUMN token_refresh_claim_until timestamptz;

-- Retention: a soft-deleted video whose object is gone and whose personal data was scrubbed/removed.
ALTER TABLE videos ADD COLUMN purged_at timestamptz;
ALTER TABLE videos ADD CONSTRAINT videos_purged_requires_object_gone
  CHECK (purged_at IS NULL OR (deleted_at IS NOT NULL AND storage_deleted_at IS NOT NULL));
CREATE INDEX videos_retention_idx ON videos (deleted_at) WHERE deleted_at IS NOT NULL AND purged_at IS NULL;

-- Fixed-window counters shared by every API replica. UNLOGGED: counters may reset after a crash, which is acceptable.
CREATE UNLOGGED TABLE rate_limits (
  key            text PRIMARY KEY,
  window_ends_at timestamptz NOT NULL,
  count          integer NOT NULL CHECK (count > 0)
);
CREATE INDEX rate_limits_expiry_idx ON rate_limits (window_ends_at);

-- audit_logs stay immutable EXCEPT for the FK action ON DELETE SET NULL when a user is hard-deleted (account deletion
-- retention). Without this carve-out deleting any user that has audit rows would fail. Only user_id / actor_user_id may
-- change, and only to NULL.
CREATE OR REPLACE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  IF (NEW.id, NEW.actor_role, NEW.action, NEW.entity_type, NEW.entity_id, NEW.metadata, NEW.request_id, NEW.ip_hash, NEW.created_at)
       IS NOT DISTINCT FROM
     (OLD.id, OLD.actor_role, OLD.action, OLD.entity_type, OLD.entity_id, OLD.metadata, OLD.request_id, OLD.ip_hash, OLD.created_at)
     AND (NEW.user_id IS NULL OR NEW.user_id = OLD.user_id)
     AND (NEW.actor_user_id IS NULL OR NEW.actor_user_id = OLD.actor_user_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'audit_logs rows are immutable' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;

COMMIT;
