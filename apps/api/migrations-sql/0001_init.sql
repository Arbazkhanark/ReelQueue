-- 0001_init.sql  —  ReelQueue initial schema (PostgreSQL 14+; verified on 16)
--
-- Design rules
--  * UUID primary keys (gen_random_uuid(), built in since PG13).
--  * Status columns are TEXT + CHECK (not native enums): adding a status later is a
--    plain constraint swap instead of a risky ALTER TYPE.
--  * Tenant integrity is enforced by the DATABASE, not just by the API: every
--    child row carries user_id and references its parent through a composite FK
--    (parent_id, user_id). A row can therefore never point at another tenant's
--    video / account / cycle, even if application code has a bug.
--  * Timestamps are timestamptz. updated_at is maintained by a trigger.
--  * Tokens are stored only as AES-GCM envelopes ("v1:keyId:iv:ct:tag"), never plaintext.

BEGIN;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- ---------------------------------------------------------------- users
CREATE TABLE users (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email              text NOT NULL,
  password_hash      text NOT NULL,                       -- argon2id encoded hash
  role               text NOT NULL DEFAULT 'USER'   CHECK (role   IN ('USER','ADMIN')),
  status             text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','PENDING_DELETION')),
  email_verified_at  timestamptz,
  failed_login_count integer NOT NULL DEFAULT 0 CHECK (failed_login_count >= 0),
  locked_until       timestamptz,
  deletion_requested_at timestamptz,                      -- retention workflow: hard delete after grace period
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT users_email_lowercase CHECK (email = lower(email))
);
CREATE UNIQUE INDEX users_email_key ON users (email);
CREATE INDEX users_status_idx ON users (status);
CREATE INDEX users_pending_deletion_idx ON users (deletion_requested_at) WHERE status = 'PENDING_DELETION';

-- ------------------------------------------------- refresh tokens (sessions)
-- Opaque random tokens; only SHA-256 hashes are stored. Rotation: each use
-- revokes the row and issues a child (replaced_by); reuse of a revoked token
-- revokes the whole family (family_id).
CREATE TABLE refresh_tokens (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  family_id     uuid NOT NULL,
  token_hash    text NOT NULL,
  expires_at    timestamptz NOT NULL,
  revoked_at    timestamptz,
  replaced_by   uuid REFERENCES refresh_tokens (id) ON DELETE SET NULL,
  user_agent    text,
  ip_hash       text,                                      -- hashed, never the raw IP
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX refresh_tokens_hash_key ON refresh_tokens (token_hash);
CREATE INDEX refresh_tokens_user_idx ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_family_idx ON refresh_tokens (family_id);
CREATE INDEX refresh_tokens_expiry_idx ON refresh_tokens (expires_at);

-- ------------------------------------- one-time tokens (verify email / reset)
CREATE TABLE auth_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose     text NOT NULL CHECK (purpose IN ('EMAIL_VERIFICATION','PASSWORD_RESET')),
  token_hash  text NOT NULL,
  expires_at  timestamptz NOT NULL,
  used_at     timestamptz,                                -- single use
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX auth_tokens_hash_key ON auth_tokens (token_hash);
CREATE INDEX auth_tokens_user_purpose_idx ON auth_tokens (user_id, purpose);

-- ------------------------------------------------------------ user_settings
CREATE TABLE user_settings (
  user_id               uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  timezone              text NOT NULL DEFAULT 'UTC',
  -- scheduler defaults; bounds mirror SCHEDULER_LIMITS in @reelqueue/core
  batch_size            integer NOT NULL DEFAULT 1    CHECK (batch_size BETWEEN 1 AND 50),
  interval_minutes      integer NOT NULL DEFAULT 20   CHECK (interval_minutes BETWEEN 5 AND 1440),
  cycle_duration_hours  integer NOT NULL DEFAULT 24   CHECK (cycle_duration_hours BETWEEN 1 AND 168),
  loop_enabled          boolean NOT NULL DEFAULT false,
  default_instagram_account_id uuid,
  -- per-user limits (future plans plug in here)
  storage_quota_bytes   bigint NOT NULL DEFAULT 5368709120 CHECK (storage_quota_bytes >= 0),
  max_videos            integer NOT NULL DEFAULT 500       CHECK (max_videos >= 0),
  max_upload_batch      integer NOT NULL DEFAULT 200       CHECK (max_upload_batch BETWEEN 1 AND 500),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- -------------------------------------------------------- instagram_accounts
CREATE TABLE instagram_accounts (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  provider              text NOT NULL CHECK (provider IN ('META','MOCK')),
  provider_account_id   text NOT NULL,                    -- IG user id as returned by Meta
  username              text,
  account_type          text,                             -- as reported by the API; not assumed
  status                text NOT NULL DEFAULT 'CONNECTED'
                        CHECK (status IN ('CONNECTED','REAUTH_REQUIRED','PERMISSION_REVOKED','DISCONNECTED')),
  granted_scopes        text[] NOT NULL DEFAULT '{}',
  -- AES-256-GCM envelope "v1:<keyId>:<iv>:<ct>:<tag>". NEVER returned by any API.
  access_token_enc      text,
  token_issued_at       timestamptz,
  token_expires_at      timestamptz,
  last_refreshed_at     timestamptz,
  last_quota_used       integer CHECK (last_quota_used >= 0),
  last_quota_total      integer CHECK (last_quota_total >= 0),
  last_quota_fetched_at timestamptz,
  last_error_code       text,
  disconnected_at       timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),                                   -- target of composite tenant FKs
  CONSTRAINT ig_mock_has_no_real_provider_id CHECK (provider <> 'MOCK' OR provider_account_id LIKE 'mock\_%'),
  CONSTRAINT ig_connected_has_token CHECK (status = 'DISCONNECTED' OR access_token_enc IS NOT NULL)
);
-- A real IG account can be connected by at most one user at a time (live rows only).
CREATE UNIQUE INDEX instagram_accounts_live_provider_key
  ON instagram_accounts (provider, provider_account_id) WHERE status <> 'DISCONNECTED';
CREATE INDEX instagram_accounts_user_idx ON instagram_accounts (user_id);
CREATE INDEX instagram_accounts_token_expiry_idx ON instagram_accounts (token_expires_at)
  WHERE status = 'CONNECTED';

ALTER TABLE user_settings
  ADD CONSTRAINT user_settings_default_account_fk
  FOREIGN KEY (default_instagram_account_id, user_id) REFERENCES instagram_accounts (id, user_id);

-- ------------------------------------------------------------ upload_batches
-- One bulk-upload session (100–200 files). Tracks progress and failures.
CREATE TABLE upload_batches (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  status           text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','COMPLETED','ABANDONED')),
  declared_files   integer NOT NULL CHECK (declared_files > 0),
  declared_bytes   bigint  NOT NULL CHECK (declared_bytes >= 0),
  completed_files  integer NOT NULL DEFAULT 0 CHECK (completed_files >= 0),
  failed_files     integer NOT NULL DEFAULT 0 CHECK (failed_files >= 0),
  expires_at       timestamptz NOT NULL,                  -- presigned URLs & reservation expire
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id)
);
CREATE INDEX upload_batches_user_idx ON upload_batches (user_id, created_at DESC);
CREATE INDEX upload_batches_open_expiry_idx ON upload_batches (expires_at) WHERE status = 'OPEN';

-- -------------------------------------------------------------------- videos
CREATE TABLE videos (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  upload_batch_id    uuid,
  original_filename  text NOT NULL,
  storage_key        text NOT NULL,                       -- object key only; never a permanent public URL
  content_type       text NOT NULL,
  size_bytes         bigint NOT NULL CHECK (size_bytes >= 0),
  duration_ms        integer CHECK (duration_ms > 0),
  width              integer CHECK (width > 0),
  height             integer CHECK (height > 0),
  status             text NOT NULL DEFAULT 'PENDING_UPLOAD'
                     CHECK (status IN ('PENDING_UPLOAD','VALIDATING','READY','REJECTED','FAILED')),
  rejection_reason   text,                                -- machine code, e.g. UNSUPPORTED_FORMAT
  caption            text CHECK (char_length(caption) <= 2200),
  position           integer NOT NULL DEFAULT 0,          -- publishing sequence; ties broken by id
  deleted_at         timestamptz,                         -- soft delete: jobs keep history
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  FOREIGN KEY (upload_batch_id, user_id) REFERENCES upload_batches (id, user_id) ON DELETE SET NULL (upload_batch_id)
);
CREATE UNIQUE INDEX videos_storage_key_key ON videos (storage_key);
CREATE INDEX videos_user_queue_idx ON videos (user_id, position, id) WHERE status = 'READY' AND deleted_at IS NULL;
CREATE INDEX videos_user_idx ON videos (user_id, created_at DESC);
CREATE INDEX videos_batch_idx ON videos (upload_batch_id);

-- ---------------------------------------------------------- publishing_cycles
CREATE TABLE publishing_cycles (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  instagram_account_id  uuid NOT NULL,
  provider              text NOT NULL CHECK (provider IN ('META','MOCK')),
  status                text NOT NULL DEFAULT 'ACTIVE'
                        CHECK (status IN ('ACTIVE','PAUSED','STOPPED','EXPIRED','COMPLETED')),
  pause_reason          text,
  -- settings SNAPSHOT at start: later edits to user_settings never alter a running cycle
  batch_size            integer NOT NULL CHECK (batch_size BETWEEN 1 AND 50),
  interval_minutes      integer NOT NULL CHECK (interval_minutes BETWEEN 5 AND 1440),
  loop_enabled          boolean NOT NULL,
  started_at            timestamptz NOT NULL,
  ends_at               timestamptz NOT NULL,
  next_batch_at         timestamptz NOT NULL,
  cursor_last_position  integer NOT NULL DEFAULT -1,
  cursor_iteration      integer NOT NULL DEFAULT 1 CHECK (cursor_iteration >= 1),
  next_sequence_no      bigint  NOT NULL DEFAULT 1 CHECK (next_sequence_no >= 1),
  ended_at              timestamptz,
  end_reason            text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  UNIQUE (id, instagram_account_id),
  FOREIGN KEY (instagram_account_id, user_id) REFERENCES instagram_accounts (id, user_id),
  CONSTRAINT cycle_window_valid CHECK (ends_at > started_at),
  CONSTRAINT cycle_ended_when_terminal CHECK ((status IN ('ACTIVE','PAUSED')) = (ended_at IS NULL))
);
-- At most ONE live cycle per Instagram account: two cycles can never publish
-- to the same account at once, and stale jobs of an old cycle cannot interleave.
CREATE UNIQUE INDEX publishing_cycles_one_live_per_account
  ON publishing_cycles (instagram_account_id) WHERE status IN ('ACTIVE','PAUSED');
CREATE INDEX publishing_cycles_user_idx ON publishing_cycles (user_id, started_at DESC);
CREATE INDEX publishing_cycles_due_idx ON publishing_cycles (next_batch_at) WHERE status = 'ACTIVE';
CREATE INDEX publishing_cycles_expiry_idx ON publishing_cycles (ends_at) WHERE status IN ('ACTIVE','PAUSED');

-- -------------------------------------------------------------- publish_jobs
-- Mirrors PublishJobRecord in @reelqueue/core. Distinct truths:
--   SCHEDULED = our intent | ACCEPTED = API accepted media_publish | CONFIRMED = verified
--   SIMULATED = MOCK provider only; never reported as a real publication.
CREATE TABLE publish_jobs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  cycle_id              uuid NOT NULL,
  instagram_account_id  uuid NOT NULL,
  video_id              uuid NOT NULL,
  sequence_no           bigint  NOT NULL CHECK (sequence_no >= 1),
  iteration             integer NOT NULL CHECK (iteration >= 1),
  idempotency_key       text    NOT NULL,                  -- sha256(cycleId:videoId:iteration)
  provider              text    NOT NULL CHECK (provider IN ('META','MOCK')),
  status                text    NOT NULL DEFAULT 'SCHEDULED' CHECK (status IN (
                          'SCHEDULED','DEFERRED','RETRY_WAIT','CREATING_CONTAINER','PROCESSING_MEDIA',
                          'PUBLISH_REQUESTED','ACCEPTED','CONFIRMED','SIMULATED','FAILED','CANCELLED','EXPIRED')),
  attempt_count         integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at       timestamptz NOT NULL,
  container_id          text,
  container_created_at  timestamptz,
  publish_requested_at  timestamptz,                       -- written BEFORE media_publish is called
  media_id              text,
  permalink             text,
  confirm_attempts      integer NOT NULL DEFAULT 0 CHECK (confirm_attempts >= 0),
  lease_owner           text,
  lease_expires_at      timestamptz,
  last_error_kind       text,
  last_error_code       text,
  failure_reason        text,
  retryable             boolean NOT NULL DEFAULT false,
  deferred_reason       text,
  version               integer NOT NULL DEFAULT 1,        -- optimistic concurrency
  queue_job_id          text,                              -- BullMQ id, for reconciliation only
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (id, user_id),
  -- duplicate prevention: one job per (cycle, video, pass), and per idempotency key
  CONSTRAINT publish_jobs_idempotency_key UNIQUE (idempotency_key),
  CONSTRAINT publish_jobs_slot_unique UNIQUE (cycle_id, video_id, iteration),
  CONSTRAINT publish_jobs_sequence_unique UNIQUE (instagram_account_id, sequence_no),
  -- tenant + account consistency enforced by the database
  FOREIGN KEY (cycle_id, user_id)                REFERENCES publishing_cycles (id, user_id) ON DELETE CASCADE,
  FOREIGN KEY (cycle_id, instagram_account_id)   REFERENCES publishing_cycles (id, instagram_account_id) ON DELETE CASCADE,
  -- RESTRICT: a video referenced by any job can never be hard-deleted
  FOREIGN KEY (video_id, user_id)                REFERENCES videos (id, user_id) ON DELETE RESTRICT,
  CONSTRAINT lease_pair CHECK ((lease_owner IS NULL) = (lease_expires_at IS NULL)),
  CONSTRAINT mock_never_confirmed CHECK (provider <> 'MOCK' OR status NOT IN ('ACCEPTED','CONFIRMED')),
  CONSTRAINT real_never_simulated CHECK (provider <> 'META' OR status <> 'SIMULATED'),
  CONSTRAINT published_has_container CHECK (status NOT IN ('ACCEPTED','CONFIRMED') OR container_id IS NOT NULL)
);
CREATE INDEX publish_jobs_due_idx ON publish_jobs (next_attempt_at)
  WHERE status IN ('SCHEDULED','DEFERRED','RETRY_WAIT','CREATING_CONTAINER','PROCESSING_MEDIA','PUBLISH_REQUESTED','ACCEPTED');
CREATE INDEX publish_jobs_account_order_idx ON publish_jobs (instagram_account_id, sequence_no);
CREATE INDEX publish_jobs_cycle_status_idx ON publish_jobs (cycle_id, status);
CREATE INDEX publish_jobs_user_history_idx ON publish_jobs (user_id, created_at DESC);
CREATE INDEX publish_jobs_video_idx ON publish_jobs (video_id);
CREATE INDEX publish_jobs_lease_idx ON publish_jobs (lease_expires_at) WHERE lease_owner IS NOT NULL;
CREATE INDEX publish_jobs_failed_idx ON publish_jobs (user_id) WHERE status = 'FAILED' AND retryable;

-- ---------------------------------------------------------- publish_attempts
-- Append-only log: one row per provider call. Error fields are sanitised codes,
-- never raw response bodies, tokens or URLs with signatures.
CREATE TABLE publish_attempts (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL,
  job_id       uuid NOT NULL,
  step         text NOT NULL CHECK (step IN
                 ('QUOTA_CHECK','CREATE_CONTAINER','POLL_STATUS','PUBLISH','RECONCILE','CONFIRM')),
  outcome      text NOT NULL CHECK (outcome IN ('SUCCESS','ERROR')),
  error_kind   text,
  error_code   text,
  http_status  integer,
  correlation_id text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (job_id, user_id) REFERENCES publish_jobs (id, user_id) ON DELETE CASCADE
);
CREATE INDEX publish_attempts_job_idx ON publish_attempts (job_id, created_at);
CREATE INDEX publish_attempts_user_idx ON publish_attempts (user_id, created_at DESC);

-- ---------------------------------------------------------------- audit_logs
CREATE TABLE audit_logs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES users (id) ON DELETE SET NULL,   -- target tenant
  actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  actor_role    text,
  action        text NOT NULL,                                   -- e.g. CYCLE_STARTED, IG_DISCONNECTED
  entity_type   text,
  entity_id     uuid,
  metadata      jsonb NOT NULL DEFAULT '{}'::jsonb,              -- must be pre-redacted by the app
  request_id    text,
  ip_hash       text,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_user_idx ON audit_logs (user_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);

CREATE FUNCTION audit_logs_immutable() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs rows are immutable' USING ERRCODE = 'integrity_constraint_violation';
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER audit_logs_no_update BEFORE UPDATE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_immutable();

-- ------------------------------------------------------------- storage_usage
CREATE TABLE storage_usage (
  user_id         uuid PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  bytes_used      bigint  NOT NULL DEFAULT 0 CHECK (bytes_used >= 0),
  bytes_reserved  bigint  NOT NULL DEFAULT 0 CHECK (bytes_reserved >= 0),  -- open upload batches
  video_count     integer NOT NULL DEFAULT 0 CHECK (video_count >= 0),
  recalculated_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------- updated_at triggers
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['users','user_settings','instagram_accounts','upload_batches',
                           'videos','publishing_cycles','publish_jobs','storage_usage']
  LOOP
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION set_updated_at()',
                   t || '_set_updated_at', t);
  END LOOP;
END $$;

COMMIT;
