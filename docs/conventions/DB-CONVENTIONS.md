# Database conventions

> PostgreSQL 17. Prisma Migrate (ADR-0010). Schema lives in
> `packages/db/prisma/schema.prisma` (from Phase 1).

## Identity & ownership columns

- **Primary keys: UUID v7** (`id uuid PRIMARY KEY DEFAULT uuidv7()`). Time-ordered
  → index-friendly, non-enumerable. Postgres 17 has no built-in generator, so the
  first Phase 1 migration creates a pure-SQL `uuidv7()` (ADR-0014); revisit when
  the deployment target reaches PG 18.
- **`tenant_id uuid NOT NULL`** on every tenant-owned table.
- **`company_id uuid`** and **`branch_id uuid`** on operational tables (NOT NULL
  where the row is inherently branch-scoped).
- Audit columns on every table: `created_at timestamptz NOT NULL DEFAULT now()`,
  `created_by uuid`, `updated_at timestamptz`, `updated_by uuid`.

## RLS (ADR-0004 / SECURITY.md)

- **Every tenant-owned table** has RLS enabled with:
  `USING (tenant_id = current_setting('app.tenant_id')::uuid)` and a matching
  `WITH CHECK`. Branch-scoped read paths additionally filter on
  `current_setting('app.branch_id', true)` where the session is single-branch.
- The **application role is non-superuser and non-`BYPASSRLS`**. Migrations run as a
  separate role.
- Reference/lookup tables that are genuinely global (currencies, country tax
  templates) are exempt and documented as such.
- **Phase 1 roles (ADR-0014):** `flower_app` (NOSUPERUSER NOBYPASSRLS — every
  tenant request; no privilege on the `platform_*` tables), `flower_platform`
  (BYPASSRLS — the one audited cross-tenant path, used only by `PlatformRepository`),
  `flower_migrate` (DDL). Policy shape:
  `USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)`
  with a matching `WITH CHECK`; `tenant` itself keys on `id`.
- **RLS-exempt in Phase 1:** `plan`, `plan_version`, `entitlement_default`,
  `limit_default`, `permission_registry`, all `platform_*` tables, `app_meta`.

## Types

- **Money**: `amount_minor bigint NOT NULL`, `currency_code text NOT NULL`,
  `currency_exponent smallint NOT NULL`. Never `float`/`double`. `numeric` only in
  derived reporting columns.
- **Quantities**: `numeric(18,4)` in the item's base UOM.
- **Extensible enumerations** (status, kind, reason, channel, doc_type): `text` +
  a CHECK against a reference table or a documented allow-list — **not** a PG
  `enum` (adding a value to a PG enum is a migration hazard).
- **Timestamps**: `timestamptz`, always UTC. Local/scheduled times store an IANA
  `timezone` alongside.
- Booleans are `boolean NOT NULL DEFAULT ...` — no nullable booleans.

## Indexing

- Composite indexes **lead with `tenant_id`**, then `branch_id`, then the query key.
- **Partial indexes** for queue-style reads: open reservations, pending online
  orders, unresolved exceptions, `outbox` where `dispatched_at IS NULL`.
- `pg_trgm` GIN indexes for product / customer name search.
- Every foreign key is indexed.

## Partitioning (from migration #1)

Range-partition on `created_at` (or hash on a tenant bucket for the largest):
`order`, `order_line`, `payment_event`, `inventory_movement`, `stock_reservation`,
`journal_entry`, `journal_line`, `cash_movement`, `attendance_event`, `audit_log`,
`ai_message`, `notification_log`, `outbox`, `idempotency_key`.

## Ledger & invariant constraints

- `journal_entry`: a trigger/constraint enforces `SUM(debit_minor) =
SUM(credit_minor)` per entry; `UNIQUE (source_kind, source_id)`.
- `z_report`: `UNIQUE (cash_register_id, z_number)`; `z_number` gapless (allocated
  by the numbering service inside the close transaction); `prev_hash` chains.
- `inventory_movement`: `UNIQUE (idempotency_key)` per scope.
- Gapless business numbers (invoice, Z, GRN) come from a **numbering service** that
  allocates **inside** the business transaction — never `MAX(n)+1` in app code.

## Migrations

- **Forward-only. Expand/contract**: add nullable → backfill job → enforce NOT NULL
  / add constraint → (later) drop. No destructive change without a backup
  checkpoint.
- Every migration is reviewed, has a description, and is tested on a prod-like
  volume before staging.
- No data migration logic in app startup — a migration or an explicit job.
- `packages/db` ships a Testcontainers test that migrates a fresh PG and asserts the
  expected schema baseline (Phase 0 Task 0.5).

## Locking & concurrency

- Stock: `SELECT … FOR UPDATE` on the `branch_inventory_balance` row, or
  `pg_advisory_xact_lock(hashtext(branch_id || ':' || item_id))` for multi-item
  (BOM) writes — consistent lock order.
- `FOR UPDATE SKIP LOCKED` for the outbox dispatcher and job pickup.
- Optimistic `version` columns on Order and BranchInventoryBalance.
