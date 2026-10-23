-- 0006: Google Drive connections (optional integration; S3 storage is untouched) and short-lived OAuth state.
BEGIN;

-- One Drive connection per user. Tokens are AES-GCM envelopes (never plaintext). ON DELETE CASCADE: hard-deleting a user removes it.
CREATE TABLE google_drive_connections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  google_account_id  text,                          -- Drive "permissionId" of the user (stable id; no e-mail stored)
  access_token_enc   text NOT NULL,
  refresh_token_enc  text NOT NULL,
  token_expires_at   timestamptz NOT NULL,
  scopes             text[] NOT NULL,
  status             text NOT NULL DEFAULT 'CONNECTED' CHECK (status IN ('CONNECTED', 'REAUTH_REQUIRED')),
  app_folder_id      text,                          -- the "ReelQueue" folder created by this app in the user's Drive
  last_error_code    text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gdrive_scopes_not_empty CHECK (cardinality(scopes) > 0)
);

-- OAuth `state`: only a SHA-256 hash is stored; single use (consumed by DELETE ... RETURNING); bound to the user; expires.
CREATE TABLE google_oauth_states (
  state_hash         text PRIMARY KEY,
  user_id            uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_verifier_enc  text NOT NULL,                 -- PKCE verifier, encrypted
  created_at         timestamptz NOT NULL DEFAULT now(),
  expires_at         timestamptz NOT NULL,
  CONSTRAINT gdrive_state_expiry_after_creation CHECK (expires_at > created_at)
);
CREATE INDEX google_oauth_states_user_idx ON google_oauth_states (user_id);
CREATE INDEX google_oauth_states_expiry_idx ON google_oauth_states (expires_at);

COMMIT;