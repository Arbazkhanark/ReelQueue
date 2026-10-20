# Laptop return checklist

Everything here is a command to run on a machine WITH npm registry access. Nothing in this file has been executed
by the assistant unless stated in `docs/IMPLEMENTATION_STATUS.md`. Tick boxes as you go and note failures.

## 1. Prerequisites
- [ ] Node >= 22 (`node -v`), pnpm 10 (`corepack enable && corepack prepare pnpm@10.28.0 --activate`)
- [ ] PostgreSQL >= 14 and Redis >= 7 (or Docker): `docker compose -f infra/docker-compose.yml up -d postgres redis`
- [ ] `ffprobe` on PATH (from ffmpeg) — needed by the worker's media validation

## 2. Install (this generates the lockfile, which has never existed)
```bash
git pull   # or open the workspace
pnpm install            # creates pnpm-lock.yaml; COMMIT IT
```
Dependency versions in `package.json` files are ranges chosen from knowledge, not verified against the registry. If an
install error names a non-existent version, adjust that range; the lockfile then pins it.

## 3. Environment
```bash
cp .env.example .env
openssl rand -base64 48   # JWT_SECRET, OAUTH_STATE_SECRET (run twice; they MUST differ)
openssl rand -base64 32   # TOKEN_ENCRYPTION_KEYS=k1:<output>
```
Keep `INSTAGRAM_PROVIDER=mock` until Meta credentials exist.

## 4. Database
```bash
createdb reelqueue && createdb reelqueue_verify
PGDATABASE=reelqueue_verify ./scripts/verify-db.sh     # DESTRUCTIVE to that DB; expect "DB verification passed"
# apply to the real DB once the API migration runner exists (see IMPLEMENTATION_STATUS)
```

## 5. Verification commands (record every failure)
```bash
pnpm -r typecheck
pnpm -r test                      # last observed here (2026-10-18): core 125, integrations 32, db 52, services 50, http 17, runtime 18, worker 10, web lib 65 = 369; db/services/http/runtime/worker need local Postgres
pnpm --filter @reelqueue/web build
```

## 5b. Expected-to-work before any framework code (already green on the build workspace)
```bash
pnpm test:core && pnpm typecheck:core
PGDATABASE=reelqueue_verify ./scripts/verify-db.sh
```
If these fail on your machine the cause is environment (Node/Postgres version), not the missing framework code.

## 6. Local start in mock mode (all of this is UNVERIFIED; first real run of the entrypoints)
```bash
pnpm install && pnpm build:libs
# env (see packages/runtime/src/config.ts for every variable): DATABASE_URL, REDIS_URL, APP_ORIGINS=http://localhost:3000,
# JWT_SECRET (>=32 chars), TOKEN_ENCRYPTION_KEYS=k1:<base64 32 bytes>, TOKEN_ENCRYPTION_ACTIVE_KEY_ID=k1,
# S3_ENDPOINT/S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY (MinIO or R2), INSTAGRAM_PROVIDER=mock, MIGRATE_ON_BOOT=true
node apps/api/dist/main.js        # applies migrations at boot, listens on :4000
node apps/worker/dist/main.js     # BullMQ worker + sweeper
pnpm --filter @reelqueue/web dev  # :3000
```
Expect to fix: bullmq/ioredis/pg typings in the two `main.ts` files (never compiled; `apps/worker/tsconfig*.json` exclude `main.ts` until deps exist - remove the exclude), and any React/Next compile errors in `apps/web/src/app/**` (never built).
Storage CORS must allow PUT from the web origin. The `LogMailer` prints the verification link to the API log (the only way to verify an email in dev).

## 10. Known failures / unverified / manual steps
- All framework code (BullMQ/ioredis/pg entrypoints `apps/api/src/main.ts` and `apps/worker/src/main.ts`, Next pages) is UNVERIFIED until step 5 passes. No Nest/TypeORM code exists (see ADR deviation in IMPLEMENTATION_STATUS).
- Production start is UNVERIFIED: SMTP transport (tested only against an in-process fake server: try a real provider with STARTTLS on 587 and implicit TLS on 465 and check certificate validation) and Meta OAuth connect/callback/refresh (fake HTTP only) now exist but have never touched a real SMTP server or a real Meta app.
- Real mail uses Nodemailer (apps/api): set EMAIL_HOST/EMAIL_PORT/EMAIL_SECURE/EMAIL_USER/EMAIL_PASS/EMAIL_FROM (or the SMTP_* names). `NodemailerTransport` is tested only with a FAKE nodemailer; the real package has never been installed or run here. Production refuses the log transport. Mail is not durable (no outbox).
- Meta mode needs META_APP_ID, META_APP_SECRET, META_REDIRECT_URI (https in production, must be registered in the Meta app), OAUTH_STATE_SECRET, WEB_BASE_URL. Check on a real test account: the callback, the `data[]` token response shape, `account_type` values, granted `permissions`, the 24 h minimum token age before refresh, and a refresh at least once.
- Worker maintenance (token refresh, retention, upload cleanup, rate-limit purge) runs every `RETENTION_INTERVAL_MS` (default 1 h) in each worker; confirm in the logs ("maintenance"). Retention: `RETENTION_VIDEO_DAYS` (30), `RETENTION_ACCOUNT_GRACE_DAYS` (14).
- Dockerfiles / deployment config are deliberately NOT written yet: they must only be added after `pnpm install`, a real build and a real API/worker/web start have succeeded.
- `MetaInstagramProvider` has only run against a fake HTTP client; verify every endpoint/field/error code against a real test account before `INSTAGRAM_PROVIDER=meta`.
- Meta: OAuth endpoints, token lifetimes, Reel media spec, dev-mode behaviour are unverified (`docs/INSTAGRAM_SETUP.md`).
- Meta App Review / Advanced Access is required to serve users other than yourself and cannot be done from code.
- R2 bucket CORS (PUT from your web origin) must be configured manually.

## 11. Back up the repository FIRST (no git remote is configured; commits exist only in this workspace)
See `docs/BACKUP.md` for the exact secret-safe steps (private remote push, or a verified `git bundle` / archive).
