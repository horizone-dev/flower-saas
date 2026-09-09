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
      // task 3.3 — typed attributes
      'catalog.attribute_definition_created',
      'catalog.attribute_definition_updated',
      'catalog.attribute_definition_status_changed',
      'catalog.attribute_definition_deleted',
      'catalog.attribute_option_set_changed',
      'catalog.product_attributes_changed',
      // task 3.4 — variants + option groups
      'catalog.option_group_created',
      'catalog.option_group_updated',
      'catalog.option_group_deleted',
      'catalog.option_value_set_changed',
      'catalog.variant_created',
      'catalog.variant_updated',
      'catalog.variant_status_changed',
      // task 3.5 — identifiers (SKU / barcode / QR)
      'catalog.identifier_created',
      'catalog.identifier_deactivated',
      'catalog.identifier_reactivated',
      'catalog.identifier_deleted',
      // task 3.6 — UOM registry + pack conversions
      'catalog.uom_created',
      'catalog.uom_updated',
      'catalog.uom_deleted',
      'catalog.variant_base_uom_set',
      'catalog.variant_conversions_changed',
      'catalog.product_conversions_changed',
      // task 3.7 — company per-UOM sale pricing
      'catalog.company_price_changed',
      // task 3.8 — branch price override + branch availability
      'catalog.branch_price_changed',
      'catalog.branch_availability_changed',
      // task 3.9 — catalog tax-category assignment
      'catalog.product_tax_category_changed',
      'catalog.variant_tax_category_changed',
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
