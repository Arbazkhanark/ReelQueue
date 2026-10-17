-- 0003: upload lifecycle support.
--  * storage_deleted_at: set once the object behind a dead/deleted video has been removed from storage (cleanup is retried until set).
--  * validation_attempts: bounded retries of media probing before a file is rejected as unreadable.
--  * a REJECTED/FAILED video must say why (machine code).
BEGIN;
ALTER TABLE videos ADD COLUMN storage_deleted_at timestamptz;
ALTER TABLE videos ADD COLUMN validation_attempts integer NOT NULL DEFAULT 0 CHECK (validation_attempts >= 0);
ALTER TABLE videos ADD CONSTRAINT videos_dead_has_reason CHECK (status NOT IN ('REJECTED','FAILED') OR rejection_reason IS NOT NULL);
CREATE INDEX videos_unpurged_idx ON videos (updated_at) WHERE storage_deleted_at IS NULL AND (status IN ('REJECTED','FAILED') OR deleted_at IS NOT NULL);
COMMIT;
