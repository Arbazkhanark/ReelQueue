# ReelQueue — Implementation plan

_Status date: 2026-10-15. This document is the single source of truth for scope, decisions, risks and progress.
Checkboxes are ticked only when the item has been **run and verified** in the stated way; "written, not run" is stated explicitly._

## 1. Inspection result (Phase 1)

| Finding | Detail |
|---|---|
| Existing work | `packages/core` (pre-existing, preserved): pure scheduler engine, publish executor, provider port, mock provider, token/crypto/OAuth-state/redaction primitives. 3.5k lines, zero runtime deps. |
| Baseline | 104/106 tests passed on arrival. Both failures were **test bugs** (shared id counter in the mock; a test that claimed an out-of-order job). Fixed; now **106/106 pass**, strict `tsc` clean. |
| Empty | `apps/web`, `apps/api`, `apps/worker`, `infra`, `docs` (until now). |
| Toolchain here | Node 22, pnpm 10, TypeScript 6.0.3, tsx, PostgreSQL 16, Redis 7, ffprobe. Docker CLI present (daemon not exercised). |
| **Blocker** | `registry.npmjs.org` is **denied by the workspace network policy (HTTP 403)**. Nest, Next, TypeORM, BullMQ, Playwright etc. **cannot be installed or compiled here**. Anything built on them can only be written, not run, in this environment. See §6. |

## 2. Architecture decisions (ADRs)

1. **Hexagonal core.** `@reelqueue/core` holds every scheduling/publishing rule as pure functions plus ports
   (`JobStore`, `InstagramProvider`, `MediaUrlProvider`, `Clock`). Apps only adapt frameworks to ports. Rules are
   therefore testable with fake clocks, no network, no DB.
2. **PostgreSQL is the source of truth; Redis/BullMQ is a wake-up mechanism.** BullMQ jobs carry only IDs and a due
   time. Every decision is re-derived from PostgreSQL under a lease. A **sweeper** re-enqueues any due, unleased job
   found in PostgreSQL, so losing Redis never loses work (it only delays it).
3. **Interval = fixed-rate between batch _starts_** (`next = max(prevScheduled + interval, now)`), with
   **backpressure** (a new batch is not released while the previous batch has unresolved jobs) and **anti-burst**
   (missed slots are never replayed). Implemented in `computeNextBatchAt` / `planTick`.
4. **Cycle window.** `startedAt` = instant Start is accepted; `endsAt = startedAt + duration` (default 24 h), fixed.
   Pausing does **not** extend it. A publication may only _start_ before `endsAt`. At expiry: jobs that have not
   reached `PUBLISH_REQUESTED` become `EXPIRED`; jobs already requested/accepted are reconciled, never abandoned.
   Jobs are keyed to their `cycle_id`, and the DB allows **one live cycle per Instagram account**, so a later cycle
   can never pick up stale jobs.
5. **Queue-advance policy.** Order is by `position`; a cursor stores the _position_ of the last released video, so
   reordering/deleting mid-cycle cannot corrupt it. `ACCEPTED/CONFIRMED/SIMULATED` advance; a permanently `FAILED`
   job does **not** block later jobs; a `DEFERRED` (quota) job **does** block later jobs to preserve order.
6. **Three distinct truths** are never conflated: `SCHEDULED` (our intent) → `ACCEPTED` (API accepted
   `media_publish`) → `CONFIRMED` (verified with the provider). Mock publications end in `SIMULATED`; the database
   itself forbids a MOCK job from being `ACCEPTED/CONFIRMED` and a META job from being `SIMULATED`.
7. **At-least-once execution, never-blind-retry publishing.** Lease per job + per-account serialisation; container id
   persisted immediately; `PUBLISH_REQUESTED` persisted _before_ the irreversible call; uncertain outcomes are
   reconciled against the container status. **Exactly-once is not claimed** (residual risk documented in
   `executor.ts` and the risk register).
8. **Tenant isolation in three layers:** (a) every repository method requires `userId` taken from the session, never
   the request; (b) composite foreign keys `(child.x_id, child.user_id) → parent(id, user_id)` make cross-tenant
   references impossible at the database level (verified, see DATABASE.md); (c) optional PostgreSQL RLS later.
9. **Auth.** Argon2id; 15-minute access JWT + rotating opaque refresh token (hashed, family reuse-detection) in
   `HttpOnly; Secure; SameSite=Lax` cookies; Origin check on state-changing requests; one-time hashed tokens for email
   verification / password reset.
10. **Uploads.** Direct-to-R2 presigned PUT (S3-compatible `StorageProvider` port); `init` reserves quota, `complete`
    verifies the object (HEAD size/type), then a pluggable `MediaProcessor` (ffprobe in the worker) validates. Only
    storage keys are stored; Meta receives a short-lived presigned GET URL.
11. **Secrets.** AES-256-GCM key ring with key ids (rotation), AAD-bound to the account id; tokens are never logged or
    returned. Pino redaction paths + `redactString` for free text.
12. **Hosting.** Web on a static/serverless host; **API + worker on an always-on container host** (BullMQ needs a
    long-lived process). Managed Postgres and Redis (Redis must be configured `noeviction`).

## 3. Data model

See [DATABASE.md](./DATABASE.md) (Mermaid ERD, relationships, constraints). Implemented as
`apps/api/migrations-sql/0001_init.sql` and **applied + checked on PostgreSQL 16** (18 invariant checks).

## 4. Risk register

| # | Risk | L | I | Mitigation | Status |
|---|---|---|---|---|---|
| R1 | Meta quota docs disagree (100 vs 50 per 24 h) | H | M | Never hardcode; read `content_publishing_limit` at runtime; fail-closed if unknown/invalid; configurable reserve | Mitigated in core, tested |
| R2 | Duplicate publish after lost `media_publish` response | M | H | Persist intent first, settle window, reconcile via container status; documented residual risk; no exactly-once claim | Mitigated, residual documented |
| R3 | Reel media spec unverified (page login-gated) | H | M | Conservative, **env-configurable** validation limits; surface Meta `ERROR` status as `MEDIA_REJECTED`; verify before launch | **Open — verify** |
| R4 | Token lifetime/refresh rules unverified this session | M | M | Assumed 60 d / refresh ≥24 h old (flagged in code + docs); reauth flow; verify before launch | **Open — verify** |
| R5 | App Review / Advanced Access required for a multi-tenant SaaS | H | H | Documented; build against app roles + mock until approved; cannot be completed from code | **Open — external** |
| R6 | Redis data loss / restart | M | H | PG is source of truth; sweeper re-enqueues; `noeviction`; AOF on | Designed, not yet run |
| R7 | Worker crash mid-job | M | M | Leases expire; state persisted per step; tests cover crash before/after provider effect | Tested in core (mock) |
| R8 | Cross-tenant data access | L | H | Scoped repositories + composite FKs + negative tests for every endpoint | DB layer verified; API layer pending |
| R9 | Token leakage via logs/errors | M | H | Redaction paths, sanitised provider errors, admins never see tokens, e2e log scan | Primitives tested; wiring pending |
| R10 | R2/S3 free-tier exhaustion | M | M | Per-user quota + reservation + global usage metric + warnings | Schema ready |
| R11 | Meta cannot fetch presigned URL (TTL, CORS, region) | M | M | TTL ≥ polling window; HEAD-check before container creation; clear error | Pending |
| R12 | **Dependencies cannot be installed in the build workspace** | — | H | Run `pnpm install` on a networked machine/CI; code written against pinned versions, unverified until then | **Open — blocking** |
| R13 | Automation policy: Meta may restrict high-frequency / repetitive posting independently of the API quota | M | H | Conservative defaults, visible quota/limits UI, do not market as "unlimited posting"; review Platform Terms before launch | **Open — review** |

## 5. Milestone checklist

Legend: `[x]` run & verified here · `[~]` written, **not run** · `[ ]` not started · `[!]` blocked

- [x] **M0 Phase 1:** inspect repo, verify Meta docs (partially, see INSTAGRAM_SETUP.md), plan, ADRs, risks
- [x] **M1 Domain core** (pre-existing + fixed): 106/106 tests, strict typecheck clean
- [x] **M2 Database schema:** `0001_init.sql` applied on PG 16; 18 invariants pass
- [~] **M2b** Repo scaffolding: `.env.example`, `infra/docker-compose.yml`, CI workflow, `scripts/verify-db.sh` (the script is run; compose and CI are not)
- [!] **M3 Workspace + API foundation:** Nest app, TypeORM entities/migration wrapper, config, Pino, health, Swagger
- [~] **M4 Auth + tenancy:** `AuthService` + `AuthStore` + crypto primitives VERIFIED on real Postgres (register/verify/login/refresh/logout/reset/lockout/rotation); Nest controllers, guards, RBAC wiring NOT written
- [~] **M5 Storage + uploads:** `StorageProvider` S3/R2 client, `VideoStore`, `UploadService` VERIFIED (real Postgres + fakes); HTTP endpoints and a real R2 round-trip NOT done
- [!] **M6 Worker + scheduler:** Postgres `JobStore`, BullMQ queues, tick/exec processors, sweeper, expiry, graceful shutdown
- [!] **M7 Instagram:** `MetaProvider` (OAuth, container, poll, publish, quota), token refresh job, mock mode wiring
- [!] **M8 Cycle API:** start/pause/resume/stop, upcoming, history, retry, loop toggle
- [!] **M9 Admin + observability:** admin API, metrics, audit
- [!] **M10 Web dashboard:** all 12 pages
- [!] **M11 Tests:** integration (DB/Redis/queue), Playwright e2e
- [~] **M12 Docker/CI/Deployment docs**

`[!]` = needs `pnpm install`, which this workspace cannot do (R12). Nothing in M3–M11 will be reported as done
until it has actually been compiled and tested.

## 6. How the blocker is handled

1. Everything that can be proven without the registry **is** proven (core logic, SQL schema on real Postgres).
2. Everything else is written against pinned versions and flagged `[~]` — never `[x]` — until `pnpm install &&
   pnpm -r typecheck && pnpm -r test` passes on a networked machine.
3. To continue, either: (a) run the commands in README on your machine/CI and send me the output, or (b) allow
   `registry.npmjs.org` for this workspace; I will then install, compile, fix and test each milestone here.

## 7. Assumptions I could not verify

See [INSTAGRAM_SETUP.md](./INSTAGRAM_SETUP.md#unverified-must-be-checked-before-launch).
