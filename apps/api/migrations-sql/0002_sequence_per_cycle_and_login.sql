-- 0002: fix per-account sequence uniqueness + add last_login_at.
--
-- 0001 made (instagram_account_id, sequence_no) unique ACROSS cycles, but each cycle numbers its jobs from 1,
-- so a second cycle on the same account would collide. Ordering within a cycle is by sequence_no; ordering across
-- cycles is by cycle start (only one cycle per account is live at a time), enforced by the claim query.
BEGIN;
ALTER TABLE publish_jobs DROP CONSTRAINT publish_jobs_sequence_unique;
ALTER TABLE publish_jobs ADD CONSTRAINT publish_jobs_sequence_unique UNIQUE (cycle_id, sequence_no);
DROP INDEX publish_jobs_account_order_idx;
CREATE INDEX publish_jobs_account_order_idx ON publish_jobs (instagram_account_id, cycle_id, sequence_no);

ALTER TABLE users ADD COLUMN last_login_at timestamptz;
COMMIT;
