import { describe, expect, it } from 'vitest';
import {
  AUDITABLE_ACTIONS,
  SECURITY_ACTION_PREFIXES,
  SECURITY_ACTION_EXACT,
  isSecurityEventAction,
  isAuditableAction,
} from './actions.js';

describe('auditable-action registry', () => {
  it('every action is domain-qualified and maps to a resource type', () => {
    for (const [action, meta] of Object.entries(AUDITABLE_ACTIONS)) {
      expect(action, action).toMatch(/^[A-Za-z_]+([.:][A-Za-z_]+)+$/);
      expect(meta.resourceType.length).toBeGreaterThan(0);
    }
  });

  it('security_event membership covers exactly the `security: true` actions', () => {
    for (const [action, meta] of Object.entries(AUDITABLE_ACTIONS)) {
      const matched = isSecurityEventAction(action);
      expect(matched, `${action} security=${meta.security} matched=${matched}`).toBe(meta.security);
    }
  });

  it('ordinary catalog CRUD is NOT a security event; catalog.template_applied is (owner §16 / R-6)', () => {
    expect(SECURITY_ACTION_PREFIXES).not.toContain('catalog.');
    expect(SECURITY_ACTION_EXACT.has('catalog.template_applied')).toBe(true);
    expect(isSecurityEventAction('catalog.template_applied')).toBe(true);
    for (const a of [
      'catalog.category_created',
      'catalog.category_updated',
      'catalog.category_status_changed',
      'catalog.category_deleted',
      'catalog.product_type_created',
      'catalog.product_created',
      'catalog.product_updated',
      'catalog.product_status_changed',
      'catalog.product_deleted',
    ]) {
      expect(isSecurityEventAction(a), a).toBe(false);
    }
    // still covered by the `tenant.` prefix
    expect(isSecurityEventAction('tenant.catalog_capability_changed')).toBe(true);
  });

  it('isAuditableAction is a type guard over the registry', () => {
    expect(isAuditableAction('role.created')).toBe(true);
    expect(isAuditableAction('role.deleted')).toBe(false);
  });
});
