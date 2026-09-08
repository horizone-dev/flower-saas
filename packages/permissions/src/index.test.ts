import { describe, it, expect } from 'vitest';
import {
  PERMISSIONS,
  ALL_PERMISSIONS,
  PERMISSION_GROUP_OF,
  PHASE_1_TENANT_PERMISSIONS,
  PHASE_3_2_TENANT_PERMISSIONS,
  PHASE_3_4_TENANT_PERMISSIONS,
  PHASE_3_5_TENANT_PERMISSIONS,
  PHASE_3_7_TENANT_PERMISSIONS,
  PHASE_3_8_TENANT_PERMISSIONS,
  PLATFORM_PERMISSIONS,
  MODULE_OF_PERMISSION,
  STEP_UP_PERMISSIONS,
  requiresStepUp,
  resolveEffectivePermissions,
  isPermissionKey,
  isPlatformPermissionKey,
  isWellFormedPermissionKey,
} from './index.js';

describe('@flower/permissions registry', () => {
  it('every key is well-formed domain:action[:qualifier]', () => {
    for (const key of [...ALL_PERMISSIONS, ...PLATFORM_PERMISSIONS]) {
      expect(isWellFormedPermissionKey(key), key).toBe(true);
    }
  });

  it('ALL_PERMISSIONS is de-duplicated and sorted', () => {
    expect([...ALL_PERMISSIONS]).toEqual([...ALL_PERMISSIONS].sort());
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('the tenant realm has no secret-management key (CLAUDE.md rule 26)', () => {
    expect(ALL_PERMISSIONS.some((k) => k.includes('secret'))).toBe(false);
    // and no tenant key leaks into the platform namespace
    expect(ALL_PERMISSIONS.some((k) => k.startsWith('platform:'))).toBe(false);
  });

  it('the two realms are disjoint', () => {
    const tenant = new Set<string>(ALL_PERMISSIONS);
    for (const k of PLATFORM_PERMISSIONS) expect(tenant.has(k)).toBe(false);
  });

  it('secret management exists ONLY in the platform realm', () => {
    const secretKeys = PLATFORM_PERMISSIONS.filter((k) => k.includes('secret'));
    expect(secretKeys).toEqual(['platform:secrets:manage']);
  });

  it('PHASE_1_TENANT_PERMISSIONS are all real tenant keys', () => {
    for (const k of PHASE_1_TENANT_PERMISSIONS) {
      expect(isPermissionKey(k), k).toBe(true);
      expect(PERMISSION_GROUP_OF[k]).toBeTruthy();
    }
  });

  it('isPermissionKey / isPlatformPermissionKey recognise their realm only', () => {
    expect(isPermissionKey('pos:sell')).toBe(true);
    expect(isPermissionKey('z_report:close')).toBe(true);
    expect(isPermissionKey('pos:launch_nukes')).toBe(false);
    expect(isPermissionKey('platform:secrets:manage')).toBe(false);
    expect(isPlatformPermissionKey('platform:secrets:manage')).toBe(true);
    expect(isPlatformPermissionKey('users:manage')).toBe(false);
  });

  it('exposes the finance + cash-register groups added in v0.3', () => {
    expect(PERMISSIONS.finance).toContain('financial_reports:view');
    expect(PERMISSIONS.cashRegister).toContain('z_report:close');
  });

  // ── task 3.1 — HG3-PERMISSION-STABILITY ──────────────────────────────────
  it('adds ONLY platform:catalog_capability:manage (task 3.1), step-up-gated', () => {
    expect(PLATFORM_PERMISSIONS).toContain('platform:catalog_capability:manage');
    expect(isPlatformPermissionKey('platform:catalog_capability:manage')).toBe(true);
    expect(requiresStepUp('platform:catalog_capability:manage')).toBe(true);
    // it is distinct from the entitlement permission (delegable independently)
    expect('platform:catalog_capability:manage').not.toBe('platform:entitlements:manage');
  });

  it('task 3.3 (typed attributes) adds NO permission key — attributes reuse catalog:manage', () => {
    // the whole registry is unchanged from task 3.2 for the tenant realm
    expect(ALL_PERMISSIONS.filter((k) => k.includes('attribute'))).toEqual([]);
    expect(PERMISSION_GROUP_OF['catalog:manage']).toBe('catalog');
  });

  it('task 3.4 activates the ALREADY-RESERVED variants:manage key — no new/duplicate key', () => {
    expect([...PHASE_3_4_TENANT_PERMISSIONS]).toEqual(['variants:manage']);
    // it is a real, well-formed, long-standing catalog-group key (not invented)
    expect(isPermissionKey('variants:manage')).toBe(true);
    expect(PERMISSION_GROUP_OF['variants:manage']).toBe('catalog');
    // exactly one occurrence — no second semantically-equal variant permission
    expect(ALL_PERMISSIONS.filter((k) => k === 'variants:manage')).toHaveLength(1);
    expect(ALL_PERMISSIONS.filter((k) => k.includes('variant'))).toEqual(['variants:manage']);
    // catalog capability (task 3.1) is the fine gate — not an entitlement module,
    // and a variant edit is not money/permission/secret → no step-up
    expect(MODULE_OF_PERMISSION['variants:manage']).toBeUndefined();
    expect(requiresStepUp('variants:manage')).toBe(false);
  });

  // ── task 3.2 — HG3-PERMISSION-STABILITY ─────────────────────────────────
  it('task 3.2 activates ONLY the existing catalog:view / catalog:manage keys', () => {
    expect([...PHASE_3_2_TENANT_PERMISSIONS]).toEqual(['catalog:view', 'catalog:manage']);
    for (const k of PHASE_3_2_TENANT_PERMISSIONS) {
      expect(isPermissionKey(k), k).toBe(true);
      expect(PERMISSION_GROUP_OF[k]).toBe('catalog');
    }
    // catalog is a FOUNDATION module — not entitlement-gated (E.1). The per-
    // strategy production_bom / custom_composition check lives in the service.
    expect(MODULE_OF_PERMISSION['catalog:view']).toBeUndefined();
    expect(MODULE_OF_PERMISSION['catalog:manage']).toBeUndefined();
    // catalog writes are not money / permission / secret — no step-up (owner)
    expect(requiresStepUp('catalog:manage')).toBe(false);
    expect(requiresStepUp('catalog:view')).toBe(false);
  });

  it('identifiers:manage stays the one canonical key, in the inventory group (D2-6)', () => {
    const occurrences = ALL_PERMISSIONS.filter((k) => k === 'identifiers:manage');
    expect(occurrences).toHaveLength(1);
    expect(PERMISSION_GROUP_OF['identifiers:manage']).toBe('inventory');
    // no second, semantically-equivalent identifier key was introduced
    expect(ALL_PERMISSIONS.filter((k) => k.includes('identifier'))).toEqual(['identifiers:manage']);
  });

  // ── task 3.5 — HG3-PERMISSION-STABILITY ─────────────────────────────────
  it('task 3.5 activates ONLY the existing identifiers:manage key, unmoved', () => {
    expect([...PHASE_3_5_TENANT_PERMISSIONS]).toEqual(['identifiers:manage']);
    for (const k of PHASE_3_5_TENANT_PERMISSIONS) {
      expect(isPermissionKey(k), k).toBe(true);
      // still in `inventory` (display metadata) — NOT moved to `catalog` (D2-6 / I.5)
      expect(PERMISSION_GROUP_OF[k]).toBe('inventory');
      // not entitlement-gated (the `identifiers.barcode_qr` capability is the
      // fine gate, checked in the service — it needs no module)
      expect(MODULE_OF_PERMISSION[k]).toBeUndefined();
      // an identifier write is not money / permission / secret / attribution
      expect(requiresStepUp(k)).toBe(false);
    }
  });

  // ── task 3.7 — HG3-PERMISSION-STABILITY ─────────────────────────────────
  it('task 3.7 activates ONLY the existing pricing:manage key, unmoved', () => {
    expect([...PHASE_3_7_TENANT_PERMISSIONS]).toEqual(['pricing:manage']);
    expect(isPermissionKey('pricing:manage')).toBe(true);
    // a long-standing catalog-group key — not invented, not duplicated
    expect(PERMISSION_GROUP_OF['pricing:manage']).toBe('catalog');
    expect(ALL_PERMISSIONS.filter((k) => k === 'pricing:manage')).toHaveLength(1);
    // no `company_pricing` capability, no `MODULE_OF_PERMISSION` entry (catalog
    // is a foundation module), and a price is catalog config → no step-up (D-9)
    expect(MODULE_OF_PERMISSION['pricing:manage']).toBeUndefined();
    expect(requiresStepUp('pricing:manage')).toBe(false);
  });

  // ── task 3.8 — HG3-PERMISSION-STABILITY ─────────────────────────────────
  it('task 3.8 activates ONLY the existing branch_price:manage key, unmoved', () => {
    expect([...PHASE_3_8_TENANT_PERMISSIONS]).toEqual(['branch_price:manage']);
    expect(isPermissionKey('branch_price:manage')).toBe(true);
    // a long-standing catalog-group key — not invented, not duplicated / renamed
    expect(PERMISSION_GROUP_OF['branch_price:manage']).toBe('catalog');
    expect(ALL_PERMISSIONS.filter((k) => k === 'branch_price:manage')).toHaveLength(1);
    // no separate `branch_availability` key/capability; catalog is a foundation
    // module (no `MODULE_OF_PERMISSION` entry); a branch price is catalog config
    // → not step-up (BD-12)
    expect(MODULE_OF_PERMISSION['branch_price:manage']).toBeUndefined();
    expect(requiresStepUp('branch_price:manage')).toBe(false);
    expect(isPermissionKey('branch_availability:manage')).toBe(false);
  });
});

describe('step-up', () => {
  it('gates the Phase 1 sensitive keys', () => {
    expect(requiresStepUp('users:manage')).toBe(true);
    expect(requiresStepUp('roles:manage')).toBe(true);
    expect(requiresStepUp('platform:secrets:manage')).toBe(true);
    expect(requiresStepUp('platform:tenants:impersonate')).toBe(true);
    expect(requiresStepUp('users:view')).toBe(false);
    expect(requiresStepUp('audit:view')).toBe(false);
  });
  it('never gates a plain read', () => {
    for (const k of STEP_UP_PERMISSIONS) expect(k).not.toMatch(/:(view|list)$/);
  });
});

describe('resolveEffectivePermissions', () => {
  const grants = (
    ...gs: [string, 'ALLOW' | 'DENY'][]
  ): readonly (readonly [string, 'ALLOW' | 'DENY'])[] => gs;

  it('unions role permissions', () => {
    const eff = resolveEffectivePermissions({
      rolePermissions: ['users:view', 'roles:manage'],
      directGrants: [],
    });
    expect([...eff].sort()).toEqual(['roles:manage', 'users:view']);
  });

  it('a direct ALLOW adds a key', () => {
    const eff = resolveEffectivePermissions({
      rolePermissions: ['users:view'],
      directGrants: grants(['audit:view', 'ALLOW']),
    });
    expect(eff.has('audit:view')).toBe(true);
  });

  it('DENY always wins — over a role and over an ALLOW', () => {
    const eff = resolveEffectivePermissions({
      rolePermissions: ['users:manage', 'users:view'],
      directGrants: grants(['users:manage', 'DENY'], ['users:view', 'ALLOW']),
    });
    expect(eff.has('users:manage')).toBe(false);
    expect(eff.has('users:view')).toBe(true);
  });

  it('drops a permission whose module is not entitled', () => {
    const eff = resolveEffectivePermissions({
      rolePermissions: ['users:view', 'customer_web:manage', 'recipe:manage'],
      directGrants: [],
      entitledModules: new Set(['customer_web']),
    });
    expect(eff.has('customer_web:manage')).toBe(true); // entitled
    expect(eff.has('recipe:manage')).toBe(false); // production_bom not entitled
    expect(eff.has('users:view')).toBe(true); // foundation key — no module gate
  });

  it('null entitledModules disables the filter (platform realm)', () => {
    const eff = resolveEffectivePermissions({
      rolePermissions: ['recipe:manage'],
      directGrants: [],
      entitledModules: null,
    });
    expect(eff.has('recipe:manage')).toBe(true);
  });
});
