-- Invariant checks for 0005_oauth_retention_ratelimit.sql (single rolled-back transaction).
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

SELECT pg_temp.expect_error('purged video must be soft-deleted and its object gone',
  $$INSERT INTO videos (user_id, original_filename, storage_key, content_type, size_bytes, purged_at)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'a.mp4', 'k/1', 'video/mp4', 1, now())$$, '23514');
SELECT pg_temp.expect_error('purged video with deleted_at but object still stored is refused',
  $$INSERT INTO videos (user_id, original_filename, storage_key, content_type, size_bytes, deleted_at, purged_at)
    VALUES ('00000000-0000-0000-0000-00000000000a', 'a.mp4', 'k/2', 'video/mp4', 1, now(), now())$$, '23514');
INSERT INTO videos (user_id, original_filename, storage_key, content_type, size_bytes, deleted_at, storage_deleted_at, purged_at)
  VALUES ('00000000-0000-0000-0000-00000000000a', 'a.mp4', 'k/3', 'video/mp4', 1, now(), now(), now());
DO $$ BEGIN RAISE NOTICE 'ok   - purged video with object gone is accepted'; END $$;
SELECT pg_temp.expect_error('rate limit count must be positive',
  $$INSERT INTO rate_limits (key, window_ends_at, count) VALUES ('k', now(), 0)$$, '23514');
SELECT pg_temp.expect_error('rate limit key is unique',
  $$INSERT INTO rate_limits (key, window_ends_at, count) VALUES ('dup', now(), 1), ('dup', now(), 1)$$, '23505');
INSERT INTO audit_logs (id, user_id, action) VALUES ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-00000000000a', 'X');
SELECT pg_temp.expect_error('audit log content is still immutable',
  $$UPDATE audit_logs SET action = 'Y'$$, '23000');
SELECT pg_temp.expect_error('audit log cannot be re-pointed at another user',
  $$UPDATE audit_logs SET user_id = '00000000-0000-0000-0000-00000000000b'$$, '23000');
DELETE FROM users WHERE id = '00000000-0000-0000-0000-00000000000a';
DO $$ BEGIN
  IF (SELECT user_id FROM audit_logs WHERE id = '00000000-0000-0000-0000-0000000000a1') IS NOT NULL THEN RAISE EXCEPTION 'INVARIANT BROKEN: audit row not detached'; END IF;
  RAISE NOTICE 'ok   - deleting a user detaches (not deletes) their audit rows';
END $$;
ROLLBACK;
