-- Invariant checks for 0006_google_drive.sql (single rolled-back transaction).
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

INSERT INTO users (id, email, password_hash) VALUES ('00000000-0000-0000-0000-0000000000d1', 'd1@example.test', 'x'), ('00000000-0000-0000-0000-0000000000d2', 'd2@example.test', 'x');
INSERT INTO google_drive_connections (user_id, access_token_enc, refresh_token_enc, token_expires_at, scopes)
  VALUES ('00000000-0000-0000-0000-0000000000d1', 'a', 'r', now() + interval '1 hour', ARRAY['https://www.googleapis.com/auth/drive.file']);
DO $$ BEGIN RAISE NOTICE 'ok   - a connection can be stored'; END $$;

SELECT pg_temp.expect_error('one Drive connection per user',
  $$INSERT INTO google_drive_connections (user_id, access_token_enc, refresh_token_enc, token_expires_at, scopes)
    VALUES ('00000000-0000-0000-0000-0000000000d1', 'a', 'r', now(), ARRAY['x'])$$, '23505');
SELECT pg_temp.expect_error('status must be a known value',
  $$INSERT INTO google_drive_connections (user_id, access_token_enc, refresh_token_enc, token_expires_at, scopes, status)
    VALUES ('00000000-0000-0000-0000-0000000000d2', 'a', 'r', now(), ARRAY['x'], 'WEIRD')$$, '23514');
SELECT pg_temp.expect_error('scopes cannot be empty',
  $$INSERT INTO google_drive_connections (user_id, access_token_enc, refresh_token_enc, token_expires_at, scopes)
    VALUES ('00000000-0000-0000-0000-0000000000d2', 'a', 'r', now(), ARRAY[]::text[])$$, '23514');
SELECT pg_temp.expect_error('a refresh token is mandatory',
  $$INSERT INTO google_drive_connections (user_id, access_token_enc, refresh_token_enc, token_expires_at, scopes)
    VALUES ('00000000-0000-0000-0000-0000000000d2', 'a', NULL, now(), ARRAY['x'])$$, '23502');
SELECT pg_temp.expect_error('oauth state must expire after creation',
  $$INSERT INTO google_oauth_states (state_hash, user_id, code_verifier_enc, created_at, expires_at)
    VALUES ('h1', '00000000-0000-0000-0000-0000000000d1', 'v', now(), now() - interval '1 minute')$$, '23514');
INSERT INTO google_oauth_states (state_hash, user_id, code_verifier_enc, expires_at) VALUES ('h2', '00000000-0000-0000-0000-0000000000d1', 'v', now() + interval '10 minutes');
SELECT pg_temp.expect_error('oauth state hash is unique',
  $$INSERT INTO google_oauth_states (state_hash, user_id, code_verifier_enc, expires_at) VALUES ('h2', '00000000-0000-0000-0000-0000000000d2', 'v', now() + interval '10 minutes')$$, '23505');
DELETE FROM users WHERE id = '00000000-0000-0000-0000-0000000000d1';
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM google_drive_connections WHERE user_id = '00000000-0000-0000-0000-0000000000d1') OR EXISTS (SELECT 1 FROM google_oauth_states WHERE state_hash = 'h2') THEN
    RAISE EXCEPTION 'INVARIANT BROKEN: deleting a user must remove its Drive connection and pending states';
  END IF;
  RAISE NOTICE 'ok   - deleting a user cascades to the Drive connection and OAuth states';
END $$;
ROLLBACK;