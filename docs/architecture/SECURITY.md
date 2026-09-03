# Flower SaaS — Security & isolation model

> Architecture §46 + §R.4, expanded. Tenant and branch isolation are enforced at the
> application, query and database levels and verified by an automated probe suite in
> CI. No security claim is made that the architecture cannot enforce.

## Identity realms

Four separate identity realms, never cross-grantable:

1. **Platform Super Admin** — separate deployment (`apps/super-admin-web`), separate
   auth realm, hardware MFA, IP allowlist, dual-control for credential writes,
   break-glass runbook, dedicated audit stream.
2. **Tenant business users** (Owner Web + POS PWA) — one tenant, scoped to
   companies/branches.
3. **Customer identity** (Customer Web) — per-tenant, phone-OTP or account.
4. **Anonymous storefront sessions** — anon-scoped tokens, bound to one tenant
   (resolved from host) and (once chosen) one branch.

## Request pipeline

Every protected request runs, in order, failing **closed** at each step (list
endpoints inject a scope filter instead of rejecting):

1. **Authentication** — validate the short-lived access token; load the server-side
   session (Redis). Revoked session → 401 within seconds.
2. **Tenant** — from the session claim **only**. Never from a body / param / header
   / query / subscription string.
3. **Account / session / device status** — user ACTIVE, session live, device not
   revoked.
4. **Registered device** — where `registered_device_required`, verify the device
   signature (challenge/response, WebCrypto keypair).
5. **Entitlement** — the target feature module is enabled for the tenant's plan.
6. **Role** — the user holds a role (or direct grant) touching the permission.
7. **Permission** — the resolved effective permission set
   (∪ roles ∪ grants − denies, deny wins) contains the route's declared key.
8. **Company scope** — the resource's `company_id` ∈ the user's company grants (or
   ALL).
9. **Branch scope** — the resource's `branch_id` ∈ the user's branch grants (or
   ALL). **Branch is the operational boundary.**
10. **POS scope** — only where the feature genuinely needs it (cash session, device
    binding).
11. **Resource access** — ownership / relationship check on the specific row.
12. **Business rules** — domain invariants (credit limit, period lock, margin
    floor, reservation availability…).
13. **DB transaction** — `SET LOCAL app.tenant_id = <session tenant>` issued inside
    the transaction; all queries run under RLS.
14. **Audit** — the effect + an `outbox` row commit together; `audit_log` written
    via the dispatcher.

## Isolation layers

| Layer                                | Mechanism                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Application**                      | `tenant_id` / `branch_id` flow only from the authenticated session into an immutable `RequestContext`. Reading a scope value from a request body / param / header / query / realtime subscription string is a **banned pattern** — ESLint rule + a probe test.                 |
| **Query**                            | Scoped reads/writes go through `ScopedRepository`, which injects the tenant + branch filter. **Raw Prisma / model access is ESLint-forbidden in scoped modules** (`no-raw-prisma-in-scoped-modules`).                                                                          |
| **Database**                         | RLS on **every** tenant-owned table: `USING (tenant_id = current_setting('app.tenant_id')::uuid)`. The app connects as a **non-superuser, non-BYPASSRLS** role. Platform operations use a separate, explicitly audited connection/path.                                        |
| **Realtime**                         | Topic membership re-checks tenant + branch scope on **every** subscribe and on every token refresh. Topics are server-derived from the session; a client cannot request an arbitrary topic string. Session revocation → Redis pub/sub → all gateway instances drop the socket. |
| **Probe suite (CI, build-blocking)** | For every endpoint: authenticate as tenant B / branch Y and attempt to read or mutate tenant A / branch X resources by id, param, URL and document id → expect 403/404. Any leak fails the build.                                                                              |

## RLS + connection pooling (Z-5 / ADR-0010)

Prisma is the default ORM. `SET LOCAL app.tenant_id` is transaction-scoped, which is
**incompatible with statement-level pooling** but safe with **transaction-level and
session-level pooling** as long as every scoped query runs inside an interactive
transaction that sets the GUC first. The **Phase 0 RLS spike** (`tooling/spikes/rls`,
Task 0.6) verifies this against real PgBouncer in both `transaction` and `session`
pool modes and writes the go / go+Kysely-fallback verdict into
[`../decisions/ADR-0010.md`](../decisions/ADR-0010.md). If the spike fails, a
Kysely fallback for scope-critical reads is appended as a Phase 0 task and completed
before `phase-0-complete`.

RLS is a **backstop**, not the primary control — the application layer is the
primary control. RLS catches a missed `ScopedRepository` call; the probe suite
catches a missed RLS policy.

## Audit

- Append-only `audit_log`, **per-tenant hash chain** (each entry links `prev_hash`).
  Fields: tenant, company, branch, POS, authenticated user, selected staff,
  approver, device/session, action, resource, timestamp, reason, before/after where
  useful. A scheduled tamper-evidence job re-verifies the chain.
- **Especially audited**: refunds, voids, discounts, credit, advances, payments,
  stock changes, reservations, material consumption, wastage/spoilage, purchase
  changes, staff attribution changes, attendance corrections, leave decisions,
  role/permission changes, integration configuration, device activation, tenant/plan
  changes, secret access.
- `security_event` stream: failed logins, new device, scope changes, secret access,
  impersonation, mass export — feeds monitoring alerts.

## Secrets (Super-Admin-only — strict)

Only Platform Super Admin can create, view, edit, rotate or revoke a raw external
API credential. The capability **does not exist** in the tenant realm — there is no
tenant-side permission key. `provider_credential` rows: KMS envelope encryption
(per-tenant DEK), decrypted server-side inside the owning module for one call,
masked in every UI (`••••4242`), **never logged** (redaction filter + tests),
versioned for rotation, revocable. Tenant users manage only non-secret operational
settings, in separate columns/rows never adjacent to a secret.

## Auth primitives

- **Password hashing**: Argon2id.
- **Sessions**: short-lived access token (minutes) + server-side session record
  (Redis) → revocation in seconds. Rotating refresh token with **reuse detection**
  (a replayed refresh token invalidates the whole family).
- **Step-up MFA** for money, permission, secret and attribution-change actions.
- **Registered POS device**: non-extractable ECDSA/Ed25519 keypair (WebCrypto);
  challenge/response (DPoP-style proof) on login/refresh; the session is bound to
  `device_id` + terminal.
- Strict CSP + secure headers; DTO input validation + **output allowlist**
  serialization; per-tenant + per-IP rate limiting; brute-force lockout; webhook
  signature + timestamp/replay verification.

## AI security (§R.8)

Fixed tool allowlist; tenant + branch + customer context bound **server-side** from
the conversation, never from model output; value caps; explicit customer
confirmation (stored verbatim) before `createOrder` / `createPaymentLink`;
payment-before-fulfilment by default; no tool returns secrets or cross-tenant rows;
every tool call audited; per-conversation / per-customer / per-tenant rate + token
caps. Prompt-injection defenses: structured tool I/O only, system-prompt isolation,
tool inputs validated as hostile, model outputs treated as data. A red-team suite
runs in CI (Phase 9).

## Backup & recovery

PostgreSQL: daily base backup + continuous WAL archiving → PITR; target RPO ≤ 5 min,
RTO ≤ 1–2 h; scheduled restore drills verified by row counts + a smoke test. Object
storage: versioning + lifecycle + cross-region replication; immutable backup for
fiscal documents (GCC retention 5+ years). Tenant-level export (portability) and
hard-delete (offboarding) with legal-hold override for financial records.

## PWA honesty (§R.6)

A browser cannot read MAC addresses or reliably fingerprint hardware — device
identity is a server-issued credential + non-extractable key, strong against
credential copying but not a fully compromised OS. iOS installed-PWA background push
is unreliable. Browser storage can be evicted → re-activation flow handles it. These
limits are stated, not hidden.
