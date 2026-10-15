# Architecture

## System

```mermaid
flowchart LR
  subgraph Client
    B[Browser]
  end
  subgraph Web["apps/web (Next.js)"]
    W[App Router UI]
  end
  subgraph API["apps/api (NestJS)"]
    A[REST /v1 + Swagger]
    AUTH[Auth + RBAC + tenant guards]
  end
  subgraph Worker["apps/worker (always-on)"]
    T[Tick processor]
    X[Publish executor]
    S[Sweeper / reconciler]
    M[Media validator]
  end
  CORE[["@reelqueue/core\n(pure rules + ports)"]]
  PG[(PostgreSQL\nsource of truth)]
  R[(Redis\nBullMQ wake-ups)]
  O[(R2 / S3\nvideo objects)]
  IG{{Meta Instagram API}}
  MOCK{{Mock provider}}

  B --> W --> A
  B -. presigned PUT .-> O
  A --> AUTH --> PG
  A --> R
  T & X & S --> R
  T & X & S & M --> PG
  M --> O
  X -- presigned GET --> IG
  IG -. fetches video .-> O
  X --> IG
  X -. dev/test .-> MOCK
  A & T & X --- CORE
```

* **PostgreSQL decides, Redis nudges.** A BullMQ job only says "look at job/cycle _X_ at time _T_". The worker re-reads
  PostgreSQL, takes a lease, and acts. The **sweeper** re-enqueues due unleased jobs, so a Redis flush delays work but
  never loses or duplicates it.
* **Only `@reelqueue/core` knows the rules.** API and worker adapt it; no scheduling logic lives in controllers or processors.

## Cycle lifecycle

```mermaid
stateDiagram-v2
  [*] --> ACTIVE: start (validated, window fixed)
  ACTIVE --> PAUSED: pause / auto-pause (auth or permission error)
  PAUSED --> ACTIVE: resume (refused if window elapsed)
  ACTIVE --> STOPPED: stop
  PAUSED --> STOPPED: stop
  ACTIVE --> EXPIRED: now >= endsAt
  PAUSED --> EXPIRED: now >= endsAt
  ACTIVE --> COMPLETED: queue drained (loop off)
  STOPPED --> [*]
  EXPIRED --> [*]
  COMPLETED --> [*]
```

`effectiveStatus()` treats an ACTIVE/PAUSED cycle past `endsAt` as EXPIRED even if the expiry job is late, and every
irreversible step uses it.

## Publish job lifecycle (executor)

```mermaid
stateDiagram-v2
  [*] --> SCHEDULED
  SCHEDULED --> CREATING_CONTAINER
  CREATING_CONTAINER --> PROCESSING_MEDIA: container id persisted
  PROCESSING_MEDIA --> PROCESSING_MEDIA: poll (IN_PROGRESS)
  PROCESSING_MEDIA --> PUBLISH_REQUESTED: FINISHED + guards pass
  PUBLISH_REQUESTED --> ACCEPTED: provider accepted
  PUBLISH_REQUESTED --> SIMULATED: MOCK provider only
  PUBLISH_REQUESTED --> PROCESSING_MEDIA: reconcile shows NOT published
  ACCEPTED --> CONFIRMED: verified with provider
  SCHEDULED --> DEFERRED: quota exhausted/unknown
  DEFERRED --> SCHEDULED
  PROCESSING_MEDIA --> RETRY_WAIT: transient error (backoff + jitter)
  RETRY_WAIT --> CREATING_CONTAINER
  SCHEDULED --> CANCELLED: cycle stopped
  SCHEDULED --> EXPIRED: cycle expired
  PROCESSING_MEDIA --> FAILED: media rejected / permanent
  CONFIRMED --> [*]
  SIMULATED --> [*]
  FAILED --> [*]
  CANCELLED --> [*]
  EXPIRED --> [*]
```

No edge leaves `PUBLISH_REQUESTED` toward `CANCELLED`/`EXPIRED`: once a publish may have been sent, the outcome is
reconciled first.

## One publish, step by step

```mermaid
sequenceDiagram
  participant Q as BullMQ
  participant W as Worker (executor)
  participant DB as PostgreSQL
  participant IG as Instagram API
  Q->>W: wake(jobId)
  W->>DB: claim (lease, due, account free, in order)
  W->>DB: fresh cycle read (ACTIVE?)
  W->>IG: quota check
  W->>IG: create REELS container (presigned GET url)
  W->>DB: persist container_id
  loop until FINISHED (bounded)
    W->>IG: container status
  end
  W->>DB: fresh cycle read again + quota again
  W->>DB: persist PUBLISH_REQUESTED (before the call)
  W->>IG: media_publish
  W->>DB: ACCEPTED (or SIMULATED for mock)
  W->>IG: confirm media
  W->>DB: CONFIRMED
  Note over W,IG: Timeout after media_publish => RECONCILE via container status after a settle window, never blind retry
```

## Semantics (precise)

| Topic | Decision |
|---|---|
| Interval | Measured **between batch starts**. `next = max(prevScheduled + interval, now)`; missed slots are not replayed; a batch is held while the previous one has unresolved jobs. Default 20 min, bounds 5–1440 (app limits, not Instagram's). |
| Batch size | 1–50 (app limit), additionally capped by the **live Instagram quota**; the remainder stays queued and is scheduled later, with the reason shown in the UI. |
| Cycle | `endsAt = startedAt + duration` (default 24 h). Pause does not extend it. Publications start only before `endsAt`. |
| Loop | When the queue drains and looping is on and the cycle is active, the cursor wraps to position 1 and `iteration` increments (new idempotency key per pass). |
| Stop | Takes effect before the next irreversible step. Unstarted jobs → `CANCELLED`. A request Instagram already accepted **cannot be recalled**, and previously published Reels are **not** removed. |
| Expiry | Unstarted jobs → `EXPIRED`; requested/accepted jobs are reconciled to a final state. |
| Retries | Transient/timeout: bounded exponential backoff + jitter, honouring `Retry-After`. Permanent (validation, permission, media rejected): no retry. Quota: defer. Auth/permission: pause the cycle and flag the account. |
| Guarantee | Safe **at-least-once execution** with duplicate prevention and reconciliation. **Not** exactly-once: if a publish response is lost and Meta has not yet reflected it when the settle window ends, a duplicate is theoretically possible (see risk R2). |
