# Implementation status

Last updated: 2026-10-18 (session 5). Legend: **VERIFIED** = executed here with the stated result ·
**UNVERIFIED** = source written, never compiled/run (needs `pnpm install` on a networked machine) ·
**BLOCKED** = cannot proceed without something external · **NOT STARTED**.

Environment limit: `registry.npmjs.org` returns 403 in the build workspace, so Nest/TypeORM/BullMQ/Next/Playwright
could not be installed. Verification here uses Node 22, global `tsc` 6.0.3, `tsx`, PostgreSQL 16, Redis 7 only.

## Actually executed (results as observed, 2026-10-18; full regression run at the end of session 5)

| Check | Command | Result |
|---|---|---|
| Core unit tests | `cd packages/core && tsx --test test/*.test.ts` | **123 / 123 pass** |
| Core strict typecheck | `tsc -p tsconfig.test.json` | clean |
| Shared contract typecheck | `cd packages/shared && tsc -p tsconfig.json --noEmit` | clean |
| Integrations (SigV4, S3 client, ffprobe on a real ffmpeg-generated mp4, Meta provider on a fake HTTP client) | `cd packages/integrations && tsx --test test/*.test.ts` | **19 / 19 pass**, typecheck clean |
| DB adapters on real PostgreSQL 16 (job store claims across separate psql sessions, scheduler store, auth store) | `cd packages/db && tsx --test test/*.test.ts` | **43 / 43 pass** (incl. 5 `PgSqlExecutor` tests on a recording fake pool, 5 migration-runner tests on real Postgres: all 4 migrations applied once with checksums, idempotent re-run, tamper refusal, 3 concurrent runners apply each exactly once, failed migration rolls back; 10 AuthStore tests: concurrent signup, lockout, refresh rotation/reuse/grace, single-use tokens, atomic password reset) |
| Services (SchedulerRunner virtual-time e2e + UploadService + AuthService, on real Postgres) | `cd packages/services && tsx --test test/*.test.ts` | **41 / 41 pass** (3 production-wiring adapter tests: storage URL provider, token resolver with AAD binding, provider resolver that never falls back from META to mock; 11 scheduler-runner + 18 UploadService + 9 AuthService: enumeration-safe signup/reset, lockout, verified-email gate, refresh rotation + reuse revocation, suspension takes effect immediately, password-hash upgrade) |
| HTTP API end-to-end (`packages/http`: real `node:http` server + real PostgreSQL + mock Instagram + virtual-time scheduler) | `cd packages/http && tsx --test test/*.test.ts` | **15 / 15 pass**: auth/cookies/refresh-theft, validation, settings, full journey (connect mock → upload → cycle → SIMULATED jobs → pause/resume/loop/stop), cross-tenant 404s on 13 endpoints, CSRF/CORS, rate limits, password flows, account deletion, mock gate |
| Runtime (`packages/runtime`: strict env validation, composition root, wake queue adapter, dev mailer) | `cd packages/runtime && tsx --test test/*.test.ts` | **7 / 7 pass**: 5 config tests (all problems reported at once, no secret echoed, production refuses mock provider / insecure cookies / http origins / log mailer, meta mode demands Graph URL+version) + 2 composition tests on real Postgres (mock mode journey start, meta mode closes the mock gate) |
| Worker + MOCK-MODE END-TO-END through production wiring (`apps/worker`) | `cd apps/worker && tsx --test test/*.test.ts` | **6 / 6 pass**: 5 unit tests (BullWakeQueue ids/delay/swallowed errors, processor dispatch, sweeper loop) + 1 e2e: register → verify → login → mock account → upload 3 videos → 20-min cycle (batch 2, loop) → jobs SIMULATED never ACCEPTED/CONFIRMED → Redis flush → sweeper recovers → pause (no new jobs) → resume → loop → stop → history. Delayed queue is an in-memory stand-in for BullMQ in virtual time. Mutation check: removing the sweeper call fails the test |
| Web lib unit tests (`apps/web/src/lib`, from an earlier session) | `cd apps/web && tsx --test "src/**/*.test.ts"` | **65 / 65 pass** (includes the route-contract test, which now finds the page usages) |
| Web pages typecheck against REAL shared types with STUBBED react/next typings | scratch tsconfig | clean except a stub artifact; proves DTO/route usage only, NOT that React/Next compile |
| SQL schema + invariants | `PGDATABASE=reelqueue_verify ./scripts/verify-db.sh` | **22 / 22 pass** (18 for 0001 + 4 for 0003; 0002 and 0004 are applied by the script but have no dedicated checks; "DB verification passed") |

The db/services tests need a local PostgreSQL (they create `reelqueue_dbtest`); they skip if none is available.
The Meta provider has NEVER talked to Meta: it is tested only against a fake HTTP client, and its endpoint paths,
field names and error-code mapping are UNVERIFIED.

## Milestones

| Milestone | Status | Detail |
|---|---|---|
| A Repository foundation | partly VERIFIED | workspace, tsconfig, `.env.example`, compose (postgres+redis), CI, `verify-db.sh` written; compose/CI **UNVERIFIED**; lint/format config, env validation, Dockerfiles for api/worker NOT STARTED |
| Domain core (`packages/core`) | **VERIFIED** | scheduler engine, executor, retry, quota, cursor, crypto, OAuth state, redaction, mock provider; storage port added |
| Database schema | **VERIFIED** | `0001_init.sql`, 12 tables, 18 invariants |
| API contract (`packages/shared`) | VERIFIED (typecheck only) | DTOs, error codes, route table; written by an earlier session, preserved |
| C Storage | **VERIFIED (service level)** | core upload planning/validation, SigV4, S3 client (vs fake fetch), ffprobe runner (real mp4), `VideoStore` + `UploadService` on real Postgres: atomic quota reservation (concurrent batches cannot oversubscribe), HEAD size/type verification, reject + delete, ffprobe validation with bounded retries, idempotent/concurrent completion, abandoned-batch cleanup with retried object deletion, soft delete (blocked by live jobs), reorder (blocked during a live cycle), tenant isolation, DB-failure rollback; ledger-vs-rows invariant asserted in every test. NOT done: HTTP endpoints, real R2 round-trip (needs credentials) |
| B Backend API | HTTP layer **VERIFIED** (framework-free); NestJS wrapper NOT written; ADR DEVIATION: `apps/api/src/main.ts` is a plain Node entrypoint over `createApi` (UNVERIFIED: needs pg/bullmq/ioredis). Decide whether a Nest adapter is still wanted; nothing in the HTTP layer depends on it. Rate limiter store is in-memory per process: multi-replica API needs a shared store | `packages/http` implements every user-facing `/v1` route except real-Instagram OAuth (`connect`, `callback`) and `admin/*`; validation, error envelope, CSRF/CORS, rate limits, cookies, tenant isolation all tested over real HTTP. `apps/api` (Nest + Swagger + TypeORM entities) still to write as a thin adapter (UNVERIFIED when written) |
| D Worker + scheduler | logic VERIFIED, process entrypoints UNVERIFIED | `apps/worker/src/{processor,sweeper}` + `runtime/wake-queue` verified (above); `apps/worker/src/main.ts` (bullmq, ioredis, pg) never compiled or run. `PgJobStore`, `SchedulerStore`, `SchedulerRunner` verified on real Postgres incl. duplicate delivery, Redis loss, lost publish response, worker crash, quota exhaustion, stop, expiry. BullMQ wrapper (`apps/worker`) NOT written |
| E Instagram provider | partly VERIFIED | mock provider VERIFIED; `MetaInstagramProvider` written, tested ONLY against a fake HTTP client (shapes UNVERIFIED); OAuth connect flow + token store/refresh service NOT written |
| F Dashboard (`apps/web`) | pages WRITTEN, UNVERIFIED | login/register/verify/forgot/reset + dashboard, accounts (mock connect, quota refresh, disconnect), uploads (direct-to-storage with retry), videos (reorder/caption/preview/delete), cycles (start/pause/resume/stop/loop), jobs (history with SIMULATED/ACCEPTED/CONFIRMED labels), settings (defaults, password, deletion). Never built or rendered: no Next/React installed. Not written: admin screens, Playwright e2e |
| G Tests | partly | see executed table |
| H Deployment | partly | see `docs/LAPTOP_RETURN_CHECKLIST.md` |

## Progress log (append-only)

* 2026-10-17: restarted PostgreSQL, re-ran all checks above (results in table). Committed checkpoint `b264dcd`.
* 2026-10-17 (session 4): confirmed the psql adapter + tests were complete and committed (`636a5e0`, `1b7310e`); added core
  uploads (`d0b153b`), S3 client + ffprobe (`edc7782`), Meta provider + fake-HTTP tests, core auth primitives, `AuthStore`. All counts in the table above.
* 2026-10-17 (session 4, later): added `AuthService` + 9 tests. NOTE: tests that need PostgreSQL HANG (event loop drains) rather than fail if the server is down; start it first (`pg_ctlcluster 16 main start`, or `docker compose up -d postgres`).
* 2026-10-17 (session 4, upload milestone): migration `0003_upload_lifecycle.sql` (+ verify file), `VideoStore`, `UploadService`, 18 tests.
  Mutation check: weakening the finalize compare-and-set made the duplicate-completion test fail; restored.
  Known residual: a publishing job can be created for a video at the instant it is soft-deleted (the job insert waits on the row lock, then commits);
  the executor should skip videos with `deleted_at` set (not yet implemented, tracked as next-step item).
* 2026-10-17 (session 4, HTTP): `packages/http` (router, validation, pipeline, node:http adapter, all user routes), services `ReadService/SettingsService/AccountService/CycleService/UploadFlow/MeService`, db `SettingsStore/AccountStore/QueryStore`, migration 0004.
  Mutation check: dropping the `user_id` filter in `SchedulerStore.command` made the tenant-isolation test fail; restored.
  Contract changes: `register` now returns `{status:'VERIFICATION_SENT'}` (202) so existing-address registrations are indistinguishable; `logout` is unauthenticated (needs only the refresh cookie).
  Not implemented over HTTP: Instagram OAuth connect/callback (needs Meta credentials), `/v1/admin/*`.
* 2026-10-18 (session 5): `PgSqlExecutor` + migration runner (`cabf3f7`; a test-adapter bug that hid mid-script errors was fixed: psql's `:ERROR` only reflects the last statement). Production wiring adapters, `@reelqueue/runtime`, worker logic, api/worker `main.ts` (`c2cfe81`). Web pages (`4248f02`). Password minimum aligned to the server's 12.
  Honest limits: no Meta OAuth connect/callback or token refresh job, no real mail transport (`MAIL_TRANSPORT=log` is refused in production, so production cannot boot until one exists), no `/v1/admin/*`, no Dockerfiles for api/worker/web, no hard-delete retention job, executor does not yet skip soft-deleted videos.
