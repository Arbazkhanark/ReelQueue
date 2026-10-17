# Implementation status

Last updated: 2026-10-17 (session 4). Legend: **VERIFIED** = executed here with the stated result ·
**UNVERIFIED** = source written, never compiled/run (needs `pnpm install` on a networked machine) ·
**BLOCKED** = cannot proceed without something external · **NOT STARTED**.

Environment limit: `registry.npmjs.org` returns 403 in the build workspace, so Nest/TypeORM/BullMQ/Next/Playwright
could not be installed. Verification here uses Node 22, global `tsc` 6.0.3, `tsx`, PostgreSQL 16, Redis 7 only.

## Actually executed (results as observed, 2026-10-17)

| Check | Command | Result |
|---|---|---|
| Core unit tests | `cd packages/core && tsx --test test/*.test.ts` | **112 / 112 pass** |
| Core strict typecheck | `tsc -p tsconfig.test.json` | clean |
| Shared contract typecheck | `cd packages/shared && tsc -p tsconfig.json --noEmit` | clean |
| Integrations (SigV4, S3 client, ffprobe on a real ffmpeg-generated mp4, Meta provider on a fake HTTP client) | `cd packages/integrations && tsx --test test/*.test.ts` | **19 / 19 pass**, typecheck clean |
| DB adapter on real PostgreSQL 16 (concurrent claims across separate psql sessions, scheduler store) | `cd packages/db && tsx --test test/*.test.ts` | **23 / 23 pass** |
| Services (SchedulerRunner, virtual-time e2e on real Postgres) | `cd packages/services && tsx --test test/*.test.ts` | **11 / 11 pass** |
| SQL schema + invariants | `PGDATABASE=reelqueue_verify ./scripts/verify-db.sh` | **18 / 18 pass** ("DB verification passed") |

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
| C Storage | partly VERIFIED | core upload planning/validation, SigV4, S3 client (presign/HEAD/DELETE vs fake fetch), ffprobe runner: **VERIFIED**. NOT done: upload-session application service, real R2 round-trip (needs credentials) |
| B Backend API (NestJS) | NOT STARTED as framework code | DB schema + stores exist and are verified; no controllers/guards/entities/Swagger yet. Auth primitives not yet written |
| D Worker + scheduler | partly VERIFIED | `PgJobStore`, `SchedulerStore`, `SchedulerRunner` verified on real Postgres incl. duplicate delivery, Redis loss, lost publish response, worker crash, quota exhaustion, stop, expiry. BullMQ wrapper (`apps/worker`) NOT written |
| E Instagram provider | partly VERIFIED | mock provider VERIFIED; `MetaInstagramProvider` written, tested ONLY against a fake HTTP client (shapes UNVERIFIED); OAuth connect flow + token store/refresh service NOT written |
| F Dashboard (`apps/web`) | partly UNVERIFIED | lib/components + unit tests exist from another session (never run by me); **no pages yet** |
| G Tests | partly | see executed table |
| H Deployment | partly | see `docs/LAPTOP_RETURN_CHECKLIST.md` |

## Progress log (append-only)

* 2026-10-17: restarted PostgreSQL, re-ran all checks above (results in table). Committed checkpoint `b264dcd`.
* 2026-10-17 (session 4): confirmed the psql adapter + tests were complete and committed (`636a5e0`, `1b7310e`); added core
  uploads (`d0b153b`), S3 client + ffprobe (`edc7782`), Meta provider + fake-HTTP tests. All counts in the table above.
