# `security_event` tenant isolation (SE1) — PREPARED, NOT APPLIED

An unapplied remediation package. **Nothing here is a real migration**: `packages/db/prisma/migrations`, `schema.prisma`, the frozen `security_event` migration (`20260904120000`) and `frozen-baseline.ts` are unchanged, and every approval in `PACKAGE.json` is `recorded: false`.

## The finding (measured on real `flower_app` logins — no `SET ROLE` shortcut)

The view `security_event` has no `security_invoker` option, so PostgreSQL runs its underlying-table access as the **view owner**. `audit_log` and `login_security_event` are `FORCE ROW LEVEL SECURITY`, which binds a *non-superuser* owner — but a **superuser owner bypasses RLS entirely**.

| Posture | View owner | `flower_app` sees |
|---|---|---|
| Test harness, and **`infra/staging/docker-compose.staging.yml`** (its `migrate` service connects as `postgres`) | superuser | **every tenant's** security events plus the platform / pre-auth rows that have no tenant — with its own tenant GUC (6 of 9 rows foreign or tenant-less), with **no GUC at all** (all 9, while the very same session reads 0 rows of the tables), and through the real `runScoped` path |
| The posture the migration comments describe for production (`flower_migrate`, NOSUPERUSER NOBYPASSRLS) | non-superuser | only its own tenant; nothing without a GUC |

The tables themselves stay isolated; the view is the only door. It is read-only (not auto-updatable). `flower_app` can read it because the Phase 1 default privileges grant S/I/U/D on every new relation, contradicting the migration's own comment ("the app role never does"). **No production code reads the view as the application role** (the only reader, `audit-read.repository.ts`, runs on the platform client), so this is a database-boundary / defence-in-depth gap, not a live application-level leak — but one SQL-capable defect in the application role would read every tenant.

## The fix — `docs/decisions/proposed-migrations/DRAFT-SE1-security-event-isolation.sql` (3 statements)

1. `ALTER VIEW "security_event" SET (security_invoker = true)` — RLS applies to the *caller*, whoever owns the view. `flower_platform` (BYPASSRLS) still reads every tenant.
2. `REVOKE ALL … FROM PUBLIC, flower_app, flower_platform` and 3. `GRANT SELECT … TO flower_platform` — the platform-only ACL the original comment promised.

Each layer alone closes the measured leak (proved on separate databases); together they are the draft. The view definition, tables, policies and triggers are untouched. PostgreSQL 15+ (`security_invoker`); every environment here runs 17.

**Hazard (measured):** the view has already been `CREATE OR REPLACE`d twice (`20260906120000`, `20260906130000`). A replacement **without a `WITH` clause resets `security_invoker`** (the ACL survives), silently removing layer 1. Any future migration that replaces the view must restate `WITH (security_invoker = true)`; a standing structural pin enforces that for every migration sorting after the candidate.

| File | What it is |
|---|---|
| `migrations/20261205120400_phase_4_security_event_isolation/migration.sql` | the candidate (banner + draft), generated |
| `rollback.sql` | restores the previous — owner-executed, application-readable — state (re-opens the leak where the owner bypasses RLS) |
| `pin-amendments.patch` | the frozen-baseline authorisation of the candidate (name + sha256) and the "newest migration" pin moves, **STACKED after the D/Z1/E1 and AL1 pin patches**; UNAPPLIED |
| `make-pin-amendments.mjs` | regenerates `pin-amendments.patch` (run after the draft or `PACKAGE.json` changes; it only reads the real tree) |
| `PACKAGE.json` | manifest: SHA-256 of every artefact (the patch included), activation flags (all false), approvals (all unticked), separate decisions |

**`pin-amendments.patch` is generated but NOT applied**, and applying it is still the `SE1-PIN-AMENDMENT` approval. It touches only `apps/api/src/verification/` pins (13 "newest migration" pins, the authorised-migrations list and one `frozen-baseline.ts` entry); no schema, no migration, no source module, no fixture. It does not apply to the unpromoted tree (its pre-image holds the promoted and AL1 pins). Apply order at promotion: **D/Z1/E1 migrations + pins → AL1 candidate + pins → this candidate + pins**; the whole stack is rehearsed in an isolated copy with `node docs/decisions/promotion-packages/phase-4-7-audit-registration/rehearse.mjs registered+promoted+hardened+isolated`.

Verified by `packages/db/test/phase4-security-event-isolation.integration.test.ts` (real PostgreSQL 17, real logins, real `prisma migrate deploy`) and `apps/api/src/verification/security-event-isolation-package.structural.test.ts`.
