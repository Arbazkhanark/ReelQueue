-- ALTER TABLE videos
--   ADD COLUMN source_type text NOT NULL DEFAULT 'S3'
--     CHECK (source_type IN ('S3', 'GOOGLE_DRIVE')),
--   ADD COLUMN google_drive_file_id text;

-- ALTER TABLE videos
--   ADD CONSTRAINT videos_google_drive_source_check
--   CHECK (
--     (source_type = 'S3' AND google_drive_file_id IS NULL)
--     OR
--     (source_type = 'GOOGLE_DRIVE' AND google_drive_file_id IS NOT NULL)
--   );

-- CREATE INDEX videos_google_drive_source_idx
--   ON videos (user_id, google_drive_file_id)
--   WHERE source_type = 'GOOGLE_DRIVE' AND deleted_at IS NULL;







-- 0007: a video can live in the user's Google Drive instead of object storage.
-- For GOOGLE_DRIVE rows `storage_key` is a synthetic, unique placeholder and `storage_deleted_at` is set at creation
-- ("there is no object of ours to delete"), so the object-cleanup sweeps never touch them.
BEGIN;

ALTER TABLE videos ADD COLUMN IF NOT EXISTS source_type text NOT NULL DEFAULT 'S3';
ALTER TABLE videos ADD COLUMN IF NOT EXISTS google_drive_file_id text;

-- Idempotent: also replaces an earlier hand-applied variant of these objects.
ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_source_type_check;
ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_google_drive_source_check;
ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_source_type_valid;
ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_source_consistent;
ALTER TABLE videos DROP CONSTRAINT IF EXISTS videos_drive_has_no_object;
ALTER TABLE videos ADD CONSTRAINT videos_source_type_valid CHECK (source_type IN ('S3', 'GOOGLE_DRIVE'));
ALTER TABLE videos ADD CONSTRAINT videos_source_consistent CHECK (
  (source_type = 'S3' AND google_drive_file_id IS NULL) OR (source_type = 'GOOGLE_DRIVE' AND google_drive_file_id IS NOT NULL)
);
ALTER TABLE videos ADD CONSTRAINT videos_drive_has_no_object CHECK (source_type = 'S3' OR storage_deleted_at IS NOT NULL);

DROP INDEX IF EXISTS videos_google_drive_source_idx;
-- The same Drive file cannot be imported twice by one user (live rows only).
CREATE UNIQUE INDEX IF NOT EXISTS videos_google_drive_unique
  ON videos (user_id, google_drive_file_id) WHERE source_type = 'GOOGLE_DRIVE' AND deleted_at IS NULL;

COMMIT;