import {
  PHASE_1_TENANT_PERMISSIONS,
  PHASE_3_2_TENANT_PERMISSIONS,
  PHASE_3_4_TENANT_PERMISSIONS,
  PHASE_3_5_TENANT_PERMISSIONS,
  PHASE_3_7_TENANT_PERMISSIONS,
  PHASE_3_8_TENANT_PERMISSIONS,
  PHASE_3B_1_TENANT_PERMISSIONS,
  PHASE_3B_2_TENANT_PERMISSIONS,
  PHASE_3B_5_TENANT_PERMISSIONS,
  PHASE_3B_6_TENANT_PERMISSIONS,
  PHASE_3B_7_TENANT_PERMISSIONS,
  PHASE_3B_8_TENANT_PERMISSIONS,
  PHASE_3B_8_CHECKPOINT_C_TENANT_PERMISSIONS,
} from '@flower/permissions';

/**
 * The 13 system role templates seeded into every tenant at provisioning
 * (ARCHITECTURE §9). OD6 — least privilege: real permission sets for
 * Owner / Admin / Manager and the Phase-1 foundation keys only; every other
 * future-domain role starts with a minimal safe set and is fleshed out when its
 * domain lands. `PHASE_1_TENANT_PERMISSIONS` is the full enforced set today:
 * users:view, users:manage, roles:manage, audit:view, settings:branch:manage,
 * settings:tenant:manage.
 *
 * Phase 3 task 3.2 (owner R-1): `owner` + `admin` gain `catalog:view` +
 * `catalog:manage`; `manager` gains `catalog:view` only. Existing tenants get
 * the identical backfill in the task 3.2 migration.
 *
 * Phase 3 task 3.4 (owner L-17): `owner` + `admin` also gain the ALREADY-RESERVED
 * `variants:manage`; `manager` does NOT (mirrors `catalog:manage`). Existing
 * tenants get the identical backfill in the task 3.4 migration.
 *
 * Phase 3 task 3.5 (owner "PERMISSIONS"): `owner` + `admin` also gain the
 * ALREADY-RESERVED `identifiers:manage`; `manager` does NOT (mirrors
 * `catalog:manage` / `variants:manage`). Existing tenants get the identical
 * backfill in the task 3.5 migration. The key stays in its `inventory` group.
 *
 * Phase 3 task 3.7 (owner "PERMISSIONS"): `owner` + `admin` also gain the
 * ALREADY-RESERVED `pricing:manage`; `manager` does NOT (mirrors
 * `catalog:manage` / `variants:manage` / `identifiers:manage`). Existing tenants
 * get the identical backfill in the task 3.7 migration. Not step-up (D-9).
 *
 * Phase 3 task 3.8 (owner BD-12): `owner` + `admin` also gain the ALREADY-RESERVED
 * `branch_price:manage`; `manager` does NOT by default (mirrors the keys above).
 * Existing tenants get the identical backfill in the task 3.8 migration. Not
 * step-up. Gates BOTH branch-price writes and branch-availability writes.
 *
 * Phase 3b task 3b.1 (docs/phase-3/PHASE-3B-PLAN.md §E): `owner` + `admin`
 * gain `accounting:view` + `accounting:manage`; `owner` ALONE also gains
 * `accounting:period:manage` (Owner-tier only — no tenant "Super Admin" role
 * is invented; `manager` gets neither). Existing tenants get the identical
 * backfill in the task 3b.1 migration.
 *
 * Phase 3b task 3b.2 (docs/phase-3/PHASE-3B-PLAN.md §E, owner-frozen role
 * matrix): `owner` gains all 4 `customers:*` keys; `admin` gains
 * `customers:view` + `customers:manage` + `customers:credit:manage` (NOT
 * `customers:credit:override` — Owner-tier only, mirrors
 * `accounting:period:manage`'s precedent); `manager`/`cashier`/`sales` each
 * gain `customers:view` + `customers:manage` only (customer lookup AND
 * on-the-spot creation are realistic POS-floor needs; credit configuration
 * stays restricted to Owner/Admin). All other roles get nothing. Existing
 * tenants get the identical backfill in the task 3b.2 migration.
 *
 * Phase 3b task 3b.5 (docs/phase-3/PHASE-3B-PLAN.md §E, owner-frozen
 * matrix): `owner`/`admin`/`manager`/`cashier`/`sales` ALL gain both
 * `payments:view` + `payments:collect` — collecting a routine sale payment
 * is a normal POS-floor action, mirroring the `orders:*` precedent, not the
 * Owner/Admin-only `accounting:*`/`customers:credit:*` precedent. No other
 * role gets either key. Existing tenants get the identical backfill in the
 * task 3b.5 migration.
 *
 * Task 3b.6 (docs/decisions/ADR-0019.md, owner-frozen matrix): `owner`/
 * `admin`/`manager`/`cashier`/`sales` ALL gain `receivables:view` +
 * `receivables:collect`; `owner`/`admin`/`manager` additionally gain
 * `receivables:advance:apply` (cashier/sales do not — applying a customer's
 * Advance is not a routine sale-floor action); `owner`/`admin` ALONE also
 * gain `receivables:opening_balance:manage` (mirrors
 * `customers:credit:override`'s Owner/Admin-narrower precedent — fabricating
 * a financial balance from nothing is not a Manager-tier action). Existing
 * tenants get the identical backfill in the task 3b.6 permissions migration.
 *
 * Task 3b.7 Checkpoint C (owner-frozen matrix): `owner`/`admin`/`accountant`
 * gain all 3 `settlements:*` keys; `manager` gains `settlements:view`+
 * `settlements:manage` only (NOT `settlements:finalize` — mirrors
 * `accounting:period:manage`'s Owner/Admin-narrower precedent);
 * `cashier`/`sales` gain neither — settlement reconciliation is a
 * back-office function, not a POS-floor action. This is the FIRST real
 * permission grant to the `accountant` system role (previously `users:view`
 * only). Existing tenants get the identical backfill in the task 3b.7
 * permissions migration.
 *
 * Task 3b.8 Checkpoint C (owner decision, Checkpoint C blocker-resolution
 * gate): `owner`/`admin`/`accountant`/`manager` ALL gain the dedicated
 * `cancellation_charges:issue` financial-document authority; `cashier`/
 * `sales` do not. Deliberately distinct from `orders:cancel` (task 3b.3, the
 * cancellation COMMAND authority — see below) — issuing a CancellationCharge
 * requires BOTH keys plus step-up, never either alone. `credit_notes:issue`/
 * `refunds:execute` are NEVER reused for this (a different financial
 * document/authority each). Existing tenants get the identical backfill in
 * migration `20261006120000_phase_3b8_cancellation_charge_permission`.
 * `accountant` gains ONLY `cancellation_charges:issue` here — it does NOT
 * gain `orders:cancel` (below), since the frozen 3b.3 migration
 * (`20260920130000_orders_permissions`) never granted `accountant` any
 * `orders:*` key at all; the two permissions are independently sourced and
 * an actor needs BOTH to actually issue a charge (§9/§10 of this
 * checkpoint's own governing instructions).
 *
 * Task 3b.3 (`20260920130000_orders_permissions`, owner-frozen matrix —
 * discovered missing from `SYSTEM_ROLE_TEMPLATES` during Checkpoint C and
 * corrected here, verbatim from that migration's own comment/backfill, never
 * invented): `owner`/`admin`/`manager` gain all 3 `orders:*` keys;
 * `cashier`/`sales` gain `orders:view` + `orders:manage` only (NOT
 * `orders:cancel`); no other role gets any `orders:*` key. Prior to this
 * fix, a NEWLY PROVISIONED tenant received none of these — only an
 * EXISTING tenant (via the migration's own direct backfill) had them; this
 * closes that gap so new-tenant provisioning matches existing-tenant state
 * exactly, with no schema/migration change (provisioning already reads
 * `SYSTEM_ROLE_TEMPLATES` directly, so this is a code-only fix).
 */

const P = PHASE_1_TENANT_PERMISSIONS;
/** catalog:view + catalog:manage (3.2) + variants:manage (3.4) + identifiers:manage (3.5) + pricing:manage (3.7) + branch_price:manage (3.8) */
const CATALOG = [
  ...PHASE_3_2_TENANT_PERMISSIONS,
  ...PHASE_3_4_TENANT_PERMISSIONS,
  ...PHASE_3_5_TENANT_PERMISSIONS,
  ...PHASE_3_7_TENANT_PERMISSIONS,
  ...PHASE_3_8_TENANT_PERMISSIONS,
];
const CATALOG_VIEW = 'catalog:view';
/** accounting:view + accounting:manage — shared by owner + admin (3b.1). */
const ACCOUNTING = PHASE_3B_1_TENANT_PERMISSIONS.filter((k) => k !== 'accounting:period:manage');
/** accounting:period:manage — Owner-tier only (3b.1). */
const ACCOUNTING_PERIOD_MANAGE = 'accounting:period:manage';
/** customers:view + customers:manage + customers:credit:manage — shared by owner + admin (3b.2). */
const CUSTOMERS_ADMIN = PHASE_3B_2_TENANT_PERMISSIONS.filter(
  (k) => k !== 'customers:credit:override',
);
/** customers:view + customers:manage only — manager/cashier/sales (3b.2). */
const CUSTOMERS_OPERATIONAL = PHASE_3B_2_TENANT_PERMISSIONS.filter(
  (k) => k === 'customers:view' || k === 'customers:manage',
);
/** customers:credit:override — Owner-tier only (3b.2). */
const CUSTOMERS_CREDIT_OVERRIDE = 'customers:credit:override';
/** payments:view + payments:collect — owner/admin/manager/cashier/sales (3b.5). */
const PAYMENTS = PHASE_3B_5_TENANT_PERMISSIONS;
/** receivables:view + receivables:collect + receivables:advance:apply — owner/admin/manager (3b.6). */
const RECEIVABLES_MANAGER_TIER = PHASE_3B_6_TENANT_PERMISSIONS.filter(
  (k) => k !== 'receivables:opening_balance:manage',
);
/** receivables:view + receivables:collect only — cashier/sales (3b.6). */
const RECEIVABLES_OPERATIONAL = PHASE_3B_6_TENANT_PERMISSIONS.filter(
  (k) => k === 'receivables:view' || k === 'receivables:collect',
);
/** receivables:opening_balance:manage — Owner/Admin-tier only (3b.6). */
const RECEIVABLES_OPENING_BALANCE_MANAGE = 'receivables:opening_balance:manage';
/** settlements:view + settlements:manage + settlements:finalize — owner/admin/accountant (3b.7). */
const SETTLEMENTS_FULL = PHASE_3B_7_TENANT_PERMISSIONS;
/** settlements:view + settlements:manage only — manager (3b.7). */
const SETTLEMENTS_MANAGER_TIER = PHASE_3B_7_TENANT_PERMISSIONS.filter(
  (k) => k !== 'settlements:finalize',
);
/** credit_notes:view + credit_notes:issue + refunds:view + refunds:execute —
 *  owner/admin/manager/accountant, ALL FOUR identically (3b.8, §27 of the
 *  frozen 3b.8-A architecture — no manager-tier carve-out this time, an
 *  explicit, owner-accepted departure from `settlements:finalize`'s own
 *  narrower Owner/Admin/Accountant-only precedent). */
const CREDIT_NOTES_REFUNDS_FULL = PHASE_3B_8_TENANT_PERMISSIONS;
/** cancellation_charges:issue — owner/admin/accountant/manager (3b.8 Checkpoint C,
 *  owner decision). Distinct financial-document authority from `orders:cancel`. */
const CANCELLATION_CHARGES_ISSUE_FULL = PHASE_3B_8_CHECKPOINT_C_TENANT_PERMISSIONS;
/** orders:view + orders:manage — owner/admin/manager/cashier/sales (task 3b.3,
 *  `20260920130000_orders_permissions`, verbatim from that migration's own
 *  frozen backfill — see the class doc comment above). */
const ORDERS_VIEW_MANAGE = ['orders:view', 'orders:manage'];
/** orders:cancel — owner/admin/manager ONLY (task 3b.3, same migration).
 *  NEVER cashier/sales. */
const ORDERS_CANCEL = 'orders:cancel';

export interface SystemRoleTemplate {
  key: string;
  name: string;
  permissions: readonly string[];
}

export const SYSTEM_ROLE_TEMPLATES: readonly SystemRoleTemplate[] = Object.freeze([
  {
    key: 'owner',
    name: 'Owner',
    permissions: [
      ...P,
      ...CATALOG,
      ...ACCOUNTING,
      ACCOUNTING_PERIOD_MANAGE,
      ...CUSTOMERS_ADMIN,
      CUSTOMERS_CREDIT_OVERRIDE,
      ...PAYMENTS,
      ...RECEIVABLES_MANAGER_TIER,
      RECEIVABLES_OPENING_BALANCE_MANAGE,
      ...SETTLEMENTS_FULL,
      ...CREDIT_NOTES_REFUNDS_FULL,
      ...CANCELLATION_CHARGES_ISSUE_FULL,
      ...ORDERS_VIEW_MANAGE,
      ORDERS_CANCEL,
    ],
  },
  {
    key: 'admin',
    name: 'Admin',
    permissions: [
      ...P,
      ...CATALOG,
      ...ACCOUNTING,
      ...CUSTOMERS_ADMIN,
      ...PAYMENTS,
      ...RECEIVABLES_MANAGER_TIER,
      RECEIVABLES_OPENING_BALANCE_MANAGE,
      ...SETTLEMENTS_FULL,
      ...CREDIT_NOTES_REFUNDS_FULL,
      ...CANCELLATION_CHARGES_ISSUE_FULL,
      ...ORDERS_VIEW_MANAGE,
      ORDERS_CANCEL,
    ],
  },
  {
    key: 'manager',
    name: 'Manager',
    permissions: [
      'users:view',
      'audit:view',
      'settings:branch:manage',
      CATALOG_VIEW,
      ...CUSTOMERS_OPERATIONAL,
      ...PAYMENTS,
      ...RECEIVABLES_MANAGER_TIER,
      ...SETTLEMENTS_MANAGER_TIER,
      ...CREDIT_NOTES_REFUNDS_FULL,
      ...CANCELLATION_CHARGES_ISSUE_FULL,
      ...ORDERS_VIEW_MANAGE,
      ORDERS_CANCEL,
    ],
  },
  { key: 'supervisor', name: 'Supervisor', permissions: ['users:view'] },
  {
    key: 'cashier',
    name: 'Cashier',
    permissions: [
      'users:view',
      ...CUSTOMERS_OPERATIONAL,
      ...PAYMENTS,
      ...RECEIVABLES_OPERATIONAL,
      ...ORDERS_VIEW_MANAGE,
    ],
  },
  {
    key: 'sales',
    name: 'Sales',
    permissions: [
      'users:view',
      ...CUSTOMERS_OPERATIONAL,
      ...PAYMENTS,
      ...RECEIVABLES_OPERATIONAL,
      ...ORDERS_VIEW_MANAGE,
    ],
  },
  { key: 'florist', name: 'Florist', permissions: ['users:view'] },
  { key: 'storekeeper', name: 'Storekeeper', permissions: ['users:view'] },
  { key: 'purchase_staff', name: 'Purchase Staff', permissions: ['users:view'] },
  {
    key: 'accountant',
    name: 'Accountant',
    permissions: [
      'users:view',
      ...SETTLEMENTS_FULL,
      ...CREDIT_NOTES_REFUNDS_FULL,
      ...CANCELLATION_CHARGES_ISSUE_FULL,
    ],
  },
  { key: 'dispatcher', name: 'Dispatcher', permissions: ['users:view'] },
  { key: 'driver', name: 'Driver', permissions: ['users:view'] },
  { key: 'receptionist', name: 'Receptionist', permissions: ['users:view'] },
]);
