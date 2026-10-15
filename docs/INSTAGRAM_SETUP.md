# Instagram / Meta setup and verified facts

Checked **2026-10-15** by fetching Meta's official pages from the build workspace. Pages that could not be loaded are
listed under _Unverified_. Nothing here is a guarantee about future Meta behaviour: re-check before launch.

## Verified (official pages, fetched 2026-10-15)

Sources: [Content publishing overview](https://developers.facebook.com/docs/instagram-platform/content-publishing/) ·
[content_publishing_limit reference](https://developers.facebook.com/docs/instagram-platform/instagram-graph-api/reference/ig-user/content_publishing_limit) ·
[App Review](https://developers.facebook.com/docs/instagram-platform/app-review)

| Topic | What the docs say |
|---|---|
| Account types | Instagram **professional** accounts. An account on a Page that requires Page Publishing Authorization (PPA) cannot publish until PPA is complete. |
| Permissions (Instagram Login) | `instagram_business_basic`, `instagram_business_content_publish` |
| Permissions (Facebook Login) | `instagram_basic`, `instagram_content_publish`, `pages_read_engagement`; plus `ads_management`/`ads_read` if the user has a Business Manager role on the Page |
| Hosts | `graph.instagram.com`, or `graph.facebook.com` and `rupload.facebook.com` (resumable uploads) |
| Reels workflow | 1) `POST /<IG_ID>/media` with `media_type=REELS` + `video_url` → container id. 2) Poll `GET /<CONTAINER_ID>?fields=status_code` (`EXPIRED`, `ERROR`, `FINISHED`, `IN_PROGRESS`, `PUBLISHED`); guide suggests once a minute for at most 5 minutes. 3) `POST /<IG_ID>/media_publish` with `creation_id`. |
| Media URL | Must be on a **publicly accessible server at the time of the attempt** (Meta fetches it). |
| Quota enforcement | Enforced on `POST /<IG_ID>/media_publish`; usage readable via `GET /<IG_ID>/content_publishing_limit` → `data[].quota_usage` and `config.quota_total` / `config.quota_duration` (seconds). |
| Not supported on Reels | Filters, shopping tags, branded-content tags; `alt_text`. |
| App Review | Standard Access **without** review is for an app used only for a business you own/manage. An app serving **multiple businesses (Tech Provider)** needs **Advanced Access via App Review**. A multi-tenant SaaS is the second case. Requesting Advanced Access needs at least one successful API call first. |

### Discrepancies in Meta's own docs (handled in code)

* **Quota number:** the overview says "100 API-published posts within a 24-hour moving period"; the
  `content_publishing_limit` reference says the current `quota_total` is **50** (and the carousel section also says 50).
  → ReelQueue **never hardcodes a quota**. It reads `quota_total` at runtime, treats an unreadable/invalid response as
  "unknown" and **defers** rather than publishing (`QUOTA_UNKNOWN`), and supports a configurable safety reserve.
* **Permission spelling:** most pages say `instagram_business_content_publish`; the App Review page text says
  `instagram_business_content_publishing`. → Confirm the exact string in your app dashboard; it is configured via
  `META_SCOPES`, not hardcoded.

## Unverified (must be checked before launch)

These could not be confirmed from official pages in this session (login-gated or fetch error). They are implemented
as **configuration or flagged assumptions**, not as facts.

| Item | Current handling |
|---|---|
| Reel video requirements: container/codec, max file size, min/max duration, aspect ratio, frame rate, resolution | Validation limits are **env-configurable** with conservative defaults (`MEDIA_*` in `.env.example`) and labelled as assumptions. Meta's own `ERROR` container status is the authority and maps to `MEDIA_REJECTED` (no retry). |
| OAuth endpoints and exact parameters for Instagram Login; short-lived → long-lived exchange | To be implemented from the live docs once reachable; the provider port isolates this. |
| Long-lived token lifetime (believed **60 days**) and refresh rule (believed: token ≥ **24 h** old and unexpired) | Encoded in `token-lifecycle.ts` with an UNVERIFIED comment; refresh lead time (10 days) is an application policy, not a Meta rule. Expired token → `REAUTH_REQUIRED`. |
| Development/testing mode behaviour (app roles, tester accounts) | Not stated on the pages fetched. Plan: develop with app-role users; use mock mode otherwise. |
| Business Verification requirements for Advanced Access | Not stated on the pages fetched. |
| Rate-limit headers / error codes / `Retry-After` for Instagram endpoints | `MetaProvider` will map by error code once confirmed; unknown codes are classified `UNKNOWN` (uncertain → reconcile, never blind retry). |

## What I cannot do from here (external steps)

1. Create the Meta app, add the Instagram product, configure redirect URIs, and obtain App ID/Secret.
2. Add test users / app roles; later submit **App Review** (screencast, privacy policy URL, data deletion callback,
   possibly Business Verification) to serve users other than yourself.
3. Put real credentials into your secret manager (never into git).

## Mock mode

`INSTAGRAM_PROVIDER=mock` selects `MockInstagramProvider`. Mock accounts have ids prefixed `mock_`, jobs end as
`SIMULATED`, and the UI shows a persistent **MOCK MODE — nothing is published to Instagram** banner. The database
forbids marking a mock job `ACCEPTED`/`CONFIRMED`.
