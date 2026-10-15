# CLAUDE.md — ReelQueue

## Architecture in one paragraph
pnpm monorepo. `packages/core` = pure domain rules + ports (no framework, no I/O, zero runtime deps). `apps/api` (NestJS),
`apps/worker` (BullMQ processors), `apps/web` (Next.js) are adapters around it. PostgreSQL is the source of truth, Redis/BullMQ
only wakes workers, S3-compatible storage (R2) holds videos. Read `docs/IMPLEMENTATION_PLAN.md` (ADRs) and `docs/ARCHITECTURE.md` first.

## Commands
```bash
pnpm install
pnpm test:core && pnpm typecheck:core          # domain rules
PGDATABASE=<scratch> ./scripts/verify-db.sh    # schema + invariants (DESTRUCTIVE to that DB)
```
Add new package scripts to the root `package.json` and keep this list current.

## Rules
* Scheduling/publishing rules live ONLY in `packages/core`. Controllers and processors stay thin.
* Strict TypeScript; no `any` without a comment explaining why. Validate every trust boundary (Zod/class-validator).
* **Tenant isolation:** `userId` always comes from the authenticated session, never from the request. Every repository
  method takes `userId`. Every new endpoint needs a negative cross-tenant test.
* **Migrations only.** Never `synchronize: true`. New schema change = new numbered SQL file + invariant checks.
* Time: inject `Clock`; never call `Date.now()` in domain code. Randomness: inject `Rng`.
* Instagram: only official endpoints behind `InstagramProvider`. Never hardcode a quota or a Meta capability; read it
  at runtime and fail closed. Never present mock output as real (`SIMULATED` ≠ `ACCEPTED` ≠ `CONFIRMED`).
* Never retry `media_publish` blindly: persist `PUBLISH_REQUESTED` first, reconcile on uncertainty.
* Secrets: env/secret manager only. Tokens are AES-GCM envelopes at rest; never log, never return them, admins can't read them.
  Use `redact`/`PINO_REDACT_PATHS`. Provider errors are sanitised before they are stored or logged.
* No fake implementations on production paths; test doubles live under `test/`.

## Definition of done
Code compiled + tests run + docs updated + checklist in `docs/IMPLEMENTATION_PLAN.md` ticked **only** for what was actually run.
If something could not be run, mark it `[~]` and say why. Never invent test output, API responses or deployment status.

## Known environment constraint
The original build workspace blocked `registry.npmjs.org`; app packages (Nest/Next/TypeORM/BullMQ) were therefore not
installable there. Check R12 in the plan before assuming any `apps/*` code has been compiled.
