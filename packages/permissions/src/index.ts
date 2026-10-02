/**
 * The permission registry (ARCHITECTURE §9). A permission key is
 * `domain:action[:qualifier]`. This is the Phase 0 seed of the representative
 * catalogue; it is refined per phase. Effective permissions are resolved by the
 * `access` module at runtime — this package only holds the constants + types.
 *
 * There is deliberately NO key for external secrets: that capability does not
 * exist in the tenant realm (CLAUDE.md rule 26).
 */

export const PERMISSIONS = {
  posSell: [
    'pos:sell',
    'pos:discount',
    'pos:price_override',
    'pos:refund',
    'pos:void',
    'pos:reprint',
    'pos:change_staff',
    'pos:custom_bouquet',
    'pos:drawer:open',
    'pos:drawer:close',
    'pos:zreport',
  ],
  orders: [
    'orders:view',
    'orders:manage',
    'orders:cancel',
    'orders:attribution:edit',
    'online_orders:view',
    'online_orders:manage',
    'online_orders:accept',
    'online_orders:reject',
  ],
  catalog: [
    'catalog:view',
    'catalog:manage',
    'variants:manage',
    'pricing:manage',
    'branch_price:manage',
    'promotions:manage',
  ],
  inventory: [
    'inventory:view',
    'inventory:receive',
    'inventory:adjust',
    'inventory:transfer',
    'inventory:count',
    'inventory:wastage',
    'inventory:reservation:view',
    'recipe:view',
    'recipe:manage',
    'identifiers:manage',
  ],
  procurement: [
    'purchases:view',
    'purchases:manage',
    'purchases:receive',
    'suppliers:manage',
    'supplier_payments:manage',
  ],
  workforce: [
    'staff:view',
    'staff:create',
    'staff:edit',
    'staff:disable',
    'staff:branch_assign',
    'staff:schedule:view',
    'staff:schedule:manage',
    'staff:attendance:view',
    'staff:attendance:manage',
    'staff:attendance:correct',
    'staff:leave:view',
    'staff:leave:manage',
    'staff:leave:approve',
    'staff:performance:view',
    'staff:commission:view',
    'staff:commission:manage',
    'attendance_device:manage',
  ],
  // task 3b.2 — CRM / Customer Core. The frozen 4-key contract is
  // `customers:view` / `customers:manage` / `customers:credit:manage` /
  // `customers:credit:override` (docs/phase-3/PHASE-3B-PLAN.md §E.1) —
  // replaces the stale Phase-0 placeholder keys `credit:view`/`credit:manage`/
  // `advance:manage`/`giftcards:manage` (confirmed zero runtime consumers
  // repo-wide before removal; Gift Cards remain deferred per D3b-20).
  // `payments:refund:approve`/`reports:view`/`reports:tenant` are left as-is —
  // unrelated stale keys, out of this task's scope.
  customers: [
    'customers:view',
    'customers:manage',
    'customers:credit:manage',
    'customers:credit:override',
    'payments:refund:approve',
    'reports:view',
    'reports:tenant',
  ],
  finance: [
    'accounts:view',
    'accounts:manage',
    'income:view',
    'income:create',
    'income:edit',
    'income:approve',
    'expense:view',
    'expense:create',
    'expense:edit',
    'expense:approve',
    'expense:pay',
    'financial_reports:view',
  ],
  cashRegister: [
    'cash_register:open',
    'cash_register:view',
    'cash_register:cash_in',
    'cash_register:cash_out',
    'cash_register:close',
    'cash_register:override',
    'x_report:view',
    'x_report:print',
    'z_report:view',
    'z_report:close',
    'z_report:print',
  ],
  customerWebAi: [
    'customer_web:view',
    'customer_web:manage',
    'customer_web:catalog:manage',
    'customer_web:slots:manage',
    'ai:settings:view',
    'ai:settings:manage',
    'ai:conversations:view',
    'ai:conversations:reply',
    'ai:handoff:handle',
  ],
  admin: [
    'users:view',
    'users:manage',
    'roles:manage',
    'devices:activate',
    'devices:manage',
    'audit:view',
    'settings:branch:manage',
    'settings:tenant:manage',
  ],
  // Task 3b.1 — CoA + Posting Engine + Accounting Periods. Distinct from the
  // pre-existing `finance` group's `accounts:*` (a separate, broader Finance
  // module placeholder, not this task's Chart-of-Accounts primitive).
  accounting: ['accounting:view', 'accounting:manage', 'accounting:period:manage'],
  // Task 3b.5 — Payments + PaymentAttempt + Multi Payment. A brand new group
  // (no pre-existing placeholder existed, unlike `orders:*`) — mirrors task
  // 3b.1's own precedent of adding a wholly new group when none exists.
  // Distinct from the pre-existing `payments:refund:approve` (stale
  // placeholder key in the `customers` group, out of 3b.5 scope — refunds
  // belong to a later task). Only these 2 keys; no `payments:manage`,
  // `payments:webhook:process`, `payments:refund`, `payments:void`, or
  // `payments:settle` key exists anywhere in 3b.5.
  payments: ['payments:view', 'payments:collect'],
  // Task 3b.6 — Receivables / Credit / Advances (docs/decisions/ADR-0019.md).
  // A brand new group, mirroring `payments`'s own precedent. `receivables:view`
  // + `receivables:collect` are routine POS-floor actions (mirrors
  // `payments:view`/`payments:collect`); `receivables:advance:apply` is
  // narrower (owner/admin/manager — mirrors `accounting:manage`'s tier, not
  // `customers:credit:*`'s Owner-heavier one); `receivables:opening_balance:manage`
  // is Owner/Admin-tier ONLY and step-up gated (STEP_UP_PERMISSIONS below) —
  // it is the one action in this group that fabricates a financial balance
  // from nothing, mirroring `customers:credit:manage`'s money-exposure
  // precedent, not `payments:collect`'s routine-transaction one. Existing
  // `customers:credit:manage` / `customers:credit:override` (3b.2) are
  // untouched — their frozen role assignment is not widened here.
  receivables: [
    'receivables:view',
    'receivables:collect',
    'receivables:advance:apply',
    'receivables:opening_balance:manage',
  ],
  // Task 3b.7 Checkpoint C — Settlement (provider payout reconciliation), a
  // brand new group mirroring `payments`/`receivables`'s own precedent.
  // `settlements:view`/`settlements:manage` are DRAFT-lifecycle operational
  // actions (create/edit/ingest/match — never money-moving on their own, no
  // SettlementApplication/GL effect exists yet in Checkpoint C).
  // `settlements:finalize` is registered now (permission-only, exactly like
  // `customers:credit:override` in 3b.2 and `orders:cancel` in 3b.3) — no
  // finalize route exists until Checkpoint D; it is step-up gated (below)
  // since finalizing is what will eventually create the SettlementApplication/
  // journal/Invoice-SETTLED effect.
  settlements: ['settlements:view', 'settlements:manage', 'settlements:finalize'],
  // Task 3b.8 Checkpoint B — Cancellation / Refund / Credit Note. Two brand
  // new groups mirroring `payments`/`receivables`/`settlements`'s own
  // precedent. Pre-invoice no-charge CANCELLATION COMMAND authority
  // registers NO new permission here — OWNER-RESOLVED (Checkpoint B
  // corrective gate): it uses the existing, already-registered
  // `orders:cancel` key (task 3b.3), never bare `orders:manage`. Default
  // system-role grant remains Owner/Admin/Manager only (Cashier/Sales
  // excluded, least-privilege) via the existing task 3b.3 backfill.
  creditNotes: ['credit_notes:view', 'credit_notes:issue'],
  refunds: ['refunds:view', 'refunds:execute'],
  // Task 3b.8 Checkpoint C — the CancellationCharge FINANCIAL DOCUMENT
  // authority, OWNER-RESOLVED and distinct from `orders:cancel` (the
  // cancellation COMMAND authority, unchanged above): CancellationCharge is
  // its own financial document/authority, never implicitly coupled to
  // Credit Note or Refund — `credit_notes:issue`/`refunds:execute` are
  // DELIBERATELY NEVER reused for it, nor is bare `orders:manage`, nor the
  // never-implemented `cancellation_charge:override` name from the
  // pre-implementation Phase 3b planning doc. Issuing a CancellationCharge
  // requires BOTH `orders:cancel` AND `cancellation_charges:issue`, PLUS
  // step-up (`STEP_UP_PERMISSIONS` below) — no-charge cancellation needs
  // only `orders:cancel`.
  cancellationCharges: ['cancellation_charges:issue'],
} as const satisfies Record<string, readonly string[]>;

export type PermissionGroup = keyof typeof PERMISSIONS;
export type PermissionKey = (typeof PERMISSIONS)[PermissionGroup][number];

/** Flat, de-duplicated, sorted list of every tenant-realm permission key. */
export const ALL_PERMISSIONS: readonly PermissionKey[] = Object.freeze(
  [...new Set(Object.values(PERMISSIONS).flat())].sort() as PermissionKey[],
);

/** group key for a tenant permission (its key in `PERMISSIONS`). */
export const PERMISSION_GROUP_OF: Readonly<Record<PermissionKey, PermissionGroup>> = Object.freeze(
  Object.fromEntries(
    Object.entries(PERMISSIONS).flatMap(([group, keys]) =>
      keys.map((k) => [k, group as PermissionGroup] as const),
    ),
  ) as Record<PermissionKey, PermissionGroup>,
);

/**
 * The Phase 1 subset of the tenant catalogue that is *actually enforced* now
 * (OD6 — least privilege). Every other key stays inert until its domain lands,
 * so Phase 1 provisioning seeds only these into `permission_registry` and only
 * assigns these to the seeded system roles.
 */
export const PHASE_1_TENANT_PERMISSIONS = [
  'users:view',
  'users:manage',
  'roles:manage',
  'audit:view',
  'settings:branch:manage',
  'settings:tenant:manage',
] as const satisfies readonly PermissionKey[];

export type Phase1TenantPermission = (typeof PHASE_1_TENANT_PERMISSIONS)[number];

/**
 * Phase 3 task 3.2 activates the two foundational catalog keys — no key is
 * renamed, duplicated or invented (D2-6 / HG3-PERMISSION-STABILITY). They are
 * seeded into `permission_registry` and assigned to the built-in `owner` /
 * `admin` (both) and `manager` (`catalog:view` only) system roles — for new
 * tenants via `SYSTEM_ROLE_TEMPLATES`, for existing tenants via the task 3.2
 * migration backfill. `catalog:manage` gates every catalog write; `catalog:view`
 * every catalog read. Neither is in `MODULE_OF_PERMISSION` — `catalog` is a
 * foundation module (always entitled); the per-strategy `production_bom` /
 * `custom_composition` entitlement check happens in the catalog service.
 */
export const PHASE_3_2_TENANT_PERMISSIONS = [
  'catalog:view',
  'catalog:manage',
] as const satisfies readonly PermissionKey[];

export type Phase32TenantPermission = (typeof PHASE_3_2_TENANT_PERMISSIONS)[number];

/**
 * Phase 3 task 3.4 activates the ALREADY-RESERVED `variants:manage` key — it has
 * existed in `PERMISSIONS.catalog` since Phase 0; task 3.4 registers it in
 * `permission_registry` and assigns it to the built-in `owner` / `admin` system
 * roles (`manager` does NOT get it — mirrors `catalog:manage`). No key is
 * renamed, duplicated or invented (D2-6 / HG3-PERMISSION-STABILITY). It gates
 * option-group configuration + explicit non-default variant lifecycle;
 * `catalog:view` covers every variant/option-group read. Not in
 * `MODULE_OF_PERMISSION` — the `variants` catalog capability (task 3.1) is the
 * fine gate, checked in the service; `variants` requires no entitlement module.
 * Not step-up — a variant edit is not money / permission / secret (owner L-16).
 */
export const PHASE_3_4_TENANT_PERMISSIONS = [
  'variants:manage',
] as const satisfies readonly PermissionKey[];

export type Phase34TenantPermission = (typeof PHASE_3_4_TENANT_PERMISSIONS)[number];

/**
 * Phase 3 task 3.5 activates the ALREADY-RESERVED `identifiers:manage` key — it
 * has existed in `PERMISSIONS.inventory` since Phase 0; task 3.5 registers it in
 * `permission_registry` and assigns it to the built-in `owner` / `admin` system
 * roles (`manager` does NOT get it — mirrors `catalog:manage` / `variants:manage`).
 * No key is renamed, duplicated, invented, or moved out of its `inventory` group
 * (D2-6 / HG3-PERMISSION-STABILITY / owner I.5 — the group is display metadata,
 * unrelated to which routes use the key). It gates every `item_identifier` write
 * (create / deactivate / reactivate / DRAFT-correction delete); `catalog:view`
 * covers every identifier read + scan-resolve. Not in `MODULE_OF_PERMISSION` —
 * the `identifiers.barcode_qr` catalog capability (task 3.1) is the fine gate for
 * BARCODE / QR writes, checked in the service; it requires no entitlement module.
 * Not step-up — an identifier is not money / permission / secret / attribution.
 */
export const PHASE_3_5_TENANT_PERMISSIONS = [
  'identifiers:manage',
] as const satisfies readonly PermissionKey[];

export type Phase35TenantPermission = (typeof PHASE_3_5_TENANT_PERMISSIONS)[number];

/**
 * Phase 3 task 3.7 activates the ALREADY-RESERVED `pricing:manage` key — it has
 * existed in `PERMISSIONS.catalog` since Phase 0; task 3.7 registers it in
 * `permission_registry` and assigns it to the built-in `owner` / `admin` system
 * roles (`manager` does NOT get it — mirrors `catalog:manage` / `variants:manage`
 * / `identifiers:manage`). No key is renamed, duplicated or invented (D2-6 /
 * HG3-PERMISSION-STABILITY). It gates every `company_variant_uom_price` write
 * (the replace-set `PUT`); `catalog:view` covers the price GET + the `/resolve`
 * read. Not in `MODULE_OF_PERMISSION` — `catalog` is a foundation module (always
 * entitled) and there is NO `company_pricing` catalog capability (company pricing
 * is foundational — D-12). NOT step-up — a price is catalog configuration, not a
 * money-moving transaction (D-9), consistent with every other catalog key.
 */
export const PHASE_3_7_TENANT_PERMISSIONS = [
  'pricing:manage',
] as const satisfies readonly PermissionKey[];

export type Phase37TenantPermission = (typeof PHASE_3_7_TENANT_PERMISSIONS)[number];

/**
 * Phase 3 task 3.8 activates the ALREADY-RESERVED `branch_price:manage` key — it
 * has existed in `PERMISSIONS.catalog` since Phase 0; task 3.8 registers it in
 * `permission_registry` and assigns it to the built-in `owner` / `admin` system
 * roles (`manager` does NOT get it by default — mirrors `catalog:manage` /
 * `variants:manage` / `identifiers:manage` / `pricing:manage`; a custom role may
 * receive it normally). No key is renamed, duplicated or invented (D2-6 /
 * HG3-PERMISSION-STABILITY). It gates BOTH branch-price writes (`PUT …/prices`)
 * AND branch-availability writes (`PUT …/availability`); BOTH also require the
 * `branch_pricing` catalog capability (owner ruling 2026-09-09). `catalog:view`
 * covers every branch read — reads are never capability-gated. Not in
 * `MODULE_OF_PERMISSION` — `catalog` is a foundation module. NOT step-up (BD-12).
 * There is NO separate `branch_availability` permission or capability.
 */
export const PHASE_3_8_TENANT_PERMISSIONS = [
  'branch_price:manage',
] as const satisfies readonly PermissionKey[];

export type Phase38TenantPermission = (typeof PHASE_3_8_TENANT_PERMISSIONS)[number];

/**
 * Phase 3 task 3.9 (catalog tax-category assignment + rate resolution) activates
 * **NO new permission key and NO capability** (owner O1 / O7 / D2-6 /
 * HG3-PERMISSION-STABILITY). It reuses keys already registered since Task 3.2 /
 * 3.4:
 *   - `PUT /v1/catalog/products/:id/tax-category`  → `catalog:manage`
 *   - `PUT /v1/catalog/variants/:id/tax-category`  → `variants:manage`
 *   - `GET …/companies/:companyId/variants/:variantId/tax` → `catalog:view`
 *     (+ existing `@ScopedParam({ company })` scope authorization)
 * No `permission_registry` insert, no `role_permission` backfill, no
 * `SYSTEM_ROLE_TEMPLATES` / seed change. This constant exists only to make the
 * "nothing new" decision explicit and test-checkable.
 */
export const PHASE_3_9_TENANT_PERMISSIONS = [] as const satisfies readonly PermissionKey[];

export type Phase39TenantPermission = (typeof PHASE_3_9_TENANT_PERMISSIONS)[number];

/**
 * Phase 3b task 3b.1 (CoA + Posting Engine + Accounting Periods) activates the
 * three new `accounting` keys (docs/phase-3/PHASE-3B-PLAN.md §E). Registered
 * in `permission_registry` and assigned to built-in system roles: `owner` +
 * `admin` gain `accounting:view` + `accounting:manage`; `owner` ALONE also
 * gains `accounting:period:manage` (a period create/close is Owner-tier only —
 * the frozen owner decision explicitly forbids inventing a tenant "Super Admin"
 * role for this; Platform Super Admin is a wholly separate auth realm, per
 * SECURITY.md, never conflated with a tenant role). `manager` gets neither.
 * Existing tenants get the identical backfill in the task 3b.1 migration.
 */
export const PHASE_3B_1_TENANT_PERMISSIONS = [
  'accounting:view',
  'accounting:manage',
  'accounting:period:manage',
] as const satisfies readonly PermissionKey[];

/**
 * Task 3b.2 (docs/phase-3/PHASE-3B-PLAN.md §E) — CRM / Customer Core. The
 * frozen 4-key contract. Registered in `permission_registry` and assigned to
 * built-in system roles: `owner` gains all 4; `admin`/`manager`/`cashier`/
 * `sales` gain `customers:view` + `customers:manage` (`admin` additionally
 * gains `customers:credit:manage`) — `customers:credit:override` is
 * Owner-tier only (no tenant "Super Admin" role invented; Platform Super
 * Admin is a wholly separate auth realm, never a tenant role). Registering
 * `customers:credit:override` now is permission-only — its actual override
 * *behavior* is Task 3b.6 (step-up, reason-required, audited, not built
 * here). Existing tenants get the identical backfill in the task 3b.2
 * migration.
 */
export const PHASE_3B_2_TENANT_PERMISSIONS = [
  'customers:view',
  'customers:manage',
  'customers:credit:manage',
  'customers:credit:override',
] as const satisfies readonly PermissionKey[];

export type Phase3b2TenantPermission = (typeof PHASE_3B_2_TENANT_PERMISSIONS)[number];

export type Phase3b1TenantPermission = (typeof PHASE_3B_1_TENANT_PERMISSIONS)[number];

/**
 * Task 3b.3 (docs/phase-3/PHASE-3B-PLAN.md §E.1) — Orders + Invoice +
 * Numbering, Checkpoint A/B. The frozen 3-key contract. Registered in
 * `permission_registry` and assigned to built-in system roles per the
 * owner-frozen matrix (Checkpoint A hardening pass): `owner`/`admin`/
 * `manager` gain all 3; `cashier`/`sales` gain `orders:view` +
 * `orders:manage` only. `orders:cancel` is registered/backfilled as a
 * capability only — Task 3b.3 implements no cancellation endpoint or
 * transition; execution remains Task 3b.8. Existing tenants get the
 * identical backfill in the task 3b.3 permissions migration.
 */
export const PHASE_3B_3_TENANT_PERMISSIONS = [
  'orders:view',
  'orders:manage',
  'orders:cancel',
] as const satisfies readonly PermissionKey[];

export type Phase3b3TenantPermission = (typeof PHASE_3B_3_TENANT_PERMISSIONS)[number];

/**
 * Task 3b.5 (docs/phase-3/PHASE-3B-PLAN.md §E) — Payments + PaymentAttempt +
 * Multi Payment, Checkpoint B. The frozen 2-key contract: `payments:view` +
 * `payments:collect` — no `payments:manage`, no `payments:webhook:process`
 * (webhook execution is system/provider-authenticated infrastructure, never
 * a human permission), no `payments:refund`/`payments:void`/
 * `payments:settle` (those belong to the future tasks that implement them).
 * Registered in `permission_registry` and assigned to built-in system roles
 * per the owner-frozen matrix: `owner`/`admin`/`manager`/`cashier`/`sales`
 * all gain both keys — collecting a routine sale payment is a normal
 * POS-floor action, mirroring the `orders:view`/`orders:manage` precedent
 * exactly (not the Owner/Admin-only `accounting:*`/`customers:credit:*`
 * precedent). Not step-up gated — no accepted rule mandates step-up for
 * ordinary payment collection (existing step-up keys are all elevated
 * configuration/limit actions, never a routine transactional one).
 */
export const PHASE_3B_5_TENANT_PERMISSIONS = [
  'payments:view',
  'payments:collect',
] as const satisfies readonly PermissionKey[];

export type Phase3b5TenantPermission = (typeof PHASE_3B_5_TENANT_PERMISSIONS)[number];

/**
 * Task 3b.6 (docs/decisions/ADR-0019.md) — Receivables / Credit / Advances,
 * Checkpoint B. The frozen 4-key contract. Registered in `permission_registry`
 * and assigned to built-in system roles per the owner-frozen matrix:
 * `owner`/`admin`/`manager`/`cashier`/`sales` gain `receivables:view` +
 * `receivables:collect` (mirrors `payments:view`/`payments:collect`'s
 * cashier/sales inclusion exactly — routine POS-floor actions);
 * `owner`/`admin`/`manager` gain `receivables:advance:apply`
 * (cashier/sales do NOT — applying a customer's Advance is not a routine
 * sale-floor action); `owner`/`admin` ALONE gain
 * `receivables:opening_balance:manage` (step-up gated — see
 * STEP_UP_PERMISSIONS below — it fabricates a financial balance from
 * nothing, the same money-exposure tier as `customers:credit:manage`).
 * Existing tenants get the identical backfill in the task 3b.6 permissions
 * migration. Checkpoint B registers these keys only — no controller/route
 * exists yet to enforce them.
 */
export const PHASE_3B_6_TENANT_PERMISSIONS = [
  'receivables:view',
  'receivables:collect',
  'receivables:advance:apply',
  'receivables:opening_balance:manage',
] as const satisfies readonly PermissionKey[];

export type Phase3b6TenantPermission = (typeof PHASE_3B_6_TENANT_PERMISSIONS)[number];

/**
 * Task 3b.7 Checkpoint C — Settlement DRAFT lifecycle (ingestion + matching).
 * The frozen 3-key contract. `owner`/`admin`/`accountant` gain all three
 * (`settlements:view`+`settlements:manage`+`settlements:finalize`);
 * `manager` gains `settlements:view`+`settlements:manage` only (NOT
 * `settlements:finalize` — mirrors `accounting:period:manage`'s
 * Owner/Admin-narrower precedent, extended here to also include the
 * Accountant system role, the one role whose entire purpose is this
 * domain); `cashier`/`sales` gain neither key — settlement reconciliation
 * is a back-office function, not a POS-floor action (unlike
 * `payments:collect`/`receivables:collect`). `settlements:finalize` is
 * step-up gated (STEP_UP_PERMISSIONS below) — it is the permission that
 * will eventually gate creating SettlementApplication/GL/Invoice-SETTLED
 * effects (Checkpoint D), even though no finalize route exists yet.
 * `settlements:view`/`settlements:manage` are NOT step-up gated. Existing
 * tenants get the identical backfill in the task 3b.7 permissions migration.
 */
export const PHASE_3B_7_TENANT_PERMISSIONS = [
  'settlements:view',
  'settlements:manage',
  'settlements:finalize',
] as const satisfies readonly PermissionKey[];

export type Phase3b7TenantPermission = (typeof PHASE_3B_7_TENANT_PERMISSIONS)[number];

/**
 * Task 3b.8 Checkpoint B — Cancellation / Refund / Credit Note. The frozen
 * 4-key contract (§27/§30 of the 3b.8-A architecture). `owner`/`admin`/
 * `accountant`/`manager` gain all four — Credit Note/Refund VIEW is
 * ungated, ISSUE/EXECUTE are step-up gated (STEP_UP_PERMISSIONS below).
 * `cashier`/`sales` gain neither key — issuing a Credit Note or moving cash
 * back out is a back-office function (mirrors `settlements:*`'s own
 * precedent). Manager's inclusion in the step-up-gated ISSUE/EXECUTE tier is
 * an explicit, owner-accepted departure from `settlements:finalize`'s
 * narrower Owner/Admin/Accountant-only precedent — flagged, not silent.
 * Existing tenants get the identical backfill in the task 3b.8 permissions
 * migration.
 */
export const PHASE_3B_8_TENANT_PERMISSIONS = [
  'credit_notes:view',
  'credit_notes:issue',
  'refunds:view',
  'refunds:execute',
] as const satisfies readonly PermissionKey[];

export type Phase3b8TenantPermission = (typeof PHASE_3B_8_TENANT_PERMISSIONS)[number];

/**
 * Task 3b.8 Checkpoint C — the CancellationCharge financial-document
 * authority (owner decision, Checkpoint C blocker-resolution gate). A
 * dedicated, single-key contract — deliberately NOT added to the already-
 * frozen `PHASE_3B_8_TENANT_PERMISSIONS` array above (Checkpoint B is a
 * separate, permanently frozen, already-committed unit; this is new
 * Checkpoint C work, kept as its own export exactly like every other
 * task/checkpoint's own `PHASE_3B_X_TENANT_PERMISSIONS` constant).
 * `owner`/`admin`/`accountant`/`manager` gain it; `cashier`/`sales` do not
 * (owner-frozen matrix). Step-up gated (STEP_UP_PERMISSIONS below).
 * Issuing a CancellationCharge requires BOTH `orders:cancel` (the
 * cancellation COMMAND authority, task 3b.3, unchanged) AND this key (the
 * financial DOCUMENT authority) — never either alone. Existing tenants get
 * the identical backfill in migration
 * `20261006120000_phase_3b8_cancellation_charge_permission`.
 */
export const PHASE_3B_8_CHECKPOINT_C_TENANT_PERMISSIONS = [
  'cancellation_charges:issue',
] as const satisfies readonly PermissionKey[];

export type Phase3b8CheckpointCTenantPermission =
  (typeof PHASE_3B_8_CHECKPOINT_C_TENANT_PERMISSIONS)[number];

/**
 * Platform Super Admin realm permissions. **Wholly separate** from the tenant
 * catalogue and never grantable to a tenant user (SECURITY.md "identity realms").
 * This is the ONLY place a secret-management capability exists anywhere — the
 * tenant realm has no such key (CLAUDE.md rule 26).
 */
export const PLATFORM_PERMISSIONS = [
  'platform:tenants:view',
  'platform:tenants:manage',
  'platform:tenants:impersonate',
  'platform:plans:manage',
  'platform:entitlements:manage',
  'platform:limits:manage',
  'platform:tenant_users:manage',
  'platform:tenant_roles:manage',
  'platform:sessions:revoke',
  'platform:audit:view',
  'platform:secrets:manage',
  // Phase 3 task 3.1 — the Super-Admin catalog-capability configuration surface
  // (per-tenant `tenant_catalog_capability` + the initial Business-Type template
  // apply). Distinct from `platform:entitlements:manage` so it can be delegated
  // independently. No tenant-realm key ever reaches this data (owner §12 / spec
  // §8). Step-up is enforced on the mutation (PATCH) only — the read route opts
  // out with `@NoStepUp()` (owner R-7).
  'platform:catalog_capability:manage',
] as const;

export type PlatformPermissionKey = (typeof PLATFORM_PERMISSIONS)[number];

/**
 * Actions gated by fresh step-up MFA (SECURITY.md: money / permission / secret /
 * attribution-change). Phase 1 subset — the money/attribution keys join as their
 * domains land.
 */
export const STEP_UP_PERMISSIONS: ReadonlySet<string> = new Set<string>([
  'users:manage',
  'roles:manage',
  'settings:tenant:manage',
  'settings:branch:manage',
  // Task 3b.1 — period create/close is a financial-integrity-affecting action
  // (docs/phase-3/PHASE-3B-PLAN.md §D3b-4/§E). `accounting:manage` is also
  // used for the low-risk account-display-metadata PATCH, which opts OUT with
  // `@NoStepUp()` (the accounting-timezone-configuration route, which shares
  // this key, is the one that actually needs the step-up tier — mirrors the
  // existing `platform:catalog_capability:manage` precedent of one key serving
  // both a step-up-worthy mutation and a `@NoStepUp()` lower-risk route).
  'accounting:manage',
  'accounting:period:manage',
  // Task 3b.2 — credit-limit configuration gates future money-exposure even
  // though it posts nothing itself (docs/phase-3/PHASE-3B-PLAN.md scope
  // review §0.16, mirrors accounting:period:manage's precedent). No other
  // customers:* route uses this key, so no `@NoStepUp()` opt-out is needed
  // anywhere for it.
  'customers:credit:manage',
  // Task 3b.6 Checkpoint C — the one-sale credit-limit override is a
  // deliberate bypass of a money-exposure control (SECURITY.md: step-up
  // gates money/permission/secret/attribution-change actions). Registered
  // permission-only in 3b.2 with this behavior explicitly deferred to
  // Checkpoint C ("its actual override behavior is Task 3b.6"); this is that
  // behavior landing. No `@NoStepUp()` opt-out exists anywhere for this key.
  'customers:credit:override',
  // Task 3b.6 — creating an opening receivable/advance fabricates a financial
  // balance from nothing (no Invoice/Payment behind it) — the same
  // money-exposure tier as `customers:credit:manage` above. No other
  // `receivables:*` key uses this — `:view`/`:collect`/`:advance:apply` are
  // routine transactional actions, matching `payments:collect`'s precedent.
  'receivables:opening_balance:manage',
  // Task 3b.7 Checkpoint C — settlement finalization will eventually create
  // the SettlementApplication/GL/Invoice-SETTLED financial effect
  // (Checkpoint D). No finalize route exists yet, but the permission key
  // itself is step-up gated now, matching `accounting:period:manage`'s own
  // "money/financial-integrity action" precedent. `settlements:view`/
  // `settlements:manage` are NOT step-up gated (ordinary DRAFT-lifecycle
  // operational actions, no money-moving effect exists yet).
  'settlements:finalize',
  // Task 3b.8 Checkpoint C — issuing a CancellationCharge creates a real
  // Accounts-Receivable/GL effect (same "money/financial-integrity action"
  // tier as `settlements:finalize`/`accounting:period:manage` above).
  // `orders:cancel` itself stays NOT step-up gated (the no-charge path has
  // no money-moving effect) — only this key gates the financial-document
  // creation specifically.
  'cancellation_charges:issue',
  // Task 3b.8 Checkpoint D — closes a gap left open by Checkpoint B:
  // `PHASE_3B_8_TENANT_PERMISSIONS`'s own doc comment already stated
  // "Credit Note/Refund VIEW is ungated, ISSUE/EXECUTE are step-up gated
  // (STEP_UP_PERMISSIONS below)" at the time these two keys were registered
  // and migrated, but neither was actually added to this set until now.
  // Issuing a CreditNote and executing a Refund each create a real GL/money
  // effect (same tier as `cancellation_charges:issue` above); `credit_notes:
  // view`/`refunds:view` stay NOT step-up gated (ordinary read actions).
  'credit_notes:issue',
  'refunds:execute',
  ...PLATFORM_PERMISSIONS.filter(
    (k) =>
      k === 'platform:tenants:manage' ||
      k === 'platform:tenants:impersonate' ||
      k === 'platform:limits:manage' ||
      k === 'platform:entitlements:manage' ||
      k === 'platform:tenant_users:manage' ||
      k === 'platform:tenant_roles:manage' ||
      k === 'platform:secrets:manage' ||
      // task 3.1 — a capability change is a config mutation on tenant data; the
      // read route (`GET …/catalog-capabilities`) opts out with `@NoStepUp()`.
      k === 'platform:catalog_capability:manage',
  ),
]);

export function requiresStepUp(key: string): boolean {
  return STEP_UP_PERMISSIONS.has(key);
}

/**
 * Maps a permission key to the feature module that must be entitled for it to be
 * usable (ARCHITECTURE §48 — "a permission whose module is not entitled is
 * inert"). A key absent from this map is always available (the Phase 1 foundation
 * keys). Grows as domains land.
 */
export const MODULE_OF_PERMISSION: Readonly<Record<string, string>> = Object.freeze({
  'customer_web:view': 'customer_web',
  'customer_web:manage': 'customer_web',
  'customer_web:catalog:manage': 'customer_web',
  'customer_web:slots:manage': 'customer_web',
  'ai:settings:view': 'customer_web_ai',
  'ai:settings:manage': 'customer_web_ai',
  'ai:conversations:view': 'customer_web_ai',
  'ai:conversations:reply': 'customer_web_ai',
  'ai:handoff:handle': 'customer_web_ai',
  'recipe:view': 'production_bom',
  'recipe:manage': 'production_bom',
  'attendance_device:manage': 'biometric_attendance',
});

export interface EffectivePermissionInput {
  /** union of the keys from every role the user holds */
  rolePermissions: Iterable<string>;
  /** direct per-user grants: [key, 'ALLOW' | 'DENY'] */
  directGrants: Iterable<readonly [string, 'ALLOW' | 'DENY']>;
  /**
   * Modules entitled for the tenant. A permission whose `MODULE_OF_PERMISSION`
   * is not in this set is dropped. `null` disables the filter (platform realm).
   */
  entitledModules?: ReadonlySet<string> | null;
}

/**
 * Pure effective-permission resolution (ARCHITECTURE §9):
 *   (∪ role permissions ∪ direct ALLOW) − direct DENY, then ∩ entitlement.
 * **Deny always wins.** The per-request scope intersection happens later, in the
 * policy engine, against the resolved data scope.
 */
export function resolveEffectivePermissions(input: EffectivePermissionInput): Set<string> {
  const allow = new Set<string>(input.rolePermissions);
  const deny = new Set<string>();
  for (const [key, effect] of input.directGrants) {
    if (effect === 'DENY') deny.add(key);
    else allow.add(key);
  }
  for (const d of deny) allow.delete(d); // deny wins

  if (input.entitledModules) {
    for (const key of [...allow]) {
      const mod = MODULE_OF_PERMISSION[key];
      if (mod !== undefined && !input.entitledModules.has(mod)) allow.delete(key);
    }
  }
  return allow;
}

const KEY_RE = /^[a-z0-9_]+(?::[a-z0-9_]+){1,2}$/;

export function isPermissionKey(value: string): value is PermissionKey {
  return (ALL_PERMISSIONS as readonly string[]).includes(value);
}

export function isPlatformPermissionKey(value: string): value is PlatformPermissionKey {
  return (PLATFORM_PERMISSIONS as readonly string[]).includes(value);
}

export function isWellFormedPermissionKey(value: string): boolean {
  return KEY_RE.test(value);
}
