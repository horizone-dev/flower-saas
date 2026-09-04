# Phase 1 — Results

> Written at Task 1.16. Records what was built, the verification output, the
> hard-gate evidence, the security-review outcome, and the deferrals carried to
> Phase 2. Companion to [`PHASE-1-PLAN.md`](PHASE-1-PLAN.md).
>
> Date: 2026-09-04 · Executor: Claude Sonnet 5 (Claude Code) · Approved plan:
> `PHASE-1-PLAN.md` (§0 locked decisions OD1–OD8 + amendments 1–3).

---

## 1. What was built

The **isolation backbone** — five modules under `apps/api/src/modules/` plus the
request enforcement pipeline, four thin web surfaces, and the audit foundation.

| Task | Commit                                  | Summary                                                                                                                                                                                                                                                                                         |
| ---- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1.1  | `36501b6`                               | Phase 1 schema — 37 models, `uuidv7()`, range-partitioned `audit_log`/`outbox`, extensible-enum CHECKs, 3 DB roles, RLS ENABLE+FORCE on every tenant table + the `tenant` root (keys on `id`).                                                                                                  |
| 1.2  | `d650122`                               | Scoped data access — immutable `RequestContext` in an ALS holder, `runScoped` (SET LOCAL ROLE `flower_app` + `set_config('app.tenant_id')`), `runPlatform` (`flower_platform`, BYPASSRLS), `no-raw-prisma-in-scoped-modules` lint.                                                              |
| 1.3  | `520ddca`                               | Pure `PolicyEngine` (entitlement → permission + step-up → company scope → branch scope), `resolveEffectivePermissions` (∪ roles ∪ ALLOW − DENY, deny wins, ∩ entitlement), permission-preview.                                                                                                  |
| 1.4  | `2535e16`                               | `AuthGuard` + `PermissionGuard` (`APP_GUARD`), `@RequirePermission` / `@Public` / `@PlatformRealm` / `@ScopedParam`; `assertEveryRouteDeclaresIntent` bootstrap gate (G8).                                                                                                                      |
| 1.5  | `d02e269`                               | Auth + sessions (ADR-0015) — `jose` HS256 realm-scoped tokens, `@node-rs/argon2`, `otplib` TOTP, Redis sessions, rotating refresh tokens with family-reuse revocation, brute-force limits, `/v1/me`.                                                                                            |
| 1.6  | `d795695`                               | Plans / plan-versions / entitlements / limits — `LimitService` (10 numeric plan limits at the boundary), `EntitlementService` (Redis-cached, invalidated on change).                                                                                                                            |
| 1.7  | `b5789d5`                               | Tenant provisioning (one transaction: 13 system roles, org, first Owner, set-password token → ACTIVE), lifecycle (suspend/resume/terminate — sessions killed), **read-only** impersonation (OD7).                                                                                               |
| 1.8  | `d80984e`                               | `org` — companies / trade licenses / branches / branch settings / POS terminals; every create limit-guarded + scope-checked + audited; `registered_device_required` unsettable (amendment 1).                                                                                                   |
| 1.9  | `14b030e`                               | `access` admin — role / grant / scope CRUD, escalation guard, permission-preview, `SessionAccessRefresher` (a change takes effect on the next request, no logout).                                                                                                                              |
| 1.10 | `1e03369`                               | `secrets` vault shell — platform-realm-only `provider_credential`; `CryptoProvider` (dev AES-256-GCM envelope, `tenantId` as AAD); prod refuses `SECRETS_PROVIDER=dev` (G16); masked reads; pino `REDACT_PATHS`.                                                                                |
| 1.11 | `5b287ba` `b523a8f` `c046dc9` `ff983b8` | Super Admin Web — platform tenant-admin API (list/detail/audit/sessions + **read-and-write** tenant RBAC per the OD7 clarification), hand-typed `@flower/api-client` platform surface, the Next.js MVP (HttpOnly cookie, Server Actions), and a build-blocking Playwright smoke (`e2e` CI job). |
| 1.12 | `3339a75`                               | Tenant login + read-only "my access" — owner-web (cookie, OD1), pos-pwa (Bearer in `localStorage`, OD1); api `enableCors` for browser Bearer origins; `tenantLogin` / `verifyMfa` / `meAccess`.                                                                                                 |
| 1.13 | `2011c15`                               | Cross-tenant / cross-realm / cross-branch probe suite (build-blocking, mutation-tested). Caught + fixed two FK-crosses-RLS gaps in `OrgRepository`.                                                                                                                                             |
| 1.14 | `3988a17`                               | Audit + outbox foundation — `AUDITABLE_ACTIONS` registry, `OutboxWriter`, `ImpersonationReadInterceptor`, audit wired into limit/entitlement overrides + session revoke, `security_event` view + endpoint. ADR-0016 defers the hash chain + dispatcher to Phase 2.                              |
| 1.15 | `b99e53b`                               | CI additions — `security` gate `check-no-tenant-secret-key`; `verify` fast security-invariant pre-flight + a manifest of the build-blocking security gates.                                                                                                                                     |
| 1.16 | _this commit_                           | G4 POS-not-a-boundary probe; this results doc; `phase-1-complete` tag.                                                                                                                                                                                                                          |

**OD7 correction (owner, 2026-09-04):** the read-only rule applies **only to an
active impersonation session**, not to normal Platform Super Admin operations. A
Super Admin can manage a tenant's users / roles / grants / scopes through
`PlatformTenantAccessController` — with the platform permission, step-up,
entitlement validation, no privilege escalation, and full PLATFORM-actor audit.
During impersonation, mutation attempts fail (the impersonation token is
tenant-realm → rejected by `AuthGuard` on every `@PlatformRealm` route).

---

## 2. Verification output

Local (`main` @ this commit):

| Check                                                                                  | Result                                                                                                                                                                  |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm -w typecheck`                                                                    | 30/30 tasks ✅                                                                                                                                                          |
| `pnpm -w lint` (boundaries + no-raw-prisma + route-permission + no-scope-from-request) | 31/31 ✅                                                                                                                                                                |
| `pnpm -w build` (every app + package)                                                  | 20/20 ✅                                                                                                                                                                |
| `pnpm turbo run test`                                                                  | 30/30 tasks ✅ — `@flower/api` **17 files / 128 tests**, `@flower/db` 19 (Testcontainers + RLS + roles), `@flower/testing` 13, `@flower/permissions` 15, `spike-rls` 21 |
| Super Admin Web e2e smoke (`pnpm --filter @flower/super-admin-web test:e2e`)           | ✅ — login (TOTP) → provision → lifecycle → role create + assign → preview → impersonation (banner + mutation blocked) → provider credential (masked)                   |
| `check-no-tenant-secret-key`                                                           | ✅ — 106 tenant keys, secret custody platform-only                                                                                                                      |
| local gitleaks (`.gitleaks.toml`)                                                      | ✅ no leaks                                                                                                                                                             |

GitHub CI: `verify` ✅ · `security` ✅ · `e2e` ✅ on the final commit (run linked
in the CI-status note added on push).

---

## 3. Hard gates (§4 of the plan)

| G   | Status | Evidence                                                                                                                                                                                                                                                                                                                                                |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | ✅     | `apps/api/src/probes/cross-tenant.probe.test.ts` — build-blocking in `verify`; the "teeth" test + the two isolation gaps it caught in 1.13 prove it bites.                                                                                                                                                                                              |
| G2  | ✅     | Probe suite `tenant axis` (by id / nested URL) + RLS-injection test (a `tenantId` in the body is ignored). `@flower/db` `migration.test.ts` — a no-GUC query returns 0 rows; `flower_app` cannot bypass RLS.                                                                                                                                            |
| G3  | ✅     | Probe suite `branch axis` (A1-scoped user → branch A2 = 404); `org.integration.test.ts` (branch-scoped Manager blocked). Phase-1 `org` list endpoints require `settings:tenant:manage` (tenant-wide) — no per-branch list to filter yet.                                                                                                                |
| G4  | ✅     | Probe suite — a POS-bound session reads its branch identically to the same-branch non-POS session, and the terminal id confers no cross-branch reach. `PolicyEngine` / `runScoped` never reference `posTerminalId`.                                                                                                                                     |
| G5  | ✅     | `policy-engine.test.ts` (9) + `policy.service.test.ts` (7) — deny-wins, entitlement filter, scope. `access.integration.test.ts` — DENY beats role ALLOW; `platform-tenant-admin.integration.test.ts` — platform-realm key refused (`PERMISSION_NOT_GRANTABLE`).                                                                                         |
| G6  | ✅     | `auth.integration.test.ts` — refresh rotation + replaying a used token revokes the family (`REFRESH_REUSED` 401). `provisioning.integration.test.ts` — suspend → `GET /me` 401 immediately (Redis tombstone).                                                                                                                                           |
| G7  | ✅     | Probe suite `realm axis` — a tenant token denied on **every enumerated** `@PlatformRealm` route; a platform token denied on tenant routes. The platform path is `flower_platform` (BYPASSRLS) + audited.                                                                                                                                                |
| G8  | ✅     | `assertEveryRouteDeclaresIntent` (bootstrap, called from `main.ts`) + `flower/route-must-declare-permission` lint. Probe-suite coverage test — every non-`@Public` route is probed or on a documented safe list.                                                                                                                                        |
| G9  | ✅     | `secrets.integration.test.ts` — a tenant token can't reach the routes (401/403); no tenant permission matches `/secret/i`; reads return only `••••4242` + `non_secret_config`; a pino line built from `REDACT_PATHS` never contains the plaintext; blobs round-trip and reject a wrong-tenant AAD.                                                      |
| G10 | ✅     | `migration.test.ts` — `ENABLE + FORCE` on every tenant table; `flower_app` is `NOSUPERUSER NOBYPASSRLS`; a bare query with no `app.tenant_id` returns 0 rows (fails closed, no error).                                                                                                                                                                  |
| G11 | ✅     | `platform.integration.test.ts` — `LimitService` blocks the (limit+1)th create + an override lifts it. `org.integration.test.ts` — 3rd branch → 422 `LIMIT_EXCEEDED`. `LimitService.assertWithin` covers `max_companies` / `max_branches` / `max_pos_terminals` / `max_users` / `max_owner_users`; `assertSessionWithin` covers `max_sessions_per_user`. |
| G12 | ✅     | `audit-foundation.integration.test.ts` — provisioning produces the documented audit set + one undispatched outbox row; a unique-key collision rolls back leaving exactly one `role.created`; overrides + suspend + session revoke are audited. `AuditWriter.record` accepts only registered `AUDITABLE_ACTIONS`.                                        |
| G13 | ✅     | `platform-tenant-admin.integration.test.ts` — during impersonation a platform RBAC mutation is rejected. `audit-foundation.integration.test.ts` — one `IMPERSONATION:read` per request during impersonation, carrying the impersonator, + `IMPERSONATION:ended`.                                                                                        |
| G14 | ✅     | `org.integration.test.ts` — `registered_device_required` is absent from the branch-settings key enum; a request naming it 400s. No customer-reachable `NOT_IMPLEMENTED` state.                                                                                                                                                                          |
| G15 | ✅     | Provisioning writes an `outbox` row (`dispatchedAt` null) instead of sending anything (`audit-foundation.integration.test.ts` asserts it). No email / message / webhook code exists in Phase 1.                                                                                                                                                         |
| G16 | ✅     | `env.test.ts` — `loadConfig` throws in production for `SECRETS_PROVIDER=dev` or the dev master-key default. `secrets.module.ts` factory — the `kms` provider slot exists (throws "not wired yet"); `CryptoProvider` is the swap point. ADR-0016 / OD4.                                                                                                  |
| G17 | ✅     | GitHub CI `verify` + `security` + `e2e` green on the final commit. The Phase 1 `security-review` (§4) found **no Critical/High**.                                                                                                                                                                                                                       |

---

## 4. Security review

A security-focused review of the Phase 1 diff (`phase-0-complete..HEAD`) was
performed against the categories in the `security-review` skill (input
validation / SQLi, auth & authz, crypto & secrets, injection, data exposure).

**Result: no HIGH or MEDIUM findings.** Items specifically cleared:

- **`$queryRawUnsafe` in `securityEvents()`** — the query string contains only
  `$1` / `$2` placeholders; `tenantId` (zod-validated UUID) and `limit` (zod
  int, re-clamped) are passed as **bound parameters**. Not injectable.
- **Platform → tenant RBAC** — the escalation guard still enforces
  seeded-TENANT-realm-key + entitled-module + reserved-prefix; a platform admin
  cannot inject a `platform:*` key into a tenant role. Impersonation stays
  read-only via realm separation.
- **`DevCryptoProvider`** — AES-256-GCM, CSPRNG nonces + per-secret DEKs (no
  reuse), `tenantId` AAD on both layers; refused in production.
- **CORS** — exact-match allowlist, `credentials: false`.
- **`ImpersonationReadInterceptor`** — writes via parameterized Prisma; no sink.

**LOW (deferred, not fixed):** the owner-web / super-admin-web session cookies
are `HttpOnly` + `Secure` (prod) + `SameSite=Lax` but carry **no explicit CSRF
token**. State-changing calls go exclusively through Next.js Server Actions,
which enforce an Origin/Host check; combined with `SameSite=Lax` this blocks
cross-site forgery of those POSTs. An explicit double-submit / `__Host-` token
is recorded here as a hardening item for the auth phase (OI2).

---

## 5. Deferred to Phase 2 (explicit)

> **Post-`phase-1-complete` update (2026-09-04):** a focused auth-hardening
> remediation landed on `main` after the tag —
> [`POST-1-AUTH-HARDENING.md`](POST-1-AUTH-HARDENING.md). It removed the POS PWA's
> JS-readable refresh-token storage (in-memory access token + `HttpOnly` refresh
> cookie + `X-Auth-Transport` CSRF control) and added a production CORS-origin
> guard. The `phase-1-complete` tag is unchanged. Rows marked ✎ below are updated
> by that work.

| Item                                                                                         | Where recorded                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Realtime sequence / gap-fill semantics (F8 / F9 from the Phase 0 ultra-review)               | `docs/phase-2/REALTIME-PROTOCOL-INPUTS.md`                                                                                                                                                                            |
| `audit_log` hash chain (tamper-evidence)                                                     | ADR-0016                                                                                                                                                                                                              |
| Outbox dispatcher (SKIP LOCKED fan-out → bus / BullMQ / Redis Streams / reporting)           | ADR-0016                                                                                                                                                                                                              |
| General-ledger postings (`journal_entry`)                                                    | ADR-0016 (begins Phase 5)                                                                                                                                                                                             |
| WebAuthn / passkeys (second factor)                                                          | OD2 — architecture kept ready                                                                                                                                                                                         |
| Self-service email password reset                                                            | OD3 — waits for the notifications phase                                                                                                                                                                               |
| Managed-KMS `CryptoProvider`                                                                 | OD4 / G16 — required before KSA / production onboarding                                                                                                                                                               |
| Host / custom-domain login resolution                                                        | OD5 — Phase 7                                                                                                                                                                                                         |
| Registered-device enforcement (pipeline step 4 is a documented no-op)                        | amendment 1 — Phase 2 devices module                                                                                                                                                                                  |
| Explicit CSRF token for the cookie realms (owner-web / super-admin-web)                      | OI2 — ✎ reviewed in `POST-1-AUTH-HARDENING.md` §E; still deferred (Server Action Origin check + `SameSite=Lax` is adequate). The POS PWA cookie-refresh path now carries an explicit `X-Auth-Transport` CSRF control. |
| Per-tenant `LimitService` coverage test for all 10 limits (representative subset tested now) | Phase 1 follow-up / hardening                                                                                                                                                                                         |

---

## 6. Tag

`phase-1-complete` — annotated tag at this commit, pushed after CI + the
security review were green. **Phase 2 does not begin without explicit owner
approval** (PHASE-1-PLAN §3.16 / CLAUDE.md rule 40).

`phase-0-complete` (`c1ca217`) is untouched.
