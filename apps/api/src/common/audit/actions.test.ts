import { describe, expect, it } from 'vitest';
import { AUDITABLE_ACTIONS, SECURITY_ACTION_PREFIXES, isAuditableAction } from './actions.js';

describe('auditable-action registry', () => {
  it('every action is domain-qualified and maps to a resource type', () => {
    for (const [action, meta] of Object.entries(AUDITABLE_ACTIONS)) {
      expect(action, action).toMatch(/^[A-Za-z_]+([.:][A-Za-z_]+)+$/);
      expect(meta.resourceType.length).toBeGreaterThan(0);
    }
  });

  it('security_event prefixes cover exactly the `security: true` actions', () => {
    for (const [action, meta] of Object.entries(AUDITABLE_ACTIONS)) {
      const matched = SECURITY_ACTION_PREFIXES.some((p) => action.startsWith(p));
      expect(matched, `${action} security=${meta.security} matched=${matched}`).toBe(meta.security);
    }
  });

  it('isAuditableAction is a type guard over the registry', () => {
    expect(isAuditableAction('role.created')).toBe(true);
    expect(isAuditableAction('role.deleted')).toBe(false);
  });
});
