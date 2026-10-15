# Database

PostgreSQL 14+ (verified on 16.15). Schema source: `apps/api/migrations-sql/0001_init.sql`.
TypeORM migrations wrap these SQL files (`synchronize` is **never** enabled).

## ER diagram

```mermaid
erDiagram
  users ||--o{ refresh_tokens : has
  users ||--o{ auth_tokens : has
  users ||--|| user_settings : configures
  users ||--|| storage_usage : accounts
  users ||--o{ instagram_accounts : owns
  users ||--o{ upload_batches : starts
  users ||--o{ videos : owns
  users ||--o{ publishing_cycles : runs
  users ||--o{ publish_jobs : owns
  users ||--o{ audit_logs : "subject of"
  upload_batches ||--o{ videos : contains
  instagram_accounts ||--o{ publishing_cycles : "published to by"
  publishing_cycles ||--o{ publish_jobs : schedules
  videos ||--o{ publish_jobs : "published as"
  publish_jobs ||--o{ publish_attempts : logs

  users { uuid id PK
    text email UK
    text role "USER|ADMIN"
    text status }
  instagram_accounts { uuid id PK
    uuid user_id FK
    text provider "META|MOCK"
    text provider_account_id
    text status
    text access_token_enc "AES-GCM envelope"
    timestamptz token_expires_at }
  videos { uuid id PK
    uuid user_id FK
    text storage_key UK
    text status
    int position
    timestamptz deleted_at }
  publishing_cycles { uuid id PK
    uuid user_id FK
    uuid instagram_account_id FK
    text status
    timestamptz started_at
    timestamptz ends_at
    timestamptz next_batch_at
    int cursor_last_position
    int cursor_iteration }
  publish_jobs { uuid id PK
    uuid user_id FK
    uuid cycle_id FK
    uuid video_id FK
    bigint sequence_no
    text idempotency_key UK
    text status
    timestamptz publish_requested_at
    text container_id
    text media_id
    text lease_owner }
  publish_attempts { uuid id PK
    uuid job_id FK
    text step
    text outcome }
  audit_logs { uuid id PK
    uuid user_id FK
    text action }
```

## Key relationships and why

* **Tenant integrity is enforced by the database.** Every child table carries `user_id` and references its parent via a
  composite key, e.g. `publish_jobs (video_id, user_id) → videos (id, user_id)`. A job of user B cannot reference a video,
  account or cycle of user A, even through an application bug.
* **Duplicate prevention:** `UNIQUE(idempotency_key)`, `UNIQUE(cycle_id, video_id, iteration)`,
  `UNIQUE(instagram_account_id, sequence_no)`.
* **One live cycle per Instagram account:** partial unique index on `publishing_cycles(instagram_account_id) WHERE status IN ('ACTIVE','PAUSED')`.
* **Videos in use cannot be removed:** `publish_jobs.video_id → videos` is `ON DELETE RESTRICT`; the API soft-deletes (`deleted_at`) and only hard-deletes objects with no job rows.
* **Honest status:** `CHECK` constraints forbid MOCK jobs from being `ACCEPTED/CONFIRMED` and META jobs from being `SIMULATED`.
* **Settings snapshot:** a cycle copies batch size / interval / loop at start; later edits never change a running cycle.
* **Cascade choices:** deleting a user cascades to their data (account-deletion workflow, after a grace period);
  `audit_logs.user_id` is `SET NULL` so history survives; `audit_logs` rows are immutable (trigger).
* **Indexes:** due jobs (`publish_jobs_due_idx`), account ordering, active/due/expiring cycles, per-user queues and history, token expiry, open upload batches.

## Verification (run on PostgreSQL 16.15)

```bash
# applies 0001_init.sql to a fresh database and runs 18 invariant checks
PGDATABASE=reelqueue_verify ./scripts/verify-db.sh
```

Checks: cross-tenant FK rejection (video, account, default account), duplicate key/slot/sequence, mock-never-confirmed,
mock ids, referenced-video delete blocked, single live cycle, config bounds, terminal-cycle `ended_at`, audit immutability,
reconnect after disconnect.

## Not covered by the schema (application-level)

Row-level security (optional hardening), state-transition legality (enforced in `@reelqueue/core` `assertTransition`),
`storage_usage` consistency (updated in the same transaction as video changes; nightly recalculation job planned).
