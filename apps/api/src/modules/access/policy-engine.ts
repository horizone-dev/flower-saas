import { requiresStepUp, MODULE_OF_PERMISSION } from '@flower/permissions';
import type { RequestContext, ScopeSet } from '../../common/context/index.js';
import { ALLOW, deny, type AccessTarget, type Decision } from './policy.types.js';

/**
 * The pure permission decision (SECURITY.md pipeline steps 5–9, condensed). Given
 * a fully-resolved `RequestContext` (permissions + scope + entitlements already
 * on it) plus a permission key and optional target, returns ALLOW or a typed
 * DENY. No I/O — every branch is unit-tested with a truth table.
 *
 * Order matters and mirrors the pipeline: entitlement → permission (+ step-up) →
 * company scope → branch scope. **Deny wins** is already baked into
 * `effectivePermissions` by `resolveEffectivePermissions`.
 */
export class PolicyEngine {
  can(ctx: RequestContext, permissionKey: string, target: AccessTarget = {}): Decision {
    if (ctx.accountType === 'PLATFORM') {
      // platform realm is evaluated by its own guard set, not this engine
      return deny('NOT_TENANT_SCOPED', 'platform realm');
    }
    if (ctx.tenantId === null) return deny('NOT_TENANT_SCOPED');

    // 5 — entitlement
    const mod = MODULE_OF_PERMISSION[permissionKey];
    if (mod !== undefined && !ctx.entitlements.has(mod)) {
      return deny('MODULE_NOT_ENTITLED', mod);
    }

    // 6/7 — permission (deny already applied upstream) + step-up
    if (!ctx.effectivePermissions.has(permissionKey)) {
      // a branch overlay can only *narrow*, so a missing base permission is final
      return deny('MISSING_PERMISSION', permissionKey);
    }
    if (requiresStepUp(permissionKey) && ctx.mfaLevel !== 'STEP_UP') {
      return deny('STEP_UP_REQUIRED', permissionKey);
    }

    // 8 — company scope
    if (target.companyId != null && !inScope(ctx.companyScope, target.companyId)) {
      return deny('COMPANY_OUT_OF_SCOPE', target.companyId);
    }

    // 9 — branch scope (+ per-branch overlay: the key must also be allowed there)
    if (target.branchId != null) {
      if (!inScope(ctx.branchScope, target.branchId)) {
        return deny('BRANCH_OUT_OF_SCOPE', target.branchId);
      }
      const overlay = ctx.perBranchOverlay.get(target.branchId);
      if (overlay && !overlay.has(permissionKey)) {
        return deny('MISSING_PERMISSION', `${permissionKey} @ branch ${target.branchId}`);
      }
    }

    return ALLOW;
  }

  /** For list endpoints: the branch ids the caller may see (or `'ALL'`). */
  visibleBranchScope(ctx: RequestContext): ScopeSet {
    return ctx.branchScope;
  }
}

function inScope(scope: ScopeSet, id: string): boolean {
  return scope === 'ALL' || scope.includes(id);
}
