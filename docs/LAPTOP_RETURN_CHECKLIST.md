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
openssl rand -base64 48   # JWT_ACCESS_SECRET, OAUTH_STATE_SECRET (run twice)
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
pnpm -r test                      # last observed here: core 123, integrations 19, db 33, services 38 (db/services need local Postgres)
pnpm --filter @reelqueue/web build
```

## 5b. Expected-to-work before any framework code (already green on the build workspace)
```bash
pnpm test:core && pnpm typecheck:core
PGDATABASE=reelqueue_verify ./scripts/verify-db.sh
```
If these fail on your machine the cause is environment (Node/Postgres version), not the missing framework code.

## 6. Local start, mock mode, Meta, deployment
Filled in as the corresponding code lands; see `docs/IMPLEMENTATION_STATUS.md` for what exists.

## 10. Known failures / unverified / manual steps
- All framework code (Nest, TypeORM entities, BullMQ processors, Next pages) is UNVERIFIED until step 5 passes.
- `MetaInstagramProvider` has only run against a fake HTTP client; verify every endpoint/field/error code against a real test account before `INSTAGRAM_PROVIDER=meta`.
- Meta: OAuth endpoints, token lifetimes, Reel media spec, dev-mode behaviour are unverified (`docs/INSTAGRAM_SETUP.md`).
- Meta App Review / Advanced Access is required to serve users other than yourself and cannot be done from code.
- R2 bucket CORS (PUT from your web origin) must be configured manually.
