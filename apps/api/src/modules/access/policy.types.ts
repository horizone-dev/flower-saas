import type { ScopeSet } from '../../common/context/index.js';

/** The resource a permission check is about (Phase 1: company + branch axes). */
export interface AccessTarget {
  companyId?: string | null;
  branchId?: string | null;
}

export type Decision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: DenyReason; readonly detail?: string };

export type DenyReason =
  | 'NO_CONTEXT'
  | 'NOT_TENANT_SCOPED'
  | 'MODULE_NOT_ENTITLED'
  | 'MISSING_PERMISSION'
  | 'STEP_UP_REQUIRED'
  | 'COMPANY_OUT_OF_SCOPE'
  | 'BRANCH_OUT_OF_SCOPE';

export const ALLOW: Decision = { allowed: true };
export const deny = (reason: DenyReason, detail?: string): Decision =>
  detail === undefined ? { allowed: false, reason } : { allowed: false, reason, detail };

/**
 * A user's resolved access — the output of `PolicyService.resolveForUser`, cached
 * per session and copied onto the `RequestContext`.
 */
export interface ResolvedAccess {
  readonly userId: string;
  readonly accountType: 'OWNER' | 'USER';
  readonly effectivePermissions: ReadonlySet<string>;
  readonly companyScope: ScopeSet;
  readonly branchScope: ScopeSet;
  /** narrower permission sets in specific branches: branchId -> allowed keys */
  readonly perBranchOverlay: ReadonlyMap<string, ReadonlySet<string>>;
  readonly entitledModules: ReadonlySet<string>;
}

/**
 * The plain, JSON-serialisable form of a `ResolvedAccess` — this is what a session
 * caches (`SessionData['access']`) and the auth guard copies onto the request
 * context. Kept structural (not importing the session type) so both the identity
 * module (at login / token refresh) and the access module (`SessionAccessRefresher`
 * after an RBAC change) produce it the same way.
 */
export interface AccessSnapshot {
  effectivePermissions: string[];
  companyScope: 'ALL' | string[];
  branchScope: 'ALL' | string[];
  perBranchOverlay: Record<string, string[]>;
  entitledModules: string[];
  planKey: string | null;
}

export function toAccessSnapshot(r: ResolvedAccess): AccessSnapshot {
  return {
    effectivePermissions: [...r.effectivePermissions],
    companyScope: r.companyScope === 'ALL' ? 'ALL' : [...r.companyScope],
    branchScope: r.branchScope === 'ALL' ? 'ALL' : [...r.branchScope],
    perBranchOverlay: Object.fromEntries(
      [...r.perBranchOverlay].map(([b, keys]) => [b, [...keys]]),
    ),
    entitledModules: [...r.entitledModules],
    planKey: null,
  };
}
