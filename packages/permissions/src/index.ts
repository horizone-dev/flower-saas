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
  customers: [
    'customers:view',
    'customers:manage',
    'credit:view',
    'credit:manage',
    'advance:manage',
    'giftcards:manage',
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
