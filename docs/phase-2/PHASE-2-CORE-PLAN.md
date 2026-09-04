# Phase 2-core — MVP-blocking cross-cutting infrastructure

> **Approved direction (owner, 2026-09-04):** the MVP-oriented Phase 2-core only.
> Split from the full Phase 2 (`ROADMAP.md` "Phase 2") per **OD-P2-2**. The Class-B/C
> remainder is tracked in [`PHASE-2-BACKLOG.md`](PHASE-2-BACKLOG.md) with explicit
> first-consumer gates — **not dropped**.
>
> Maps to `ARCHITECTURE.md` §13–14, §45, §46, §49; `SECURITY.md`; `ROADMAP.md`
> "Phase 2"; ADR-0009 (realtime pipeline), ADR-0016 (audit/outbox foundation),
> `REALTIME-PROTOCOL-INPUTS.md` (F8/F9).
>
> Runs after `phase-1-complete` (`d44566b`, untouched) + the post-Phase-1 auth
> hardening (`57952a4`). One task at a time; branch-per-task
> `phase-2/2.x-<slug>`; one verified commit per task; `main` always green; tests +
> `security-review` + tenant-isolation + branch-isolation review before every
> commit. **STOP at `phase-2-core-complete`** for explicit owner approval before
> either Phase 3 or the Phase-2 remainder.

---

## 0. Locked decisions & architecture corrections (owner, 2026-09-04)

### Locked decisions

- **OD-P2-1 — audit hash chain deferred.** Phase 2-core adds **nullable schema
  support only** (`audit_log.prev_hash`, `audit_log.entry_hash`, both nullable,
  never populated in core). The full per-tenant chain + the scheduled verification
  job land with the **Phase 4 Z-Report hash chain** as one shared primitive. All
  existing append-only / audit-registry / RLS guarantees stay intact. ADR-0016 is
  amended to record this (was "Phase 5 / whichever is first" → now "Phase 4, with
  the Z-Report chain").
- **OD-P2-2 — Phase 2 is split.** Execute **only** the MVP-blocking core (§3 tasks
  2.0–2.8). After core verification is green: `PHASE-2-CORE-RESULTS.md`, tag
  `phase-2-core-complete`, push, verify the tag, **STOP**. Do **not** claim
  `phase-2-complete`. Do **not** silently drop the remainder — it lives in
  `PHASE-2-BACKLOG.md` with the first-consumer gate for each item. Do **not**
  execute a Class-B/C task now unless a core task proves it is genuinely required
  (recorded as a plan amendment if so).
- **OD-P2-3 — realtime `seq`** (+ **2026-09-04 clarification**). A
  **per-tenant-global monotonic logical `seq`**, assigned once and immutable
  (FC-1). The **Redis Stream entry ID / retained-stream position is the _single_
  correctness basis** for resume and retention-gap detection; `seq` is **logical
  ordering / diagnostics only**. **No arithmetic `seq`-distance resync trigger at
  any granularity** — not per-topic, and **not** `tenantHighWaterSeq −
clientLastSeq` (a tenant-global `seq` is advanced by unrelated branch activity →
  that check would re-create F8). The client persists a **scanned Stream cursor**
  that the gateway advances across **every** stream entry it reads on the client's
  behalf (incl. filtered-out / other-branch entries), so unrelated tenant activity
  never strands a subset-subscribed client. `resource_version` gates payload
  application; the scanned cursor advances for `duplicate` / `stale` / not-for-me.
  Heartbeat: current Stream tail ID + scanned cursor + an **informational** tenant
  high-water `seq`. Full detail: [ADR-0017](../decisions/ADR-0017.md) §3, §6a–c,
  §7.
- **OD-P2-4 — one durable Redis Stream per tenant; relay + Pub/Sub for live
  fanout.** A gateway **consumer group is NOT the socket-broadcast mechanism**
  (consumer groups distribute entries between members → sockets on other gateway
  instances would miss events). The pipeline is:

  ```
  PostgreSQL outbox  (domain write + outbox row, one txn)
    → durable Redis Stream per tenant           (event history / resume)
    → realtime relay/consumer                    (reads the stream)
    → Redis Pub/Sub live channel                 (live multi-gateway fanout)
    → every realtime gateway instance
    → authorized branch / resource subscriptions → sockets
  ```

  Reconnect / resume reads and replays from the **durable stream**. Live duplicate
  deliveries are **acceptable** and are suppressed by stable `event_id` dedup.
  Stream retention targets 24h via a **time-based policy** (periodic
  `XTRIM MINID` / `XADD … MINID ~` keyed to `now − 24h`) — **`MAXLEN` is never
  described as a 24h guarantee**.

- **OD-P2-5 — devices are not MVP-blocking.** Browser POS is the MVP default where
  `browser_pos_allowed` permits. The request-pipeline "registered device" step
  stays a **documented no-op** (Phase-1 amendment 1) until the devices backlog item
  lands. `registered_device_required` stays unsettable in core.
- **OD-P2-6 — on-screen confirmation is enough for the earliest MVP.** Notifications
  / email are a backlog item, gated **before Customer Web (Phase 7) production
  use**.
- **OD-P2-7 — anonymous Customer Web checkout for the MVP.** No SMS-OTP dependency
  for the first release.
- **OD-P2-8 — separate processes on shared infra.** `api`, `realtime`, `worker`,
  `scheduler` run as **separate processes / Compose services** on the same
  VPS / Docker Compose environment for the MVP — **not** merged into the API
  process. Each keeps its own failure / restart / scaling boundary. They **reuse
  the authoritative backend domain logic** (`NestFactory.createApplicationContext`
  onto the api domain modules) and **never** duplicate a business rule (CLAUDE.md
  rule 1). ADR-0013's "fold onto the domain modules" wording is clarified in an
  ADR amendment: _reuse the modules, do not co-locate the runtime_.
- **OD-P2-9 — English-first MVP UI, Arabic/RTL-ready data model.** The
  `translation` table + every user-facing content field's translation path are
  built now. UI message catalogs / full Arabic content are a backlog item. **An
  English MVP is not final GCC localization compliance** — that is a tracked gate
  before full GCC production / marketing.
- **OD-P2-10 — no OCR.** `document_extraction` (backlog) stays nullable /
  future-facing.

### Architecture corrections

1. **Idempotency table.** `idempotency_key` is **not partitioned** in core (a
   partitioned table cannot carry a global unique key without the partition key in
   the constraint). Core: non-partitioned, a real unique
   `(tenant_id, scope, principal_id, key)` (the `principal_id` scoping is FC-2), a
   btree index on `expires_at` for the TTL sweep, a `(status, locked_at)` index for
   stale-lock recovery. Partitioning is revisited only with evidence-based scale
   need.
   `DOMAIN-MODEL.md §Partitioning` is corrected to drop `idempotency_key` from the
   from-migration-#1 list. **Idempotency response snapshots must never persist
   authentication tokens, raw secrets or credential material** — the `@Idempotent`
   interceptor is opt-in per route and is **never** applied to `/v1/auth/*` or the
   `provider-credentials` routes; a snapshot-scrub test enforces it.
2. **Outbox delivery semantics.** No transport-level exactly-once between PostgreSQL
   and Redis is claimed. The model is: **atomic business mutation + outbox insert
   in one PostgreSQL txn → at-least-once publication → stable `event_id` across
   retries → safe duplicate delivery → idempotent downstream consumers →
   effectively-once business effects.** The "crash after Redis publish, before the
   `dispatched_at` update" case is an explicitly tested scenario; a retry may
   republish the same `event_id` and downstream processing stays correct. HG-OUTBOX
   and every related test/doc are written this way. ADR-0009's
   "exactly-effectively-once publish" is amended to "at-least-once publish,
   effectively-once effect".
3. **Realtime retention / fanout separation.** Three distinct layers, never
   conflated: **durable event history / resume = Redis Stream**; **live
   multi-gateway fanout = Redis Pub/Sub via the relay**; **state truth =
   REST/API + PostgreSQL**. A realtime event is a **change signal, never
   authoritative business state**. The verification task runs **≥ 2 gateway
   instances** and proves a client on each receives the same authorized branch
   event.
4. **Localization / GCC legal-entity model.** Legal currency / VAT / fiscal
   configuration is **not** derived from `tenant.region`. The fiscal source is the
   **company / legal entity's `country_code`**:

   ```
   Tenant
     → Company / Legal Entity  (country_code + fiscal/currency config, effective-dated)
       → Branch                (inherits company defaults; may override display currency only)
   ```

   A tenant stays architecture-ready to own legal entities in **different GCC
   countries**. Country / tax reference data is **effective-dated** — no legal tax
   value is frozen in code. Initial reference data is seeded; production onboarding
   carries an explicit **fiscal-reference verification step** (see
   `GCC-FISCAL-REFERENCE.md`, produced in 2.7). The **Phase 3 tax-calculation
   engine is not built in Phase 2** — core builds reference data + config +
   company-level resolution only.

### Final implementation constraints (owner, 2026-09-04)

- **FC-1 — realtime sequence stability.** For a given outbox event: `event_id` is
  **immutable**; `seq` is **assigned once and is immutable**; a retry /
  republication after any crash **reuses the same `event_id` and the same `seq`**.
  A new `seq` is **never** allocated merely because `XADD` is retried. A crash
  after the Redis Stream publish but before the PostgreSQL dispatch ack may cause
  **duplicate transport delivery**, but **both copies carry the identical
  `event_id` and `seq`**. Mechanism: `seq` is allocated and **persisted to the
  `outbox` row in a committed UPDATE before `XADD`**, and the dispatcher **never
  re-assigns a non-null `seq`**. The Redis Stream entry ID stays the resume cursor;
  `seq` is a logical ordering / diagnostic value, **not** the primary resume
  cursor. A dedicated test proves identical `event_id` + `seq` across a
  crash-induced duplicate publish (task 2.4).
- **FC-2 — idempotency principal scoping.** The idempotency identity **must not**
  let a stored response from one authenticated principal be replayed to another
  merely because they share a tenant and an `Idempotency-Key`. The identity is
  `(tenant_id, canonical operation/route scope, authenticated principal id, key)`;
  the `request_hash` additionally binds method + path + normalized body. **No raw
  JWT, refresh token, cookie, secret or credential** goes into the hash or the
  snapshot. **Stale `PENDING` recovery** is implemented and tested: a request
  starts → the process dies before completion → after the defined stale threshold
  the lock is recoverable → a retry safely re-executes (the underlying domain
  operation is itself transactional/idempotent) → **no permanent dead key
  remains** (recoverable stale + TTL sweep).
- **FC-3 — worker/scheduler module boundary.** `api`, `worker`, `scheduler`,
  `realtime` stay separate processes/services. They reuse the **same authoritative
  domain logic**, but `worker` / `scheduler` **must not depend on HTTP
  controllers, Fastify request logic, or any transport-specific module**. The
  **minimum** reusable backend module layer currently under `apps/api` is
  **extracted into a package** (`@flower/<name>`) so `api`, `worker` and
  `scheduler` all consume it and every business rule is implemented **once**.
  `apps/api` retains controllers + HTTP wiring only. **No speculative redesign**;
  the existing `eslint-plugin-boundaries` rules are respected and extended to the
  new package. This resolves OI-P2-3 → **extract (minimum)**.

---

## 1. Scope

### In scope — Phase 2-core (MVP-blocking)

| Task | Title                                                                                                        |
| ---- | ------------------------------------------------------------------------------------------------------------ |
| 2.0  | Realtime protocol decision — ADR-0017 + F8/F9 resolution (**design only, no code**)                          |
| 2.1  | `packages/db` — corrected Phase 2-core schema, RLS, migration (expand)                                       |
| 2.2  | Idempotency store + opt-in `@Idempotent` interceptor                                                         |
| 2.3  | Minimum backend-module extraction (`@flower/backend`) + worker/scheduler runtime (separate processes — FC-3) |
| 2.4  | Outbox dispatcher → durable per-tenant Redis Stream (time-based retention)                                   |
| 2.5  | Realtime relay (Stream→Pub/Sub) + gateway subscription authorization + multi-gateway live fanout             |
| 2.6  | Realtime resume / dedup / reorder / resync (implements ADR-0017) + fault injection                           |
| 2.7  | Localization reference data + `LocalizationService` + company-level fiscal defaults + provisioning seed      |
| 2.8  | Phase 2-core verification pass + `PHASE-2-CORE-RESULTS.md` + `phase-2-core-complete` tag                     |

### Explicitly deferred to the Phase-2 remainder (`PHASE-2-BACKLOG.md`)

devices (registered-device foundation) · documents domain · notifications + email +
WhatsApp share · full audit hash chain + verification job · `packages/money` /
`packages/uom` completion pass · concrete non-critical worker/scheduler jobs ·
realtime SSE fallback · UI internationalization / Arabic content · OCR.

### Explicitly NOT in Phase 2 at all

No catalog, pricing, **tax-calculation engine**, orders, payments, inventory, BOM,
production, procurement, cash-register, expenses, accounting, crm, storefront,
fulfilment, workforce, attendance, commissions, ai, whatsapp-BSP, reporting
rollups. The only tax-adjacent artefact is **reference/config data** (2.7). No
offline Class-B sale path — `pos.offline_cash_sale` stays inert (Z-6 / ADR-0008);
the MVP is online-authoritative.

---

## 2. Enforcement model (inherited from Phase 1 + realtime additions)

- The Phase 1 model is unchanged: four axes (entitlement · permission · data scope ·
  business rule) checked in pipeline order; `RequestContext` immutable and only
  from the session; `ScopedRepository` → Prisma interactive txn → `set_config` →
  RLS; `flower_app` `NOSUPERUSER NOBYPASSRLS`; realms isolated.
- **Realtime isolation (new, SECURITY.md "Realtime" layer):** topics are
  **server-derived** from the session's tenant + branch scope. A client can never
  name an arbitrary topic string. The subscription guard pipeline re-runs on
  **every** `subscribe` and on **every** token refresh; session revocation → Redis
  Pub/Sub → **every** gateway instance drops the socket. The gateway holds **no
  authoritative business logic** — it authorizes topics and forwards change signals
  (ADR-0009 / CLAUDE.md rule 1).
- **Idempotency (new):** state-changing external-facing writes carry
  `Idempotency-Key`; the store is keyed by
  `(tenant_id, operation scope, authenticated principal, key)` (FC-2 — a stored
  response is never replayable across principals); the interceptor is opt-in and
  excluded from auth / secret routes; stale `PENDING` locks are recoverable.
- **Outbox (unchanged intent, corrected semantics):** the domain write and its
  `outbox` row commit together; publication is at-least-once; effects are
  effectively-once via stable `event_id` + idempotent consumers.

---

## 3. Task-by-task plan

Each task ends with: unit + integration tests green · `security-review` skill ·
tenant-isolation + branch-isolation review · Conventional-Commit with the two
trailers · `main` green.

---

### 2.0 — Realtime protocol decision: ADR-0017 + F8/F9 resolution · design only

**No code.** Produce `docs/decisions/ADR-0017.md` and update
`REALTIME-PROTOCOL-INPUTS.md` §Acceptance, `ARCHITECTURE.md §13–14`, the
`RealtimeEvent.seq` doc comment in `packages/realtime-client`, and amend ADR-0009
(delivery semantics + the relay/Pub-Sub layer) + ADR-0013 (process separation **+
the minimum backend-module extraction, FC-3**) + ADR-0016 (hash-chain timing).

**ADR-0017 decisions (from OD-P2-3 / OD-P2-4 / FC-1):**

| Concern                                 | Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `seq` scope                             | per-tenant-global monotonic logical `seq`, allocated by the dispatcher (single writer per tenant → strictly increasing).                                                                                                                                                                                                                                                                                                                                                                |
| `seq` / `event_id` stability (**FC-1**) | both are **assigned once and immutable**. `seq` is allocated and **persisted to the `outbox` row in a committed UPDATE before `XADD`**; the dispatcher **never re-assigns a non-null `seq`**; `event_id` is deterministic from the outbox row id. A retry after any crash republishes the **same `event_id` + same `seq`** — a new `seq` is never allocated because `XADD` was retried.                                                                                                 |
| Durable cursor                          | the **Redis Stream entry ID**. The client stores the last stream ID it processed for the connection; resume = `XRANGE`/`XREAD` from that ID. `seq` is a **logical ordering / diagnostic** value, **not** the resume cursor.                                                                                                                                                                                                                                                             |
| Topic model                             | `t:{tenantId}:b:{branchId}:{resourceType}`, server-derived from the session. One **durable stream per tenant** (`rt:stream:{tenantId}`); events tagged with topic; the gateway filters per subscription.                                                                                                                                                                                                                                                                                |
| Live fanout                             | dispatcher → durable stream → **relay** (one logical consumer of the stream) → **Redis Pub/Sub** channel(s) (`rt:live:{tenantId}` or per-topic) → **all** gateway instances → authorized sockets. Consumer groups are **not** the broadcast path.                                                                                                                                                                                                                                       |
| Dedup                                   | by `event_id` (client reducer, apply-once; gateway may also dedup a short window). Redelivery after any crash carries the **same `event_id`** (derived from the outbox row id).                                                                                                                                                                                                                                                                                                         |
| Out-of-order / stale                    | `resource_version` gates **payload application** only. The client's **stream position advances for every event consumed from the stream**, including `stale` / `duplicate` (fixes F9). Position ≠ resource state — separated in `EventReducer`.                                                                                                                                                                                                                                         |
| Resync trigger                          | if the stored stream ID is older than the stream's first retained entry (`XINFO STREAM` first-id > stored id) → **full REST resync** of the subscribed lists, then set the position to the current tail. The heartbeat carries the tenant high-water `seq` + current tail ID; a client far behind resyncs proactively. `DEFAULT_MAX_SEQ_GAP` is **retired as the primary trigger** (kept only as a sanity ceiling). This eliminates the F8 false-resync under cross-topic interleaving. |
| Retention                               | time-based, 24h target (Z-7): periodic `XTRIM {stream} MINID ~ <ms(now−24h)>` and/or `XADD … MINID ~`. **Not** a `MAXLEN` guarantee.                                                                                                                                                                                                                                                                                                                                                    |
| Event = signal                          | payload is a small summary; the client refetches the resource over REST for detail. The event is **never** authoritative state.                                                                                                                                                                                                                                                                                                                                                         |

**Exit:** ADR-0017 accepted by the owner; the acceptance-test list in
`REALTIME-PROTOCOL-INPUTS.md` is frozen; the three cross-referenced ADR amendments
are written.

---

### 2.1 — `packages/db`: corrected Phase 2-core schema, RLS, migration (expand)

Prisma models (text + CHECK, UUID v7, `created_at/by` + `updated_at/by`, composite
indexes lead `tenant_id`); one forward-only **expand** migration; the migration
baseline assertion in `migration.test.ts` updated.

**New tenant-owned tables (RLS `ENABLE + FORCE`):**

- `idempotency_key` — `(id, tenant_id, scope, principal_id, key, request_hash,
status [PENDING|DONE], response_snapshot jsonb?, http_status int?, locked_at,
created_at, expires_at)`. **Non-partitioned.** Unique
  `(tenant_id, scope, principal_id, key)` — **FC-2**: `principal_id` is the
  authenticated user / platform-user id, so a key + response is never shared
  across principals (a different principal with the same key is a different row →
  a fresh execution, not a 409). Index on `expires_at` (TTL sweep), index on
  `(status, locked_at)` (stale-lock recovery). No auth/secret snapshots ever
  stored (enforced in 2.2 + test). `locked_at` drives stale-`PENDING` recovery
  (FC-2 / 2.2).
- `translation` — `(id, tenant_id, entity_type, entity_id, field, locale, value,
updated_at)`. Unique `(tenant_id, entity_type, entity_id, field, locale)`. The
  Arabic/RTL-ready path for every user-facing content field (OD-P2-9).

**Schema changes to existing tables:**

- `company` — add `country_code text` (CHECK: `AE|SA|QA|KW|BH|OM` + extensible),
  `default_currency text` (CHECK: known currency), `fiscal_config jsonb?`
  (non-secret; e-invoicing profile ref, invoice-series policy — populated in 2.7).
  Provisioning (2.7) sets `country_code` per company; `tenant.region` stays for
  data-residency / infra only (ADR-0011).
- `outbox` — add `seq bigint?` (**FC-1**: allocated once, persisted before `XADD`,
  never re-assigned while non-null), `attempts int default 0`,
  `available_at timestamptz default now()`, `last_error text?`. Keep the existing
  `created_at` range partitioning (outbox is legitimately high-volume; no unique
  constraint issue). Refine the partial index `WHERE dispatched_at IS NULL` to
  `(available_at) WHERE dispatched_at IS NULL`.
- `audit_log` — add `prev_hash bytea?`, `entry_hash bytea?` — **nullable, never
  written in core** (OD-P2-1). Columns exist so the Phase 4 chain is not a
  migration rewrite.

**Platform-global reference tables (no `tenant_id`; RLS-exempt, documented like
`plan`):**

- `country` — `(code PK, name_en, name_ar, region, default_currency_code,
weekend_model, calendar_flags jsonb, active)`.
- `currency` — `(code PK, exponent, symbol, name_en, name_ar)`.
- `country_tax_config` — `(id, country_code, effective_from date, effective_to
date?, regime [VAT|NONE], config jsonb)` — effective-dated; QA/KW seeded as
  `regime = NONE`, not a 0% rate.
- `tax_category` — `(key PK, name_en, name_ar, description)` (STANDARD, ZERO_RATED,
  EXEMPT…).
- `tax_rate` — `(id, country_code, tax_category_key, rate_bps int, effective_from
date, effective_to date?)` — effective-dated. **No calculation logic here** —
  data only.
- `locale` — `(code PK, name_en, name_ar, direction [ltr|rtl])`.
- `holiday` — `(id, country_code, on date, name_en, name_ar, kind)`.

**RLS / partitioning:** `ENABLE + FORCE` on `idempotency_key` and `translation`.
No new partitioned tables in core (`idempotency_key` explicitly not — correction 1).
`outbox` keeps its partitioning.

**Doc corrections in this task:** `DOMAIN-MODEL.md §Partitioning` drops
`idempotency_key`; `DOMAIN-MODEL.md` core relationships note company `country_code`.

**Tests:** migration baseline updated; RLS `ENABLE + FORCE` + policy present for
every new tenant table; `flower_app` still `NOBYPASSRLS`; reference tables readable
without a tenant GUC; `idempotency_key` unique constraint rejects a duplicate
`(tenant_id, scope, principal_id, key)` and **accepts** the same `(scope, key)` for
a different `principal_id` (FC-2).

**Gates:** HG-RLS, HG-SCHEMA.

---

### 2.2 — Idempotency store + opt-in `@Idempotent` interceptor

`IdempotencyService` + a NestJS interceptor, **opt-in per route** via
`@Idempotent({ scope })` where `scope` is the canonical operation name (not the
raw path). Flow:

1. Read `Idempotency-Key` (uuid, required on decorated routes).
2. **Identity (FC-2):** `(tenant_id, scope, principal_id, key)` where
   `principal_id = ctx.userId ?? ctx.platformUserId` (the stable authenticated
   principal — a legitimate retry after re-login still dedupes; a _different_
   principal cannot be handed this principal's response). `request_hash =
sha256(method + canonical path + scope + principal_id + normalized body)`.
   **No raw JWT / refresh token / cookie / secret / credential** enters the hash.
3. Upsert on the unique key:
   - **new row** → `PENDING`, `locked_at = now()`; run the handler; store a
     **field-allowlisted** `response_snapshot` (never `Set-Cookie`,
     `Authorization`, `*token*`, `*secret*`, `*password*`, `*credential*`) +
     `http_status`; mark `DONE`.
   - existing `DONE` + **same** `request_hash` → return the stored snapshot +
     status.
   - existing + **different** `request_hash` → `409 IDEMPOTENCY_KEY_REUSED`.
   - existing `PENDING` **and** `locked_at > now() - STALE_THRESHOLD` (a live
     concurrent request) → `409 IDEMPOTENCY_IN_PROGRESS`.
   - existing `PENDING` **and** `locked_at <= now() - STALE_THRESHOLD` (**stale —
     FC-2**) → take over: `UPDATE … SET locked_at = now() WHERE status = 'PENDING'
AND locked_at = <observed>` (compare-and-swap); if it wins, **re-execute the
     handler** (the underlying domain op is itself transactional/idempotent — its
     prior partial attempt either committed or rolled back); store the result.
     **No permanent dead key** — stale locks are recoverable and the TTL sweep
     removes expired rows.

`STALE_THRESHOLD` is config (default ~ 2 min). TTL sweep + the stale metric are
scheduler jobs (run by 2.3's scheduler).

**Never applied to:** `/v1/auth/*` (login, mfa/verify, refresh, logout, step-up,
set-password), the `provider-credentials` routes. A test asserts no auth/secret
route is decorated and that a snapshot never contains a token/secret-shaped string.

**Tests (Testcontainers pg):**

- replay same key+hash → cached, handler runs once; different hash → 409.
- **FC-2 cross-principal:** principal A stores a response under key K; principal B
  (same tenant) sends key K → B gets a **fresh execution**, never A's response.
- N concurrent same-(principal,key) → exactly one execution; others get
  409-in-progress, then the cached result.
- **FC-2 stale recovery:** start a decorated request, kill the process before
  completion (row left `PENDING`); after `STALE_THRESHOLD`, a retry **takes over,
  re-executes, completes**; no dead key remains; the TTL sweep later clears it.
- tenant B's key never collides with tenant A's; snapshot scrub (no token/secret
  substrings); auth routes carry no decorator.

**Gate:** HG-IDEM.

---

### 2.3 — Minimum backend-module extraction + worker/scheduler runtime (FC-3)

`api`, `worker`, `scheduler`, `realtime` stay **separate processes / Compose
services** (OD-P2-8). Business rules are implemented **once** and `worker` /
`scheduler` carry **no dependency on HTTP controllers, Fastify request logic, or
any transport-specific module** (FC-3).

**Extraction (minimum, no speculative redesign):**

- Extract the reusable backend module layer that the core non-API processes
  actually consume into a package — working name **`@flower/backend`**
  (`packages/backend`). It contains the infrastructure + domain-service Nest
  modules currently under `apps/api/src/common/*` and the domain
  service/repository layer of `apps/api/src/modules/*` — **without** controllers,
  HTTP guards/interceptors bound to Fastify, `main.ts`, CORS, Swagger.
- **The exact cut is decided at task start** and kept minimal: only what 2.4
  (outbox dispatcher: scoped/platform DB, `OutboxWriter` read side, context,
  redis, config, logger, errors), 2.2's sweep (DB + `IdempotencyService`), and
  2.5 (session/topic authorization: `common/auth` + the policy resolver) need.
  Domain modules with no core-process consumer may stay in `apps/api` for now and
  move only when a later phase's job needs them (tracked, not pre-done).
- `apps/api` keeps its controllers + HTTP guard/interceptor wiring + `main.ts` and
  imports `@flower/backend`. **Behaviour is unchanged** — the Phase 1 test/probe
  suites must stay green through the move (this is the extraction's safety net).
- `eslint-plugin-boundaries` config is extended: `@flower/backend` is a new
  element type; `apps/worker` / `apps/scheduler` may depend on `@flower/backend`
  and `@flower/*` libs **only** — a dependency on `apps/api` or on anything
  `*controller*` / Fastify fails lint.

**Runtimes:**

- `apps/worker` + `apps/scheduler` boot a Nest **application context**
  (`NestFactory.createApplicationContext`) over `@flower/backend` modules.
- `apps/worker`: BullMQ workers over the existing `QUEUES` set — per-queue
  concurrency + retry/backoff + **DLQ**; a processor registry binding each queue
  to a `@flower/backend` handler. The **outbox dispatcher (2.4) runs here** as a
  dedicated loop (not a BullMQ queue).
- `apps/scheduler`: the `REPEATABLE_JOBS` registry — enqueue only. Core jobs:
  idempotency-key TTL sweep + stale-lock metric, outbox-lag alarm, realtime
  stream `XTRIM` (time-based retention). Domain jobs stay in the backlog / their
  phases.
- `packages/service-runtime`: extend the shared bootstrap (graceful shutdown that
  drains in-flight jobs).
- Docker Compose: `flower-worker`, `flower-scheduler`, `flower-realtime` as
  distinct services alongside `flower-api`; `flower` / `flower-saas` namespacing.

**Tests:** every Phase 1 suite + probe stays green after the extraction; the app
context boots and resolves a `@flower/backend` service in `worker` and
`scheduler`; a queued job round-trips through a real processor; repeated failure →
DLQ; the scheduler enqueues on its interval; SIGTERM drains; the boundaries lint
**fails** if `worker`/`scheduler` reach a controller/Fastify module.

**Gates:** HG-RUNTIME, HG-BOUNDARY.

---

### 2.4 — Outbox dispatcher → durable per-tenant Redis Stream

In `apps/worker`, a dedicated dispatcher loop (single leader via a Postgres
advisory lock so per-tenant `seq` is strictly increasing):

1. `SELECT … FROM outbox WHERE dispatched_at IS NULL AND available_at <= now()
ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT n` (platform path — outbox is
   cross-tenant infra).
2. **Assign `seq` once, durably, before publishing (FC-1 + ADR-0017 §1).** Only
   the **single active dispatcher leader for that tenant** (Postgres advisory lock
   on a tenant bucket) allocates `seq`. For each claimed row **where `seq IS NULL`**,
   in `(created_at, id)` order: allocate the next per-tenant monotonic value
   (mechanism decided in OI-P2-1 — must be crash-safe, gap-tolerant, no reuse/
   reorder) and `UPDATE outbox SET seq = $seq WHERE id = $id AND seq IS NULL`,
   **committed before step 3**. A row with a non-null `seq` (re-selected after a
   crash) **keeps it**. A non-leader dispatcher that `SKIP LOCKED`-claims a row for
   a tenant it is not leader for **defers** the row (no stamp, no publish).
3. `XADD rt:stream:{tenantId} * …envelope…` — the ADR-0009 envelope
   `{event_id, seq, tenant_id, branch_id, type, resource_type, resource_id,
resource_version, occurred_at, actor_summary}`. `event_id` is **deterministic
   from the outbox row id**; `seq` is the value persisted in step 2. A retry
   therefore republishes the **identical `event_id` and `seq`**.
4. Fan out to BullMQ (`reporting-rollups`, `notifications` — consumers land with
   their phases) + the in-process bus.
5. `UPDATE outbox SET dispatched_at = now()`.

**At-least-once, effectively-once effects (correction 2 / FC-1):** a crash between
step 3 and step 5 leaves the row `dispatched_at IS NULL` **but `seq` already
set** → it is re-selected and **re-published with the same `event_id` and the same
`seq`** — a new `seq` is never allocated because `XADD` was retried. On persistent
`XADD` failure: `attempts++`, `available_at = now() + backoff`, `last_error` set;
after N attempts → a dead-letter table / alarm, other rows unblocked.

Retention: a scheduler job runs `XTRIM rt:stream:{tenantId} MINID ~ <now−24h>`
periodically (**time-based**, not `MAXLEN`).

Metrics: outbox lag (oldest undispatched `created_at`), publish failures, per-tenant
stream length.

**Tests (pg + redis Testcontainers):**

- a committed `outbox` row appears on `rt:stream:{tenantId}` and `dispatched_at`
  is set; ordering per tenant by `seq`.
- **FC-1 — kill the dispatcher between `XADD` and the `dispatched_at` UPDATE** → on
  restart the row is re-published; **both stream entries carry the identical
  `event_id` AND the identical `seq`**; a downstream idempotent consumer applies it
  once (no duplicate effect).
- a re-selected row with a non-null `seq` is never given a new `seq`.
- **OI-P2-1 concurrency** — two dispatcher processes running: only the tenant's
  leader allocates `seq`; per-tenant `seq` is strictly increasing and matches
  `(created_at, id)` order; a non-leader defers rather than stamping; a leader
  handover (advisory-lock release) does not produce a `seq` reorder or reuse.
- persistent `XADD` failure → `attempts` climbs, `available_at` backs off, other
  rows still flow; dead-letter after N.
- `XTRIM` is time-based — an entry older than the window is trimmed, a newer one
  is not; the window is not asserted as an exact `MAXLEN`.

**Gate:** HG-OUTBOX — _"a committed outbox row is published at least once;
`event_id` **and `seq`** are assigned once and stable across retries; a crash after
publish before ack yields a duplicate publish carrying the identical `event_id` +
`seq` and downstream effects stay correct; no event is lost."_

---

### 2.5 — Realtime relay + gateway subscription authorization + multi-gateway live fanout

**Relay** (in `apps/realtime`, or a small `apps/worker` loop — decided at task
start; kept separate from the gateway's socket handling): one logical consumer of
each `rt:stream:{tenantId}` (a consumer group is fine **here** — this is the relay's
own scaling, not socket broadcast) → `PUBLISH rt:live:{tenantId}` (or per-topic
channels) with the same envelope. The relay tracks its stream position (consumer
group ack) so a relay restart resumes without loss; a duplicate `PUBLISH` after a
restart is acceptable (dedup by `event_id` downstream).

**Gateway** (`apps/realtime`, replaces the Phase-0 echo stub): every instance
`SUBSCRIBE`s to the Pub/Sub channel(s) for tenants that have a live socket on that
instance. On a WS connection:

- authenticate the access token → resolve the session (shared `@flower/*` auth,
  same realm rules; a tenant token on a platform-scoped topic is impossible —
  topics are tenant+branch).
- `subscribe` → the gateway **assigns** topics from the session's tenant + branch
  scope. A client-supplied topic string is **ignored**. Re-run the guard pipeline
  on every `subscribe` and on every **token refresh**.
- an incoming Pub/Sub event → deliver to each socket whose assigned topics match
  `t:{tenant}:b:{branch}:{resourceType}`, deduped by `event_id` over a short window.
- **session revocation** → Redis Pub/Sub (`rt:revoke:{sessionId}`) → **every**
  gateway instance closes that socket (< 5s).

**Tests (redis Testcontainers + ≥ 2 gateway instances):**

- a client on gateway A and a client on gateway B, both authorized for branch X,
  **both receive** the same live event (correction 3 / OD-P2-4).
- a client authorized only for branch X does **not** receive a branch-Y event; a
  tenant-B client never receives a tenant-A event; a client cannot `subscribe` to
  an arbitrary topic string.
- token refresh that narrows scope → the now-unauthorized topic stops delivering.
- session revoke → sockets on **both** instances close < 5s.
- relay restart → no lost event; a duplicate live delivery is dropped by
  `event_id`.

**Gates:** HG-RT-AUTHZ, HG-RT-FANOUT, HG-RT-REVOKE.

---

### 2.6 — Realtime resume / dedup / reorder / resync + fault injection

`packages/realtime-client`: the real WS transport (connect / auth / `subscribe` /
reconnect with jittered backoff — the existing `reconnectDelayMs`) + resume from
the persisted **scanned Stream cursor** + the **F8/F9-resolved** `EventReducer`
(ADR-0017 §3, §6a–c, §7):

- the **scanned Stream cursor** advances for **every** stream entry the gateway
  reads on the client's behalf — incl. `stale` / `duplicate` / not-for-me /
  other-branch entries (F9 + the owner clarification); the gateway reports it in
  every frame + the heartbeat and the client persists it.
- `resource_version` gates payload application only (a separate per-resource mark).
- resync is triggered **only** when the scanned cursor is below the stream's
  retained floor (`XINFO STREAM` first-id > scannedCursor). **No** `maxSeqGap`,
  **no** `tenantHighWaterSeq − clientLastSeq` (F8). `DEFAULT_MAX_SEQ_GAP` is
  deleted.

Gateway `resume` handler: given the client's scanned cursor, replay via
`XRANGE rt:stream:{tenantId} (<cursor> +`, payload-filtered to authorized topics,
advancing + returning the scanned cursor across all entries; if the cursor is
below the retained floor → respond `resync-required` with the current tail id.

**Tests — the frozen `REALTIME-PROTOCOL-INPUTS.md` acceptance suite (10 cases;
build-blocking, its own CI `realtime` job):** F8 no-false-resync · F9 reorder ·
**unrelated-tenant-activity (branch-A-only client, thousands of branch-B events,
zero branch-A events, high-water advances → no resync, scanned cursor advances to
≈ tail, within-retention reconnect resumes) · no `tenantHighWaterSeq −
clientLastSeq` comparison anywhere** · retention-gap → resync · within-retention
exact replay · FC-1 crash-republish identity · multi-gateway fanout · isolation ·
revocation · fault injection (gateway / dispatcher / relay / Redis).

**Gate:** HG-RT-RESUME.

---

### 2.7 — Localization reference data + service + company-level fiscal defaults + provisioning seed

`localization` module (api):

- **Reference data + seed:** the GCC set into `country` / `currency` /
  `country_tax_config` / `tax_category` / `tax_rate` / `locale` / `holiday` —
  AED/SAR/QAR exponent 2, KWD/BHD/OMR exponent 3; UAE 5% / KSA 15% / Bahrain 10% /
  Oman 5% `regime = VAT`; **Qatar + Kuwait `regime = NONE`** (not 0%); weekend
  models; public-holiday sets; en (`ltr`) + ar (`rtl`) locales. **All tax data
  effective-dated** — a rate row has `effective_from`; no rate literal in code.
- **`LocalizationService`:** `forCompany(companyId)` → resolves currency +
  exponent, VAT regime + rates, locale + direction, weekend model, holidays from
  the **company's `country_code`** at an effective date — **never** from
  `tenant.region` (correction 4). `forCountry(code, at)` for lookups.
- **`TranslationService`:** read/write `translation` rows; a `translate(entity,
field, locale)` helper with English fallback.
- **`EInvoicingProvider` port stub** (ADR-0012) — interface only, no adapter; a
  `NoopEInvoicingProvider` that records intent.
- **Provisioning change:** extend the Phase 1 provisioning transaction — the
  request carries the company's `country_code` (default derived from `tenant.region`
  but stored as a company attribute); the company's `default_currency` +
  `fiscal_config` are resolved from `country` reference data; a tenant may later
  add a second company in a different GCC country (schema-ready, no code needed).
- **`docs/phase-2/GCC-FISCAL-REFERENCE.md`** — the seeded values with sources +
  effective dates + an explicit **"verify before onboarding a tenant in this
  country"** checklist (correction 4: seeded data is a starting point, not
  compliance).

**Explicitly out of scope:** the tax-calculation engine (cart → tax lines) — Phase 3.

**Tests:** seed correctness (exponents, regimes, QA/KW = NONE); effective dating
(a rate change with `effective_from` resolves correctly by date); provisioning
seeds a company's fiscal config from `country_code`, **not** `tenant.region`; a
two-company tenant with companies in AE and SA resolves different currency/VAT per
company; RLS on `translation`; reference tables readable without a tenant GUC;
`packages/money` currency table agrees with `currency`.

**Gate:** HG-LOCALE.

---

### 2.8 — Phase 2-core verification pass + `PHASE-2-CORE-RESULTS.md` + tag

Run the full core verification (see §5). Extend the cross-tenant probe suite to
every new endpoint (localization reads, any realtime REST resume endpoint). Add a
CI **`realtime`** job (Redis + ≥ 2 gateway processes; the 2.6 acceptance suite +
the 2.5 multi-gateway suite; build-blocking). `security-review` skill on the core
diff. Tenant + branch isolation review. Write `PHASE-2-CORE-RESULTS.md` (hard-gate
evidence table, the deferred-item backlog reference, doc/ADR corrections applied).
Annotated tag **`phase-2-core-complete`**; push; verify the tag via the GitHub API.
**STOP** for owner approval.

---

## 4. Hard gates — Phase 2-core is not complete until all are genuinely green

| Gate                   | Assertion                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **HG-RLS**             | RLS `ENABLE + FORCE` + policy on every new tenant-owned table (`idempotency_key`, `translation`); `flower_app` still `NOSUPERUSER NOBYPASSRLS`; a no-GUC scoped query returns 0 rows.                                                                                                                                                                                                                                                                                                                                          |
| **HG-SCHEMA**          | The expand migration is forward-only; the baseline assertion passes; `idempotency_key` is **non-partitioned** with a working unique `(tenant_id, scope, principal_id, key)`; `audit_log` hash-chain columns exist and are **nullable / unwritten**.                                                                                                                                                                                                                                                                            |
| **HG-IDEM**            | Same (principal,key)+hash → stored response, handler runs once; different hash → 409; concurrent same key → single execution; **per-principal isolation — principal B never receives principal A's stored response** (FC-2); **stale `PENDING` is recoverable — a killed-mid-flight request is safely re-executed by a retry, no dead key** (FC-2); per-tenant isolation; **no auth/secret route is idempotency-decorated and no snapshot contains a token/secret**.                                                           |
| **HG-RUNTIME**         | `worker` + `scheduler` run as **separate processes**, boot an app context over `@flower/backend`, never duplicate a rule; a job round-trips; DLQ works; SIGTERM drains.                                                                                                                                                                                                                                                                                                                                                        |
| **HG-BOUNDARY** (FC-3) | The reusable backend layer is extracted to `@flower/backend`; `apps/api` keeps controllers + HTTP wiring only; **`worker` / `scheduler` have zero dependency on any HTTP controller, Fastify request module or transport module** — the `eslint-plugin-boundaries` config enforces it and **fails** on violation; every Phase 1 test + probe stays green through the extraction.                                                                                                                                               |
| **HG-OUTBOX**          | Atomic mutation + outbox row in one txn; **at-least-once** publication; **`event_id` and `seq` assigned once and immutable** (FC-1); **crash after `XADD` before `dispatched_at`** → duplicate publish carrying the **identical `event_id` + `seq`**, downstream effect applied once, **no event lost**; poison row → dead-letter without blocking others.                                                                                                                                                                     |
| **HG-RT-AUTHZ**        | Topics are server-derived; a client cannot subscribe to another tenant/branch topic by any manipulation; the guard pipeline re-runs on every subscribe + token refresh; probe suite extended, build-blocking.                                                                                                                                                                                                                                                                                                                  |
| **HG-RT-FANOUT**       | With **≥ 2 gateway instances**, a client on each receives the same authorized branch event (live path = Pub/Sub, **not** a consumer group); duplicate live deliveries are suppressed by `event_id`.                                                                                                                                                                                                                                                                                                                            |
| **HG-RT-REVOKE**       | Session revoke closes the socket on **every** gateway instance in < 5s.                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **HG-RT-RESUME**       | The 10-case acceptance suite green: zero false resync on cross-topic interleave (F8); no false resync on reorder (F9); **a branch-A-only client survives thousands of branch-B events with no resync, its scanned cursor advancing to ≈ the stream tail, and NO `tenantHighWaterSeq − clientLastSeq` check in any path**; genuine retention gap → resync; within-retention exact replay; FC-1 crash-republish identity; fault injection (gateway / dispatcher / relay / Redis) → client converges to REST-authoritative state. |
| **HG-LOCALE**          | Company-level GCC country/currency/fiscal seed correct (exponents, VAT regimes, QA/KW = NONE); **fiscal config resolves from `company.country_code`, never `tenant.region`**; effective-dated rates; a multi-country-company tenant resolves per company; RLS on `translation`.                                                                                                                                                                                                                                                |
| **HG-NO-DOMAIN**       | No catalog/order/payment/inventory/accounting/workforce/storefront module or table exists; the **tax-calculation engine is not built**; boundary lint + review confirm.                                                                                                                                                                                                                                                                                                                                                        |
| **HG-OFFLINE**         | No offline Class-B sale path; `pos.offline_cash_sale` inert; MVP online-authoritative.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **HG-PROBE**           | The Phase 1 cross-tenant probe suite stays green and is extended to every new Phase 2-core endpoint; still mutation-tested.                                                                                                                                                                                                                                                                                                                                                                                                    |
| **HG-CI**              | GitHub CI `verify` + `security` + `e2e` + **`realtime`** green on the branch; `security-review` no open Critical/High.                                                                                                                                                                                                                                                                                                                                                                                                         |
| **HG-AUDIT**           | All Phase 1 audit guarantees intact (append-only, RLS, registry, atomic writes); hash-chain columns present but unwritten (OD-P2-1).                                                                                                                                                                                                                                                                                                                                                                                           |

### Open items to settle during Phase 2-core (not blocking the start)

- **OI-P2-1** — `seq` allocation mechanism (per-tenant `pg` SEQUENCE vs a
  `tenant_outbox_seq` counter row + `FOR UPDATE`) — decide in 2.4, record the
  chosen mechanism in ADR-0017. **It must satisfy the ADR-0017 §1 requirements**
  (owner clarification 2026-09-04): a single active dispatcher leader per tenant
  (advisory lock) is the only allocator; a durable monotonic source (gaps
  harmless, reuse/reorder forbidden); the `seq`-stamp UPDATE commits **before** any
  `XADD`; rows stamped in `(created_at, id)` order; retry identity (`event_id` +
  `seq`) read back from the row, never recomputed; a non-leader dispatcher that
  `SKIP LOCKED`-claims a row for a tenant it is not leader for defers it. "Prefer
  correctness + stable retry identity over unnecessary complexity."
- **OI-P2-2** — relay placement (`apps/realtime` process vs an `apps/worker` loop)
  — decide in 2.5.
- **OI-P2-3** — ~~domain-module reuse mechanism~~ **RESOLVED by FC-3: extract the
  minimum reusable backend layer into `@flower/backend`** (2.3). The remaining
  detail (exact module cut) is decided at 2.3 start and kept minimal.
- **OI-P2-4** — Pub/Sub channel granularity (per-tenant vs per-topic) — decide in
  2.5 against fan-out cost.
- **OI-P2-5** — whether a durable server-side resume cursor (Redis or a small
  table) is needed in addition to the client-held stream ID — decide in 2.6.

---

## 5. Phase 2-core verification matrix (task 2.8)

| Area                            | Test kind                                         | Asserts                                                                                                                                                                                                                            | Gate         |
| ------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| New-table RLS                   | integration                                       | `ENABLE + FORCE` + policy; no-GUC → 0 rows                                                                                                                                                                                         | HG-RLS       |
| Migration                       | integration                                       | forward-only; baseline; `idempotency_key` non-partitioned + unique `(tenant,scope,principal,key)` works                                                                                                                            | HG-SCHEMA    |
| Idempotency                     | integration + concurrency                         | replay / hash-mismatch / concurrent / **cross-principal isolation (FC-2)** / **stale-`PENDING` recovery (FC-2)** / tenant isolation / snapshot-scrub / auth-route exclusion                                                        | HG-IDEM      |
| Backend-layer extraction (FC-3) | boundary lint + full Phase 1 re-run               | `worker`/`scheduler` have no controller/Fastify/transport dependency (lint fails on violation); every Phase 1 suite + probe green post-extraction                                                                                  | HG-BOUNDARY  |
| Worker + scheduler              | integration                                       | separate processes; app context over `@flower/backend`; job round-trip; DLQ; drain; no rule duplication                                                                                                                            | HG-RUNTIME   |
| Outbox dispatch                 | integration (pg+redis) + fault injection          | at-least-once; **`event_id` + `seq` assigned once, immutable (FC-1)**; **crash after publish before ack** → dup publish with identical `event_id` + `seq`, single effect; ordering; dead-letter                                    | HG-OUTBOX    |
| Realtime authz                  | integration + probe                               | server-derived topics; cross-tenant / cross-branch subscribe denied; re-check on refresh                                                                                                                                           | HG-RT-AUTHZ  |
| Realtime fanout                 | integration (**2 gateways**)                      | both instances' clients get the same authorized event; live dup suppressed                                                                                                                                                         | HG-RT-FANOUT |
| Realtime revoke                 | integration (timed, 2 gateways)                   | revoke → sockets close < 5s on both                                                                                                                                                                                                | HG-RT-REVOKE |
| Realtime resume                 | integration + fault injection (CI `realtime` job) | 10-case suite: F8; F9; **unrelated-branch burst → no resync + scanned cursor advances + no high-water arithmetic**; retention-gap → resync; within-retention replay; FC-1 identity; gateway/dispatcher/relay/Redis kill → converge | HG-RT-RESUME |
| Localization                    | integration                                       | seed correctness; effective dating; **company-country resolution** not region; multi-country tenant; `translation` RLS                                                                                                             | HG-LOCALE    |
| No-domain                       | boundary lint + review                            | no MVP-domain module/table; no tax engine                                                                                                                                                                                          | HG-NO-DOMAIN |
| Offline                         | review + config                                   | no Class-B path; flag inert                                                                                                                                                                                                        | HG-OFFLINE   |
| Cross-tenant probe              | e2e suite (BUILD-BLOCKING)                        | Phase 1 probes green + extended to new endpoints; mutation-tested                                                                                                                                                                  | HG-PROBE     |
| Security review                 | skill                                             | no open Critical/High on the core diff                                                                                                                                                                                             | HG-CI        |
| CI                              | pipeline                                          | `verify` + `security` + `e2e` + `realtime` green                                                                                                                                                                                   | HG-CI        |

---

## 6. Git, tags, STOP

- Branch-per-task `phase-2/2.x-<slug>`; one verified commit per task; Conventional
  Commits + commitlint; trailers `Co-Authored-By: Claude Sonnet 5
<noreply@anthropic.com>` + `Claude-Session: <url>` on every commit; PR footer
  `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- `main` always green; **no force-push, no history rewrite**; recovery is
  revert-forward. Migrations forward-only, expand/contract.
- After 2.8 is green: commit `PHASE-2-CORE-RESULTS.md`, annotated tag
  **`phase-2-core-complete`**, push, verify the tag via
  `api.github.com/repos/horizone-dev/flower-saas`. **STOP.**
- **Do not** claim `phase-2-complete`. **Do not** start Phase 3 or the Phase-2
  remainder without explicit owner approval. `phase-1-complete` (`d44566b`) and
  `phase-0-complete` (`c1ca217`) are never moved.

---

## 7. Doc / ADR corrections produced by this phase

| Where                                | Correction                                                                                                                                                                                                                                                                                       | Task      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------- |
| `ADR-0017` (new)                     | realtime protocol: `seq` scope, stream-ID cursor, relay + Pub/Sub fanout, retention policy, F8/F9 resolution                                                                                                                                                                                     | 2.0       |
| `ADR-0009` (amend)                   | "exactly-effectively-once publish" → "at-least-once publish, effectively-once effect"; add the relay + Pub/Sub layer between the stream and the gateway                                                                                                                                          | 2.0       |
| `ADR-0013` (amend)                   | "Phase 2 folds these processes onto the api domain modules" → clarified: **the reusable backend layer is extracted to `@flower/backend`**; `api` / `worker` / `scheduler` are **separate processes** each consuming it; `worker`/`scheduler` carry no HTTP/transport dependency (OD-P2-8 / FC-3) | 2.0       |
| `ADR-0016` (amend)                   | hash chain: "Phase 5 / whichever is first" → "Phase 4, with the Z-Report hash chain"; Phase 2-core adds nullable columns only                                                                                                                                                                    | 2.0       |
| `REALTIME-PROTOCOL-INPUTS.md`        | freeze the acceptance suite against the ADR-0017 decisions                                                                                                                                                                                                                                       | 2.0       |
| `ARCHITECTURE.md §13–14`             | relay + Pub/Sub fanout; retention is time-based, not `MAXLEN`; `seq` vs stream-ID cursor                                                                                                                                                                                                         | 2.0       |
| `DOMAIN-MODEL.md §Partitioning`      | drop `idempotency_key` from the from-migration-#1 list                                                                                                                                                                                                                                           | 2.1       |
| `DOMAIN-MODEL.md` core relationships | `company.country_code` as the fiscal source; Tenant → Company(country) → Branch                                                                                                                                                                                                                  | 2.1 / 2.7 |
| `GCC-FISCAL-REFERENCE.md` (new)      | seeded country/currency/tax values + sources + effective dates + pre-onboarding verification checklist                                                                                                                                                                                           | 2.7       |
