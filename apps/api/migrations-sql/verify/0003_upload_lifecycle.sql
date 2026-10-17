-- Invariant checks for 0003_upload_lifecycle.sql (single rolled-back transaction).
BEGIN;
CREATE OR REPLACE FUNCTION pg_temp.expect_error(label text, stmt text, expected_state text) RETURNS void AS $$
BEGIN
  EXECUTE stmt;
  RAISE EXCEPTION 'INVARIANT BROKEN (statement succeeded): %', label;
EXCEPTION WHEN OTHERS THEN
  IF SQLSTATE = expected_state THEN RAISE NOTICE 'ok   - %', label;
  ELSIF SQLERRM LIKE 'INVARIANT BROKEN%' THEN RAISE;
  ELSE RAISE EXCEPTION 'INVARIANT CHECK WRONG ERROR for %: got % (%), wanted %', label, SQLSTATE, SQLERRM, expected_state;
  END IF;
END;
$$ LANGUAGE plpgsql;

INSERT INTO users (id, email, password_hash) VALUES ('00000000-0000-0000-0000-00000000000a', 'a@example.test', 'x');

SELECT pg_temp.expect_error('REJECTED video without a reason is refused',
  $$INSERT INTO videos (user_id, original_filename, storage_key, content_type, size_bytes, status)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'a.mp4', 'k/1', 'video/mp4', 1, 'REJECTED')$$, '23514');
SELECT pg_temp.expect_error('FAILED video without a reason is refused',
  $$INSERT INTO videos (user_id, original_filename, storage_key, content_type, size_bytes, status)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'a.mp4', 'k/2', 'video/mp4', 1, 'FAILED')$$, '23514');
SELECT pg_temp.expect_error('negative validation_attempts is refused',
  $$INSERT INTO videos (user_id, original_filename, storage_key, content_type, size_bytes, validation_attempts)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'a.mp4', 'k/3', 'video/mp4', 1, -1)$$, '23514');
INSERT INTO videos (user_id, original_filename, storage_key, content_type, size_bytes, status, rejection_reason)
  VALUES ('00000000-0000-0000-0000-00000000000a', 'a.mp4', 'k/4', 'video/mp4', 1, 'REJECTED', 'SIZE_MISMATCH');
DO $$ BEGIN RAISE NOTICE 'ok   - REJECTED video with a reason is accepted'; END $$;
ROLLBACK;
