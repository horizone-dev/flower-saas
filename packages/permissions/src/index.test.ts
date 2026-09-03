import { describe, it, expect } from 'vitest';
import {
  PERMISSIONS,
  ALL_PERMISSIONS,
  isPermissionKey,
  isWellFormedPermissionKey,
} from './index.js';

describe('@flower/permissions registry', () => {
  it('every key is well-formed domain:action[:qualifier]', () => {
    for (const key of ALL_PERMISSIONS) {
      expect(isWellFormedPermissionKey(key), key).toBe(true);
    }
  });

  it('ALL_PERMISSIONS is de-duplicated and sorted', () => {
    expect([...ALL_PERMISSIONS]).toEqual([...ALL_PERMISSIONS].sort());
    expect(new Set(ALL_PERMISSIONS).size).toBe(ALL_PERMISSIONS.length);
  });

  it('has no secret-management key (not a tenant-realm capability)', () => {
    expect(ALL_PERMISSIONS.some((k) => k.includes('secret'))).toBe(false);
  });

  it('isPermissionKey recognises real keys and rejects made-up ones', () => {
    expect(isPermissionKey('pos:sell')).toBe(true);
    expect(isPermissionKey('z_report:close')).toBe(true);
    expect(isPermissionKey('pos:launch_nukes')).toBe(false);
  });

  it('exposes the finance + cash-register groups added in v0.3', () => {
    expect(PERMISSIONS.finance).toContain('financial_reports:view');
    expect(PERMISSIONS.cashRegister).toContain('z_report:close');
  });
});
