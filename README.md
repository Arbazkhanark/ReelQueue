# ReelQueue

Multi-tenant SaaS for bulk-uploading videos and publishing them as Instagram Reels on a configurable schedule, using
**only the official Meta APIs**. Users connect their own professional account via OAuth, arrange a queue, set batch size
and interval (default **20 minutes**), and Start / Pause / Resume / Stop a **24-hour cycle** (optionally looping).

> **Honest status (2026-10-15):** see [docs/IMPLEMENTATION_PLAN.md](docs/IMPLEMENTATION_PLAN.md) for the milestone
> checklist. Today the **domain core and the database schema are built and verified**. The Nest API, worker, Next.js
> dashboard, Docker images and e2e tests are **not yet built or run**, because the build workspace could not reach the
> npm registry. Nothing is claimed as working that has not been executed.

## What exists and is verified

| Area | State | How it was verified |
|---|---|---|
| `packages/core` — scheduler rules, publish executor, mock provider, token crypto, OAuth state, redaction | built | `106/106` tests pass, `tsc --strict` clean |
| `apps/api/migrations-sql/0001_init.sql` — 12 tables, tenant-safe FKs, idempotency constraints | built | applied to PostgreSQL 16; 18 invariant checks pass (`scripts/verify-db.sh`) |
| Docs, `.env.example`, `infra/docker-compose.yml`, CI workflow | written | compose and CI **not run** |

## Prerequisites

Node ≥ 22, pnpm 10, PostgreSQL ≥ 14 (or Docker), Redis ≥ 7 (needed from M6 on).

## Commands you can run today

```bash
pnpm install                      # needs registry access
pnpm test:core                    # 106 unit tests (node:test via tsx)
pnpm typecheck:core               # strict TypeScript

# database: spin up Postgres, then verify the schema on a scratch DB
docker compose -f infra/docker-compose.yml up -d postgres redis
createdb reelqueue_verify         # or any scratch database
PGDATABASE=reelqueue_verify ./scripts/verify-db.sh      # DROPS the public schema of that DB
```

## Instagram: what you must do yourself

Create a Meta app, configure redirect URIs, and (to serve users other than yourself) pass **App Review / Advanced
Access**. Steps and the list of facts that are still **unverified** are in [docs/INSTAGRAM_SETUP.md](docs/INSTAGRAM_SETUP.md).
Until then run with `INSTAGRAM_PROVIDER=mock`: the UI is labelled MOCK and nothing is published.

## Documents

[IMPLEMENTATION_PLAN](docs/IMPLEMENTATION_PLAN.md) · [ARCHITECTURE](docs/ARCHITECTURE.md) · [DATABASE](docs/DATABASE.md) ·
[INSTAGRAM_SETUP](docs/INSTAGRAM_SETUP.md). Planned with their milestones: API, DEPLOYMENT, OPERATIONS, SECURITY.

## Safety principles

No browser automation, scraping or unofficial endpoints · quotas read from the API at runtime, never hardcoded ·
scheduled ≠ API-accepted ≠ confirmed, and mock results are never presented as real · no exactly-once claim:
at-least-once execution with duplicate prevention and reconciliation.
