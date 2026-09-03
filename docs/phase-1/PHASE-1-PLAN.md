# Phase 1 — Identity, tenancy, RBAC, entitlements, Super Admin MVP

> **The isolation backbone.** Approved by the owner 2026-09-03 with the locked
> decisions and amendments recorded in §0. Maps to the frozen architecture
> ([`../architecture/ARCHITECTURE.md`](../architecture/ARCHITECTURE.md) §1, §3,
> §4–12, §46, §48, §49; [`../architecture/SECURITY.md`](../architecture/SECURITY.md);
> [`../architecture/ROADMAP.md`](../architecture/ROADMAP.md) "Phase 1";
> [`../conventions/DB-CONVENTIONS.md`](../conventions/DB-CONVENTIONS.md);
> [`../conventions/API-CONVENTIONS.md`](../conventions/API-CONVENTIONS.md);
> [`../conventions/TESTING-STRATEGY.md`](../conventions/TESTING-STRATEGY.md)) and to
> the Phase 0 RLS `GO` pattern ([`../decisions/ADR-0010.md`](../decisions/ADR-0010.md)).
>
> Runs **after** the post-review remediation
> ([`../phase-0/POST-REVIEW-REMEDIATION.md`](../phase-0/POST-REVIEW-REMEDIATION.md))
> is green. One task at a time; branch-per-task `phase-1/1.x-<slug>`; one verified
> commit per task; `main` always green; tests + `security-review` +
> tenant-isolation review before every commit. **STOP at `phase-1-complete`** for
> explicit owner approval before Phase 2.

---

## 0. Locked decisions & amendments (owner, 2026-09-03)

### Decisions

- **OD1 — token transport.** Both. Owner Web + Super Admin Web use secure
  **HttpOnly cookies** (`Secure`, `SameSite`, CSRF protection). POS PWA + API
  clients use **Bearer** tokens. The two auth realms stay isolated.
- **OD2 — MFA.** Phase 1: tenant MFA = **TOTP**; Platform Super Admin MFA =
  **mandatory TOTP**. **No WebAuthn/passkeys in Phase 1** — keep the factor model
  extensible so WebAuthn drops in later.
- **OD3 — password set/reset.** Phase 1 ships **admin-generated, single-use,
  expiring set-password links**. Self-service email reset waits for the
  notifications phase. **Reset tokens are never stored in plaintext** (hash at
  rest; compare by hash).
- **OD4 — secret master key.** Environment-backed master-key custody is acceptable
  for **local dev and CI only**. The `CryptoProvider` abstraction must support a
  managed KMS / secret-manager implementation. **Production tenant onboarding must
  not rely on the dev key strategy** (gate documented in §4 hard gates).
- **OD5 — login identity.** Phase 1 = **workspace slug + email**. Host / custom
  domain tenant resolution stays Phase 7.
- **OD6 — system roles (least privilege).** Create all **13 system role
  records/templates**. Do **not** invent broad permissions for domains that do not
  exist yet. Populate real permission sets for **Owner / Admin / Manager** and the
  foundation permissions that are meaningful in Phase 1 (identity, access, org,
  self-service, audit-view). Every other future-domain role starts with a
  **minimal safe** permission set and is expanded when its domain arrives.
- **OD7 — impersonation is READ-ONLY (modified).** Phase 1 platform impersonation
  grants a **read-only** projection of the tenant. The default allowlist contains
  **no mutations** — not `users:disable`, not `sessions:revoke`, not role /
  permission / secret / financial writes. Any future support-mutation-via-
  impersonation must be a separate, narrowly-scoped, step-up-protected,
  reason-required, audited capability with its own approval.
- **OD8 — realtime `seq` semantics.** Deferred to Phase 2. F8/F9 stay recorded in
  [`../phase-2/REALTIME-PROTOCOL-INPUTS.md`](../phase-2/REALTIME-PROTOCOL-INPUTS.md).

### Amendments to the plan

1. **Registered-device feature stays unavailable in Phase 1.** Phase 1 may carry
   the policy/schema foundation (`branch_setting` key, default off), but there is
   **no tenant or Super Admin API path that can set
   `registered_device_required = true`** until the Phase 2 device implementation
   exists. Customers are never able to enter a `NOT_IMPLEMENTED` operational state.
   The request-pipeline "registered device" step is a **documented no-op in
   Phase 1** (the flag can never be true), fully implemented in Phase 2.

2. **Audit invariant (replaces the "exactly one row per endpoint" rule).** Do not
   encode a universal rule that every mutating HTTP endpoint creates exactly one
   audit row. Instead:
   - every **security/business mutation classified as auditable** (the auditable-
     action registry, §3 task 1.14) produces its required audit record(s);
   - audit records for a transactional mutation **commit atomically with the
     mutation** (same DB transaction);
   - a **rolled-back mutation leaves no committed success audit record**;
   - **multiple audit records for one request are legitimate** when the operation
     has multiple independently-auditable effects (e.g. provisioning:
     tenant-created + company-created + branch-created + owner-user-created).

   Gate **G12** and the verification matrix reflect this.

3. **Provisioning / external effects.** Database provisioning is **one
   transaction** for all DB writes. **No email, messaging, webhook or other
   external side effect runs inside a DB transaction.** Required external effects
   are written as **transactional-outbox rows** in the same transaction and
   dispatched later (the dispatcher itself is Phase 2). Phase 1 provisioning needs
   no external call at all — the Owner set-password link (OD3) is generated and
   returned in the provisioning API response.

---

## 1. Scope

### In scope (frozen — ROADMAP "Phase 1")

Modules **`platform`, `identity`, `access`, `org`, `secrets` (vault shell)**.

- **Data model + RLS:** plans / versions / entitlement + limit defaults;
  tenant / entitlement / limit; user / credential / mfa / session / refresh;
  role / permission / grant / scope; company / trade_license / branch /
  branch_setting / pos_terminal. RLS `ENABLE + FORCE` on every tenant-owned table.
  Partitioning declared from the first migration on `session`,
  `login_security_event`, `audit_log`, `outbox`.
- **Scoped data access:** production `RequestContext` + `ScopedRepository` + the
  Prisma tenant-transaction extension implementing the ADR-0010 `GO` pattern.
- **Auth + sessions:** login, Argon2id, brute-force lockout, TOTP MFA, step-up
  MFA, server-side Redis sessions, rotating refresh with reuse detection, logout,
  session revocation, admin-generated set-password links.
- **The full request pipeline** (SECURITY.md 14 steps) as ordered NestJS guards /
  interceptors, failing closed; list endpoints inject the scope filter.
- **Policy engine:** effective-permission resolution
  (∪ roles ∪ grants − denies, deny wins) ∩ entitlement ∩ target scope; step-up
  flags; permission-preview API.
- **Entitlements + limits:** `EntitlementService`, `LimitService` (enforced on
  create / activate / login), per-tenant overrides with mandatory reason + audit.
- **Tenant provisioning + lifecycle:** create / suspend / resume / terminate;
  provisioning seeds system roles + permission-registry link + first company +
  branch + pos_terminal + first Owner user + entitlement/limit snapshot.
- **Impersonation:** time-boxed, reason-tagged, **read-only** (OD7), banner flag,
  dedicated audit stream.
- **`secrets` vault shell:** `provider_credential` table, platform-realm-only
  service, `CryptoProvider` envelope-encryption interface (dev impl: AES-256-GCM +
  per-tenant DEK), masking, log-redaction filter + tests, non-secret operational
  settings in a separate `tenant_setting` table. **No tenant-realm permission key
  for secrets.**
- **Minimal audit + outbox foundation:** append-only `audit_log` written inline in
  the request transaction; `outbox` table written in the same transaction. **No
  dispatcher, no hash chain, no Redis-Streams publish** (Phase 2).
- **Super Admin Web MVP** + tenant login + a read-only "my access" screen.
- **Cross-tenant probe suite v1** (build-blocking, every endpoint) + RLS-bypass
  attempts + realm-separation tests + branch-scope tests over the Phase 1
  endpoints.

### Explicitly NOT in Phase 1

- No `devices` module (`pos_device`, activation codes, WebCrypto keypair, DPoP) —
  Phase 2. No API to enable `registered_device_required` (amendment 1).
- No `realtime` — Phase 2. Session revocation is enforced on the next HTTP
  request; the socket-drop is Phase 2.
- No `localization` — Phase 2. Provisioning does **not** seed country / VAT config
  or a Chart of Accounts.
- No outbox **dispatcher**, no audit **hash chain / tamper job** — Phase 2.
- No catalog, pricing, tax, orders, payments, inventory, BOM, production,
  procurement, cash-register, expenses, accounting, crm, fulfilment, storefront,
  workforce, attendance, commissions, ai, whatsapp, notifications, documents,
  reporting, files — Phases 3+.
- No cloud KMS wiring (OD4), no WebAuthn (OD2), no host→tenant resolution (OD5),
  no self-service email password reset (OD3) — later phases.
- The generalized **branch-isolation probe suite** is Phase 3 (needs operational
  branch data); Phase 1 enforces + tests branch scope on its own endpoints.
  Register-isolation suite is Phase 4.

---

## 2. Enforcement model (inherited by every task)

- **Four independent axes, checked in pipeline order: entitlement · permission ·
  data scope · business rule.** Role is a permission bundle, never an axis. Audit
  is a record, not a gate. **Deny wins.**
- `RequestContext` is **immutable** and populated **only** from the authenticated
  session — never body / param / header / query / subscription string (Phase 0
  lint rule `no-scope-from-request` forbids the anti-pattern; Phase 1 adds the
  runtime).
- **Owner** = `account_type = OWNER` + seeded Owner role + `companyScope = ALL`,
  `branchScope = ALL`. Bounded by entitlement + deny grants + Super Admin
  controls. Cannot hold a PLATFORM role or reach a raw secret. `account_type` is a
  limit bucket, never an authz signal.
- **Normal user** = `branchScope` defaults to exactly the branch they were created
  in. Multi-branch = explicit named grants. Company-level = a branch grant listing
  branches (+ optional per-branch permission overlay).
- **POS terminal** = identity / origin / register / audit only. `pos_terminal_id`
  rides on a session and on audit rows; it is **never** a row filter for
  operational data. Same-branch terminals are not isolated from each other.
- **Branch** = the operational boundary; every operational row carries `branch_id`;
  RLS + the branch guard both check it.
- Data path: `ScopedRepository` → Prisma interactive transaction →
  `SELECT set_config('app.tenant_id', $1, true)` (parameter-bound, UUID-validated)
  → RLS. App DB role `NOSUPERUSER NOBYPASSRLS`; migrations as a separate role; a
  distinct, audited path for legitimate platform cross-tenant reads.
- **Realms** (SECURITY.md): Platform Super Admin and Tenant business users are
  separate, never cross-grantable. Distinct token audience + session namespace +
  user table. Platform MFA mandatory; hardware-MFA / IP-allowlist are enforced
  policy hooks in Phase 1 (config + guard), not a vendor integration.

---

## 3. Task-by-task plan

Fifteen tasks. Each ends with: unit + integration tests green · `security-review`
skill · tenant-isolation check · Conventional-Commit with trailers.

### 1.1 — `packages/db`: Phase 1 schema, RLS, partitioning, migrations

Prisma models (all `text` + CHECK, not PG enums; UUID v7; `created_at/by`,
`updated_at/by`; money as `amount_minor bigint + currency_code +
currency_exponent`; composite indexes lead with `tenant_id`).

- **platform-global (no `tenant_id`, RLS-exempt, documented):** `plan`,
  `plan_version`, `entitlement_default` (plan_version × module → on/off + config),
  `limit_default` (plan_version × limit_key → number), `permission_registry`
  (key, group, version, description — synced from `@flower/permissions`),
  `platform_user`, `platform_role`, `platform_role_permission`,
  `platform_user_role`.
- **tenant:** `tenant` (slug, name, region, status
  `DRAFT|ACTIVE|SUSPENDED|TERMINATED`, plan_version_id), `tenant_entitlement`
  (module → effective on/off + config), `tenant_limit` (limit_key → effective
  number + override + reason + set_by + at).
- **identity:** `user` (tenant_id, account_type `OWNER|USER`, status
  `ACTIVE|DISABLED|LOCKED`, email, phone), `credential` (user_id, kind `PASSWORD`,
  argon2id hash), `mfa_factor` (user_id, kind `TOTP`, secret_ref, confirmed_at,
  status), `set_password_token` (user_id, token_hash, expires_at, used_at) —
  hash at rest (OD3), `session` (id, tenant_id, user_id, account_type,
  pos_terminal_id?, device_id? [null until Phase 2], created_at, last_seen_at,
  expires_at, revoked_at, revoke_reason, mfa_level, ip, ua — **range-partitioned
  on `created_at`**), `refresh_token` (id, session_id, family_id, token_hash,
  created_at, used_at, revoked_at, replaced_by), `login_security_event`
  (tenant_id?, user_id?, kind, ip, ua, at — **partitioned on `at`**).
- **access:** `role` (tenant_id, key, name, is_system, is_active),
  `role_permission` (role_id, permission_key), `user_role` (user_id, role_id),
  `permission_grant` (user_id, permission_key, effect `ALLOW|DENY`, reason,
  granted_by, at), `data_scope_assignment` (user_id, company_ids `uuid[] | ALL`,
  branch_ids `uuid[] | ALL`, per_branch_overlay `jsonb?`).
- **org:** `company` (tenant_id, legal_name_en/ar, cr_number, trn?, reg_address,
  status), `trade_license` (company_id, number, issued_at, expires_at, status),
  `branch` (tenant_id, company_id, name, timezone, weekend_model, status),
  `branch_setting` (branch_id, key, value `jsonb`) — includes
  `registered_device_required` **default `false`, not writable by any Phase 1 API**
  (amendment 1), `pos_terminal` (tenant_id, company_id, branch_id, code, name,
  status).
- **secrets:** `provider_credential` (tenant_id, company_id?, branch_id?, provider,
  mode `TEST|LIVE`, secret_ciphertext `bytea`, secret_nonce `bytea`, dek_wrapped
  `bytea`, non_secret_config `jsonb`, status, version, updated_by, updated_at);
  `tenant_setting` (tenant_id, key, value `jsonb`) — non-secret operational
  settings, never adjacent to a secret.
- **audit / outbox foundation:** `audit_log` (tenant_id?, company_id?, branch_id?,
  pos_terminal_id?, actor_user_id, actor_account_type, impersonator_user_id?,
  action, resource_type, resource_id?, reason?, before `jsonb?`, after `jsonb?`,
  ip, at — append-only, RLS by tenant_id, **partitioned on `at`**); `outbox`
  (id, tenant_id, aggregate_type, aggregate_id, event_type, payload `jsonb`,
  created_at, dispatched_at null — **partitioned on `created_at`**, partial index
  `WHERE dispatched_at IS NULL`).

**RLS.** `ENABLE` + `FORCE ROW LEVEL SECURITY` on every tenant-owned table; policy
`USING (tenant_id = nullif(current_setting('app.tenant_id', true),'')::uuid)` +
matching `WITH CHECK`. A migration creates DB roles `flower_app`
(LOGIN, NOSUPERUSER, NOBYPASSRLS), `flower_migrate` (owns DDL), `flower_platform`
(the audited cross-tenant read path) and their grants.

**Seed.** `prisma/seed.ts` grows: (a) sync `permission_registry` from
`@flower/permissions`; (b) a `Starter` `plan_version` with entitlement + limit
defaults; (c) the 13 system-role templates as provisioning input data — real
permission sets for Owner/Admin/Manager + Phase-1 foundation perms only, the rest
minimal-safe (OD6); (d) one dev-only platform super-admin from env. **No tenant
data in the seed.**

**Done when:** a Testcontainers test migrates a fresh PG and asserts the baseline;
a test enumerates `pg_tables` vs `pg_policies` and fails if any tenant table lacks
`ENABLE + FORCE`; a no-GUC query returns 0 rows (not an error); partition parents
exist; `flower_app` cannot bypass RLS.

### 1.2 — Scoped data access: `RequestContext` + `ScopedRepository` + Prisma extension

- `packages/db`: `createScopedClient(base, { tenantId, branchScope })` — a Prisma
  `$extends` / `runScoped(tx)` helper that runs every scoped op inside
  `prisma.$transaction(async tx => { await tx.$executeRaw\`SELECT set_config('app.tenant_id', ${tenantId}, true)\`; … })`,
UUID-validated, `maxWait`/`timeout` from the ADR-0010 spike, one transaction per
  request for the common path.
- `apps/api/src/common/context`: `RequestContext` (immutable class), an
  `AsyncLocalStorage` store, a Fastify hook + Nest interceptor that populates it
  **after** auth, a `@Ctx()` param decorator.
- `apps/api/src/common/data`: `ScopedRepository<TModel>` base — the only sanctioned
  data path in a domain module; camelCase↔snake_case mapping lives here. The
  Phase 0 `no-raw-prisma-in-scoped-modules` rule enforces usage.
- `PlatformRepository` — the separate, explicitly-audited cross-tenant path.

**Done when:** integration tests prove scoped read isolates; no-GUC → 0 rows; no
GUC bleed across the Fastify request lifecycle under concurrency; a domain module
cannot reach raw Prisma (lint); the platform path emits an audit row on every
cross-tenant read.

### 1.3 — `access` module: the policy engine

- Effective permissions:
  `(∪ role_permission via user_role) ∪ (grant ALLOW) − (grant DENY)`, then
  `∩ entitled-modules`, then per-request `∩ valid-for-target-scope`. **Deny wins**
  at every step. Owner short-circuits scope to `ALL/ALL`.
- Scope resolution: `data_scope_assignment` → `{ companyScope, branchScope,
perBranchOverlay }`.
- `PolicyEngine.can(ctx, permissionKey, target?) → Decision`
  (`ALLOW | DENY:<reason>`) — pure, unit-tested with truth tables.
- Step-up flags on the Phase 1 sensitive keys (`users:manage`, `roles:manage`,
  `settings:tenant:manage`, `settings:branch:manage`, plan/limit/secret admin,
  impersonation).
- Permission-preview API: `POST /v1/access/preview` — given a proposed
  role/grant/scope set, return the resulting effective permissions + a diff vs
  current. Read-only.

**Done when:** the policy truth-table suite is green (role × grant × deny ×
entitlement × scope → expected decision); deny-wins, entitlement filter, and
preview diff proven.

### 1.4 — the guard pipeline (NestJS, in SECURITY.md order)

Global guards / interceptors, ordered, failing closed; list endpoints inject a
scope filter instead of rejecting:

1. `JwtAuthGuard` — verify the short-lived access token (audience = tenant **or**
   platform realm), load the session from Redis; revoked/expired → 401.
   `@Public()` bypasses.
2. `TenantContextInterceptor` — build `RequestContext` from the session claim
   **only**.
3. `AccountStatusGuard` — user `ACTIVE`, session live.
4. **Registered device — documented no-op in Phase 1** (the flag can never be
   true; amendment 1). Full guard lands in Phase 2 with the `devices` module.
5. `EntitlementGuard` — the route's module ∈ `ctx.entitlements`, else 403
   `MODULE_NOT_ENTITLED`.
6. `PermissionGuard` — `@RequirePermission(key)` ∈ `ctx.effectivePermissions`
   (+ step-up check where flagged).
7. `CompanyScopeGuard` — resolve the target `company_id` (service hook /
   `@ScopedParam`); ∈ `ctx.companyScope` or `ALL`.
8. `BranchScopeGuard` — same for `branch_id`. **Primary operational boundary.**
9. `PosScopeGuard` — only on routes decorated `@RequiresPosScope()` (none in
   Phase 1 except session↔terminal binding).
10. Resource-access hook — per-route `canAccess(ctx, resource)` in the service.
11. Business-rules — in the service.
12. Transaction boundary — the service uses `ScopedRepository`.
13. Audit — an `@Audited(...)` interceptor / explicit `AuditWriter` call writes
    the auditable record(s) **inline in the same transaction** (amendment 2).

Bootstrap assertion: every mapped `/v1` route carries `@RequirePermission` **or**
`@Public` resolved metadata (runtime sibling to the Phase 0 lint rule).

**Done when:** an ordered-guard integration harness asserts each stage fails
closed independently and in order; a route missing a decorator fails bootstrap;
list endpoints inject the filter (verified by 1.13).

### 1.5 — `identity` module: authentication + sessions

- `POST /v1/auth/login` — Argon2id verify (params tuned — recorded in an ADR),
  per-user + per-IP brute-force lockout with exponential backoff +
  `login_security_event`, issue access JWT (~10 min; aud, tenant, user, session,
  mfaLevel) + rotating refresh (opaque, hashed at rest, `family_id`) + Redis
  session + `session` DB row. **OD5:** the request carries a workspace slug +
  email.
- **OD1 transport:** the same tokens are delivered as HttpOnly `Secure`
  `SameSite` cookies for owner-web / super-admin-web (with CSRF protection) and as
  a Bearer response for the POS PWA / API clients. Realms isolated.
- MFA (TOTP — OD2): `POST /v1/auth/mfa/enroll` / `/confirm`; login returns
  `MFA_REQUIRED` when a factor is confirmed; `/mfa/verify` completes.
- Step-up: `POST /v1/auth/step-up` → re-assert TOTP → session `mfaLevel = STEP_UP`
  for N minutes.
- `POST /v1/auth/refresh` — rotation: old refresh → `used_at`; a replay →
  **reuse detection**: revoke the whole family + every session in it +
  `login_security_event REFRESH_REUSE` + audit.
- `POST /v1/auth/logout` — revoke this session (Redis del + DB `revoked_at`).
- `DELETE /v1/auth/sessions/:id` — self, or admin (`users:manage`).
- Set-password (OD3): admin generates a single-use, expiring link
  (`set_password_token`, hash at rest); `POST /v1/auth/set-password` consumes it.
- `GET /v1/me` + `GET /v1/me/access` — the "my access" backend.
- Platform realm: `POST /v1/platform/auth/login` — separate audience + session
  namespace, `account_type = PLATFORM`, **mandatory TOTP**, IP-allowlist hook.

**Done when:** auth e2e (login → protected → refresh → rotated → replay →
family revoked); lockout after N fails; revoke ends access < 5 s; a tenant token
is rejected on `/v1/platform/*` and vice-versa.

### 1.6 — `platform` module: plans, entitlements, limits, `LimitService`

- Plan / `plan_version` CRUD (platform realm); entitlement + limit defaults per
  version.
- `EntitlementService.resolve(tenantId)` → effective module set (plan default ±
  tenant overrides), cached in Redis, invalidated on change.
- `LimitService.check(tenantId, limitKey, delta=1)` — enforced on create company /
  branch / pos_terminal / user / owner-user; activate a session (concurrent-
  session caps per user / per POS terminal / per Owner pool). Blocks at the
  boundary with a typed `LIMIT_EXCEEDED` (422) carrying limit + current + max.
  The ten limits from ARCHITECTURE §48.
- Per-tenant override: `PUT /v1/platform/tenants/:id/limits/:key` (reason
  mandatory, audited).

**Done when:** limit-enforcement tests — the (limit+1)th create blocked; an
override lifts it; a concurrent-session cap enforced on login; an entitlement
flip makes a route return 403 `MODULE_NOT_ENTITLED` and drops the associated
permissions.

### 1.7 — `platform` module: tenant provisioning + lifecycle + impersonation

- `POST /v1/platform/tenants` (idempotent on `Idempotency-Key`) → create `tenant`
  (`DRAFT`), attach plan_version, snapshot entitlements + limits, provision in
  **one DB transaction** (amendment 3): seed the 13 system roles from templates,
  link `permission_registry`, create the first `company` + `branch` +
  `pos_terminal`, create the first Owner `user` + a `set_password_token`
  → `ACTIVE`. Multiple `audit_log` rows (one per auditable effect — amendment 2)
  - `outbox` rows, all in the same transaction. **No external call inside the
    transaction**; the set-password link is returned in the API response.
- `POST /tenants/:id/suspend` / `/resume` / `/terminate` — terminate is soft
  (rows retained, legal-hold hook, all sessions ended). Audited.
- Impersonation (OD7 — **read-only**): `POST /v1/platform/tenants/:id/impersonate`
  (platform perm `tenants:impersonate` + step-up) → a time-boxed (≤ 30 min),
  reason-tagged, **read-only** tenant session (the allowlist contains no
  mutations); `impersonator_user_id` stamped on every audit row; a response
  banner flag; a dedicated audit stream (`action` prefixed `IMPERSONATION:`).
  `DELETE …/impersonate` ends it.

**Done when:** provision → the Owner sets a password and logs in, sees `ALL/ALL`,
seeded roles; idempotent; suspend → all sessions dead + login refused; terminate
→ rows retained (no cascade delete); during impersonation **every** mutating call
is rejected and every read is audited with the impersonator; no external effect
fired inside the provisioning transaction (a test asserts the outbox row, not a
sent message).

### 1.8 — `org` module: companies / branches / POS terminals

- CRUD for `company` (+ `trade_license` with expiry), `branch` (+
  `branch_setting`), `pos_terminal` — by Super Admin (platform) **or**
  Owner/authorized admin (tenant, within entitlement + `settings:tenant:manage` /
  `settings:branch:manage` + scope). `registered_device_required` is **not** a
  writable setting in Phase 1 (amendment 1).
- `GET /v1/org/licenses/expiring` — a read (the reminder job is Phase 2
  scheduler).
- Branch `timezone` + `weekend_model` stored (consumed later).

**Done when:** an Owner creates a 2nd branch; a branch-scoped Manager cannot
create a company (403); `LimitService` blocks the (limit+1)th branch; every row is
tenant + company scoped and RLS-covered (probe suite 1.13).

### 1.9 — `access` module: role / grant / scope administration

- `POST /v1/access/roles` (tenant custom roles), `PUT …/roles/:id/permissions`,
  `POST /v1/access/users/:id/roles`, `…/grants` (ALLOW/DENY + reason), `…/scope`
  (company/branch ids or ALL + per-branch overlay). All `roles:manage` /
  `users:manage`, step-up, audited, and routed through the permission-preview
  (the API returns the diff; the client confirms).
- Escalation guard: a tenant admin can never grant a platform role, a permission
  the tenant is not entitled to, or a permission they do not themselves hold.

**Done when:** a Manager+Cashier user resolves to the union; a `DENY` beats an
`ALLOW` from a role; a tenant admin granting a platform role → 403; a scope
change takes effect on the next request.

### 1.10 — `secrets` module (vault shell)

- Writes: platform realm only. `secrets:*` exists **only** in `platform_role`; the
  Phase 0 test asserting no tenant-realm key matches `/secret/i` stays and gets a
  runtime sibling.
- `CryptoProvider.encrypt/decrypt(plaintext, { tenantId })` → dev impl:
  AES-256-GCM, per-tenant DEK wrapped by `SECRETS_MASTER_KEY` (env — OD4). The
  interface must accept a managed-KMS implementation; **production onboarding is
  gated on a non-dev key strategy** (§4).
- Read: decrypted server-side inside the owning module for one call; the API
  returns only masked (`••••4242`) + `non_secret_config`. The pino redaction path
  list is extended; a test asserts a stored secret never appears in a log line.
- Non-secret operational settings → `tenant_setting`, tenant-writable, never
  adjacent to a secret.

**Done when:** a tenant-realm token → 403 on every `secrets` route (and the route
requires a permission no tenant role can hold); encrypt/decrypt round-trips; log
capture contains no plaintext; masking correct.

### 1.11 — Super Admin Web (`apps/super-admin-web`)

Screens (server components + a typed client from the Phase 1 OpenAPI): platform
login (TOTP) · tenant list + lifecycle (create/suspend/resume/terminate) · plan /
plan_version / entitlement / limit editors · per-tenant entitlement + limit
overrides (reason prompt) · tenant users + roles + scope + effective-permission
preview · sessions + revoke · audit viewer (filter by tenant/actor/action/date) ·
impersonation (start with reason → banner → stop, read-only) ·
`provider_credential` management (masked, per tenant/company/branch). Separate
deployment, separate auth realm, HttpOnly cookie (OD1), its own base URL, no
shared session with the tenant apps.

**Done when:** `next build` green; a Playwright smoke covers lifecycle +
role-assign + preview + impersonation against a running api.

### 1.12 — Tenant login + "my access"

`owner-web` + `pos-pwa` gain: a login screen (password + TOTP), token storage
(HttpOnly cookie for owner-web per OD1 / secure storage + Bearer for the PWA), and
a read-only `/me/access` screen — effective permissions grouped, company/branch
scope, plan name, entitled modules.

**Done when:** an Owner logs into owner-web and sees `ALL/ALL` + the seeded Owner
permissions; a branch user sees one branch + a reduced set.

### 1.13 — cross-tenant probe suite v1 (BUILD-BLOCKING)

- Upgrade `@flower/testing` from the Phase 0 skeleton to a real generator: for
  **every mapped non-`@Public` `/v1` route**, a probe as tenant B attempting
  tenant A by id / query param / path param / nested URL → expect 403/404 (no
  existence-leak difference — API-CONVENTIONS).
- RLS-bypass attempts: a raw query with a forged GUC; a query with no GUC → 0
  rows; a platform token on a tenant route and vice-versa; a `DENY`-grant bypass
  attempt; a disabled-module route.
- Route-coverage meta-test: every non-`@Public` route has ≥ 1 probe; a new route
  without one fails the suite.
- Branch-scope checks over the Phase 1 endpoints (org + access): a Sharjah user
  cannot read/mutate a Dubai company/branch; a multi-branch user sees only
  granted branches.
- POS-is-not-a-boundary: a session bound to POS-01 can still read its branch's
  data — assert the **inverse** of the tenant/branch rule.

**Done when:** the suite is green **and** a mutation test proves it bites —
temporarily remove the branch guard from one route → the suite goes red.

### 1.14 — audit + outbox foundation (minimal)

- An explicit **auditable-action registry** (a typed list) — the security /
  business mutations that must produce audit records: tenant
  create/suspend/resume/terminate, plan/limit override, role create + permission
  change, grant/deny, scope change, user create/disable, session revoke,
  impersonation start/stop + every read during impersonation, secret
  create/rotate/access, `provider_credential` change.
- `AuditWriter.record(ctx, {...})` — writes `audit_log` **inline in the request
  transaction** (a rolled-back op leaves no row). One request may produce
  **several** records when it has several auditable effects (amendment 2).
- `OutboxWriter.enqueue(ctx, {...})` — same transaction. **No dispatcher in
  Phase 1**; a test asserts rows accumulate with `dispatched_at` null.
- `security_event` — a read view over `audit_log` (security-relevant actions) +
  `login_security_event`; alerting is Phase 2.

**Done when:** for every action in the registry, the auditable mutation produces
its required record(s), committed atomically; a forced rollback leaves zero
committed audit rows; a multi-effect request (provisioning) produces the expected
**set** of records; the hash chain + dispatcher are explicitly deferred to Phase 2
(documented in an ADR).

### 1.15 — CI / security verification additions

- CI `verify`: + the probe suite (build-blocking), + policy truth-table suite, +
  auth e2e, + limit-enforcement tests, + secret-redaction test.
- CI `security`: + a check that no new tenant-realm permission key matches
  `/secret/i`.
- Run the `security-review` skill against the Phase 1 diff before the tag;
  Critical/High block; propose fixes before merging.

**Done when:** CI green on the Phase 1 branch with the probe suite build-blocking;
`security-review` findings triaged.

### 1.16 — verification pass + `PHASE-1-RESULTS.md` + tag

Full checklist run; `docs/phase-1/PHASE-1-RESULTS.md`; annotated
`phase-1-complete` tag **only** after every hard gate (§4) is genuinely green and
GitHub CI + the final `security-review` are green; push; **STOP** for explicit
owner approval before Phase 2.

---

## 4. Hard gates / risks / open items

### Hard gates — Phase 1 does not complete until all are genuinely green

| G   | Gate                                                                                                                                                                                                                                                                                    |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | Cross-tenant probe suite v1 green, build-blocking, mutation-tested (a removed guard turns it red).                                                                                                                                                                                      |
| G2  | Tenant B cannot read/mutate tenant A by **any** manipulation (id / param / URL / forged GUC / raw query) → 403/404 only.                                                                                                                                                                |
| G3  | Branch scope enforced on Phase 1 endpoints — a Sharjah user cannot touch Dubai org/access rows; a multi-branch user sees only granted branches; list endpoints inject the filter.                                                                                                       |
| G4  | POS is **not** an isolation boundary — a POS-01 session reads all same-branch data (inverse assertion).                                                                                                                                                                                 |
| G5  | Deny-wins + entitlement filter + no privilege escalation proven by the policy truth-table suite.                                                                                                                                                                                        |
| G6  | Session revocation ends access in < 5 s; refresh-reuse revokes the whole family.                                                                                                                                                                                                        |
| G7  | Platform realm ⟂ tenant realm — neither token works on the other's routes; the platform data path is separate + audited.                                                                                                                                                                |
| G8  | Every mapped `/v1` route carries a permission decorator (bootstrap assertion) and has ≥ 1 probe.                                                                                                                                                                                        |
| G9  | Secrets: no tenant-realm path reaches a raw credential; plaintext never in a log; masking correct.                                                                                                                                                                                      |
| G10 | RLS: `ENABLE + FORCE` on every tenant table; app role `NOSUPERUSER NOBYPASSRLS`; a no-GUC query returns 0 rows.                                                                                                                                                                         |
| G11 | `LimitService` blocks at the boundary for every Phase 1 limit.                                                                                                                                                                                                                          |
| G12 | Every auditable mutation (per the §3 task 1.14 registry) produces its required audit record(s), committed atomically with the mutation; a rolled-back mutation leaves no committed success audit record; multi-effect requests legitimately produce multiple records.                   |
| G13 | Impersonation is read-only — every mutating call during an impersonated session is rejected; every read is audited with the impersonator (OD7).                                                                                                                                         |
| G14 | `registered_device_required` cannot be set to `true` by any Phase 1 API; no customer-reachable `NOT_IMPLEMENTED` state (amendment 1).                                                                                                                                                   |
| G15 | No external side effect (email / message / webhook) runs inside a DB transaction; required external effects are outbox rows (amendment 3).                                                                                                                                              |
| G16 | `CryptoProvider` supports a managed-KMS implementation; **production tenant onboarding is blocked while the dev `SECRETS_MASTER_KEY` strategy is the only one wired** (OD4) — documented, and enforced by a startup check that refuses `NODE_ENV=production` with the dev key provider. |
| G17 | GitHub CI (`verify` + `security`) green on the branch; the final `security-review` has no open Critical/High.                                                                                                                                                                           |

### Risks

- **R1 — scoped-txn overhead** (~3 ms/txn in the ADR-0010 spike × many small ops).
  Mitigation: one scoped transaction per request for the common path; measure p95
  on login + provisioning; Kysely fallback remains ADR-0010's escape hatch.
- **R2 — Prisma 7 `$extends` + driver adapter + `set_config` under real
  concurrency** (the spike was functional, not load). Mitigation: a Phase 1
  concurrency test (N parallel requests as different tenants → isolation holds;
  refresh-rotation race → one winner).
- **R3 — a ~9-guard pipeline has subtle ordering / short-circuit bugs.**
  Mitigation: the ordered-guard harness (task 1.4).
- **R4 — permission-registry drift** between `@flower/permissions` and the DB.
  Mitigation: a CI check that they match.
- **R5 — impersonation must stay genuinely read-only** (OD7). Mitigation: a
  deny-by-default allowlist that contains only read operations + a test asserting
  every mutating route is rejected during impersonation.
- **R6 — Super Admin Web is a second realm** → cookie/session isolation bugs.
  Mitigation: distinct cookie name/domain/audience + a test that a tenant cookie
  is inert on super-admin-web.
- **R7 — inline audit couples audit to the business txn** (intended). Mitigation:
  keep `audit_log` writes lean; the heavy fan-out is Phase 2's dispatcher.
- **R8 — Docker VM RAM (3.77 GiB)** — Phase 1 e2e + probe suite + Testcontainers
  is heavier than Phase 0. Mitigation: CI `--concurrency` pinning; one shared
  Testcontainers stack per suite.
- **R9 — the ultra-review Dockerfile findings (F3/F4)** are fixed in the
  remediation; the first real `docker build` in a deploy phase should still be
  watched.

### Open items to settle during Phase 1 (not blocking the start)

- **OI1** — Argon2id cost parameters (record in an ADR after a quick calibration
  on the CI runner).
- **OI2** — exact cookie attributes for OD1 (domain, `SameSite=Lax` vs `Strict`,
  CSRF token delivery) — decide in task 1.5, record in API-CONVENTIONS.
- **OI3** — the concrete Phase-1 permission-key set for Owner/Admin/Manager and
  the foundation perms (OD6) — enumerated in task 1.1's seed, reviewed before 1.9.
- **OI4** — session + step-up TTLs — decide in task 1.5.

---

## 5. Verification matrix

| Area                        | Test kind                     | Asserts                                                                                                                                                  | Gate    |
| --------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- |
| RLS schema                  | integration (Testcontainers)  | every tenant table `ENABLE+FORCE`; `flower_app` `NOSUPERUSER NOBYPASSRLS`; partitions exist                                                              | G10     |
| `ScopedRepository`          | integration                   | scoped read isolates; no-GUC → 0 rows; no bleed across the Fastify request lifecycle                                                                     | G2, G10 |
| Policy engine               | unit truth-table              | role∪grant−deny, deny wins, entitlement filter, scope intersection, step-up flag                                                                         | G5      |
| Guard pipeline              | integration (ordered harness) | each guard fails closed independently + in order; list endpoints inject the filter                                                                       | G8      |
| Auth                        | e2e                           | login→protected→refresh rotate→replay→family revoke; lockout; TOTP; step-up                                                                              | G6      |
| Session revocation          | e2e (timed)                   | revoke → next request 401 in < 5 s; admin revoke of another session                                                                                      | G6      |
| Realm separation            | e2e                           | tenant token on `/v1/platform/*` → 401; platform token on a tenant route → 401                                                                           | G7      |
| Entitlement                 | integration                   | disabled-module route → 403 `MODULE_NOT_ENTITLED`; permission dropped when unentitled                                                                    | G5      |
| `LimitService`              | integration                   | (limit+1)th create blocked; override lifts; concurrent-session cap on login                                                                              | G11     |
| Provisioning                | e2e                           | create tenant → Owner sets password + logs in, `ALL/ALL`, seeded roles; idempotent; **outbox row written, no message sent inside the txn**               | G15     |
| Lifecycle                   | e2e                           | suspend → sessions dead + login refused; terminate → rows retained                                                                                       | —       |
| Impersonation               | e2e                           | time-boxed; impersonator stamped on every audit row; **every mutating call rejected**                                                                    | G13     |
| Registered-device           | integration                   | no Phase 1 API can set `registered_device_required = true`; pipeline step 4 is a no-op                                                                   | G14     |
| Org                         | integration + probe           | branch-scoped user cannot create a company; RLS covers company/branch/terminal                                                                           | G3      |
| RBAC admin                  | integration                   | multi-role union; DENY beats ALLOW; tenant admin cannot grant platform role / unentitled perm                                                            | G5      |
| Secrets                     | integration                   | tenant token → 403 on every secrets route; encrypt/decrypt round-trip; plaintext never logged; masking; **prod refuses the dev key provider**            | G9, G16 |
| Cross-tenant probe v1       | e2e suite (BUILD-BLOCKING)    | every route: tenant B → tenant A by id/param/URL → 403/404; forged-GUC; raw query; realm cross                                                           | G1, G2  |
| Branch scope (P1 endpoints) | e2e                           | Sharjah user → Dubai org/access rows denied; multi-branch → only granted                                                                                 | G3      |
| POS-not-a-boundary          | e2e                           | POS-01 session reads all same-branch data (inverse assertion)                                                                                            | G4      |
| Probe coverage              | meta-test                     | every non-`@Public` route has ≥ 1 probe; a removed guard turns the suite red (mutation)                                                                  | G1, G8  |
| Audit foundation            | integration                   | each registry action → required record(s), committed atomically; rollback → 0 rows; multi-effect request → expected set; outbox row `dispatched_at` null | G12     |
| Redaction                   | unit + integration            | scan captured logs → no secret / password / token substring                                                                                              | G9      |
| Concurrency                 | integration                   | N parallel requests as different tenants → isolation holds; refresh-rotation race → one winner                                                           | G2, R2  |
| Perf smoke                  | integration (informational)   | p95 of login + provisioning + a scoped read within budget; scoped-txn overhead measured                                                                  | R1      |
| CI                          | pipeline                      | `verify` (+ new suites, probe build-blocking) + `security` green on the branch                                                                           | G17     |
| Super Admin Web             | Playwright smoke              | lifecycle + role assign + preview + impersonation flows                                                                                                  | —       |
| `security-review`           | skill                         | no open Critical/High on the Phase 1 diff                                                                                                                | G17     |

---

## 6. Git & rollback

- Branch-per-task `phase-1/1.x-<slug>`; one verified commit per task; Conventional
  Commits; trailers `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` +
  `Claude-Session: <url>`; `main` always green; no force-push, no history rewrite.
- Checkpoint tag `phase-1-complete` only after every hard gate + GitHub CI + the
  final `security-review` are green. **STOP** for owner approval before Phase 2.
- Migrations are forward-only, expand/contract; a failed migration is recovered by
  a forward fix or an expand/contract reverse, never a destructive rollback. The
  probe suite + RLS `FORCE` are the safety net if a scoped path regresses.
