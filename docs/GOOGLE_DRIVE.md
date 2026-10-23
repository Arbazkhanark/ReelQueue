# Google Drive integration (optional, additional to S3)

Status: **written and tested against FAKE Google endpoints only.** Nothing here has talked to Google. The OAuth/Drive request
shapes follow Google's public documentation as known to the author and are **UNVERIFIED** until you run the manual flow in §12
with a real Google Cloud project. The Next.js page has never been built (no Next/React install is possible in the build workspace).

## 1. What it is, and what it is not
* An **additional** integration. S3-compatible storage remains the only storage used by the upload → schedule → Instagram
  pipeline. No S3 file, key layout, default, endpoint or consumer was changed.
* **Optional.** With no `GOOGLE_DRIVE_*` variables the server boots exactly as before, `/v1/google-drive/status` answers `{enabled:false}` and every other Drive route is 404.
* **No silent migration** between S3 and Drive. `STORAGE_PROVIDER` only accepts `s3` (default); any other value fails startup validation.
* Provider selection UI: the product has no per-upload storage choice today, so none was added. The `/storage` page is a separate area.

## 2. Instagram publishing and Drive (architecture note)
Instagram's publishing API fetches the video from a **publicly reachable URL**. A Drive `webViewLink` is an HTML viewer page, not a media URL, and a private Drive file cannot be fetched by Meta. The publishing pipeline therefore keeps using S3 presigned URLs and was **not changed**.
To publish a video that lives only in Drive, the correct design is a *staging* step: stream it from Drive (`GET /v1/google-drive/files/:id/content`, no full buffering) into the existing S3 upload flow, then publish from S3. That step is **not implemented**; it needs a product decision.

## 3. Scope limitation (`drive.file`)
`https://www.googleapis.com/auth/drive.file` gives access to files the app **created** (or that the user explicitly opened/shared with the app through Google Picker). It does **not** grant access to the rest of the user's Drive. So:
* ReelQueue can create its own `ReelQueue` folder, upload, list, download and delete **files it created**. Deleting a file not created by ReelQueue is refused (`FORBIDDEN`), enforced by an app property on the file, not by the client.
* "Browse any existing Drive file" would need **Google Picker** (browser-side, separate Google API key + app id) and/or a broader, restricted scope with Google verification. Neither was added; `GOOGLE_DRIVE_SCOPES` accepts only `drive.file`, so scope cannot be widened by configuration alone.

## 4. Files
New:
| File | Purpose |
|---|---|
| `apps/api/migrations-sql/0006_google_drive.sql` + `verify/0006_google_drive.sql` | `google_drive_connections` (one per user, encrypted tokens, CHECKs) and `google_oauth_states` (hashed single-use state + encrypted PKCE verifier); 8 invariant checks |
| `packages/db/src/google-drive-store.ts` (+ test) | persistence: state create/consume, upsert, compare-and-set token refresh, re-auth flag, app folder |
| `packages/integrations/src/google/{common,oauth,drive}.ts` (+ test) | Google OAuth client (code exchange with PKCE, refresh, revoke) and Drive v3 REST client (about, get, list, folder, resumable-upload start, streaming download, delete), retry/backoff, sanitised errors; no `googleapis` dependency |
| `packages/services/src/google-drive.ts` (+ test) | `GoogleDriveService`: connect/callback, token refresh, list/get/upload-session/download/delete/disconnect, per-user isolation |
| `packages/http/test/google-drive.test.ts` | HTTP end-to-end (fake Google, real PostgreSQL) incl. cross-tenant and streaming |
| `packages/runtime/test/compose-drive.test.ts` | optional wiring: off by default, on with config |
| `apps/web/src/app/(app)/storage/page.tsx`, `apps/web/src/lib/drive-ui.ts` (+ test) | Storage page and its pure view logic |
| `docs/GOOGLE_DRIVE.md` | this file |

Existing files changed (additive only):
| File | Change and reason |
|---|---|
| `packages/shared/src/{dto,errors,routes}.ts` | new Drive DTOs, 3 error codes, 9 routes in the single route table |
| `packages/http/src/app.ts` | the `/v1/google-drive/*` routes; optional `googleDrive` dep |
| `packages/http/src/{http,node-server}.ts` | optional `stream` on `HttpResponse` + back-pressured piping (needed for streaming downloads; JSON responses unchanged) |
| `packages/{db,integrations,services}/src/index.ts` | export the new modules |
| `packages/runtime/src/{config,compose}.ts` | optional `GOOGLE_DRIVE_*` validation, `STORAGE_PROVIDER` guard, service wiring |
| `packages/db/test/migrator.test.ts`, `packages/http/test/helpers/stack.ts` | migration count 5→6; test stack can inject the Drive service |
| `apps/web/src/app/(app)/layout.tsx` | one nav entry `Storage` |
| `.env.example` | placeholder variables |

## 5. Environment variables
```
GOOGLE_DRIVE_CLIENT_ID=            # Google Cloud OAuth client id
GOOGLE_DRIVE_CLIENT_SECRET=        # server-side only; never NEXT_PUBLIC_*, never in the browser
GOOGLE_DRIVE_REDIRECT_URI=https://reelqueue-api.onrender.com/v1/google-drive/callback
GOOGLE_DRIVE_SCOPES=https://www.googleapis.com/auth/drive.file
```
All three of id/secret/redirect are required if any is set. The redirect URI must end with `/v1/google-drive/callback`, be https in production and carry no query/fragment. The token-encryption key (`TOKEN_ENCRYPTION_KEYS`) already required by the app is reused; there is no separate key.

## 6. Google Cloud Console setup (manual)
1. Create/select a project; enable **Google Drive API**.
2. OAuth consent screen: app name, support e-mail, authorised domain; add scope `.../auth/drive.file`. Keep the app in *Testing* with your own Google account as a test user while developing (refresh tokens of Testing apps expire after 7 days). Production needs the consent-screen publishing step.
3. Credentials → OAuth client ID → *Web application*. Authorised redirect URI, exactly: `https://reelqueue-api.onrender.com/v1/google-drive/callback` (add `http://localhost:4000/v1/google-drive/callback` for local work).
4. Copy the client id/secret into the API's environment only.

## 7. Database migration
Applied by the existing runner (`MIGRATE_ON_BOOT=true`, the dev default) or manually: `psql "$DATABASE_URL" -f apps/api/migrations-sql/0006_google_drive.sql`. Invariant checks: `PGDATABASE=<scratch> ./scripts/verify-db.sh`. The migration only **adds** two tables; it does not alter existing ones.

## 8. API (all under `/v1/google-drive`, session cookie + CSRF origin check, per-IP/per-user rate limits)
| Method & path | Purpose |
|---|---|
| `GET /status` | `{enabled, status: NOT_CONNECTED|CONNECTED|REAUTH_REQUIRED, scopes, connectedAt}` |
| `POST /connect` | `{authorizationUrl}` (random 256-bit state, hashed in DB, 10 min expiry, bound to the user, PKCE S256) |
| `GET /callback` | browser redirect from Google; always 302 to `${WEB}/storage?connected=1` or `?error=<fixed code>`; the state AND the logged-in session user must match; Google text is never echoed |
| `GET /files?pageSize&pageToken` | paginated list (page size 1–100) |
| `GET /files/:id` | metadata |
| `POST /uploads` `{filename,contentType,sizeBytes}` | validates with the same media rules as S3 (mp4/mov, ≤1 GiB), creates the `ReelQueue` folder once, returns `{sessionUri}`; the browser PUTs the bytes straight to Google (resumable), so no file passes through the API and no token reaches the browser |
| `GET /files/:id/content` | streamed download (`attachment`, `nosniff`); folders and native Google documents are refused; stops reading from Drive if the client disconnects |
| `DELETE /files/:id` | only files created by ReelQueue |
| `DELETE /connection` | revokes the refresh token at Google (best effort) and deletes the stored connection; idempotent |

## 9. Security and token handling
* Access and refresh tokens are AES-256-GCM envelopes (existing `TokenCipher`) with AAD bound to the user and token kind; never returned by any API, never logged. Google errors are reduced to a kind and a short whitelisted reason.
* OAuth: state is random, hashed at rest, single use (consumed even when checks fail), expires, and must belong to the logged-in user; PKCE verifier is stored encrypted. Replay, another user's session, expiry, missing scope and Google rejection all create nothing (tested against fakes).
* Authorisation: the acting user is always the session user. A Drive file id from the URL is validated by format and then used **with the caller's own token**, so another user's file is simply 404. Deleting requires the app-created marker.
* Token refresh: lazily, 60 s before expiry, compare-and-set so concurrent requests do not clobber each other; `invalid_grant` marks the connection `REAUTH_REQUIRED`; a transient failure keeps it connected; one forced refresh + retry on a 401.
* Retries: exponential backoff with jitter and Retry-After on 429/5xx/timeouts; folder creation is not retried blindly (avoids duplicate folders). Upload idempotency comes from the resumable session.
* Residual risks: the resumable session URI is a bearer capability valid for about a week; Drive CORS for the browser PUT depends on the `Origin` header sent at session start (UNVERIFIED); Testing-mode refresh tokens expire in 7 days.

## 10. Local development
```bash
cp .env.example .env   # fill GOOGLE_DRIVE_* with a Testing-mode OAuth client; redirect http://localhost:4000/v1/google-drive/callback
pnpm install && pnpm build:libs
node --env-file=.env apps/api/dist/main.js      # runs the migration, serves :4000
pnpm --filter @reelqueue/web dev                # :3000 → sign in → Storage → Connect Google Drive
```

## 11. Render deployment
Set the four `GOOGLE_DRIVE_*` variables on the **API** service only (secret as a secret env var), keep `COOKIE_SECURE=true`, make sure the web origin is in `APP_ORIGINS`/`WEB_BASE_URL`, deploy, and confirm `GET /v1/google-drive/status` returns `enabled:true`. The web service needs no Google variable.

## 12. Manual test of the whole flow (needs real Google credentials)
1. Sign in → Storage → *Connect Google Drive* → consent → you land on `/storage?connected=1`.
2. Upload a small mp4; confirm a `ReelQueue` folder with the file appears in your Drive and in the list.
3. Download it from the list; delete it; disconnect and confirm https://myaccount.google.com/permissions no longer lists the app.
4. Confirm Instagram upload/publish through S3 still behaves as before.

## 13. Rollback (S3 unaffected)
Remove the four `GOOGLE_DRIVE_*` variables and redeploy: the feature disappears (routes 404, status `enabled:false`, nav page shows "not enabled"). The two tables can stay (harmless) or be dropped: `DROP TABLE google_oauth_states, google_drive_connections;` and delete the `0006_google_drive.sql` row from your migrations bookkeeping table. Revoke the OAuth client in Google Cloud if abandoning it.