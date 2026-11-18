import type { MeAccess, OrgBranchRow, OrgCompanyRow } from '@flower/api-client';

/**
 * Which company and branch is this till selling for? Scope comes from the SERVER (`/me/access`); the client never invents one. A scoped
 * cashier has exactly the ids they are assigned; an unrestricted account (Owner) chooses among the organisation's lists. The choice is only a
 * preference — every request still names the company and branch as scoped path parameters and the API verifies them against the session.
 */

export interface PosContext {
  companyId: string;
  branchId: string;
  companyName: string | null;
  branchName: string | null;
  /** can this session sell at all (orders:manage)? */
  canSell: boolean;
  canViewSales: boolean;
  canCreateCustomer: boolean;
  /** may this session open a customer's account (customers:view + receivables:view)? a UI hint — the server enforces it again */
  canViewAccounts: boolean;
  /** may this session collect a payment on a customer's account (receivables:collect, and be able to see the account)? a UI hint */
  canCollect: boolean;
  /** the accounts that may pick another branch (an unrestricted or multi-branch scope) */
  branchChoices: { id: string; name: string | null }[];
}

export type ContextRefusal = 'NO_SELL_PERMISSION' | 'NO_COMPANY_SCOPE' | 'NO_BRANCH_SCOPE';

export type ContextResult =
  { ok: true; context: PosContext } | { ok: false; reason: ContextRefusal };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveContext(
  access: MeAccess,
  orgCompanies: readonly OrgCompanyRow[] | null,
  orgBranches: readonly OrgBranchRow[] | null,
  preferredBranchId: string | null,
): ContextResult {
  const perms = new Set(access.permissions);
  if (!perms.has('orders:manage')) return { ok: false, reason: 'NO_SELL_PERMISSION' };

  const branchNames = new Map((orgBranches ?? []).map((b) => [b.id, b.name]));
  const companyOfBranch = new Map((orgBranches ?? []).map((b) => [b.id, b.companyId]));

  // company
  let companyId: string | null = null;
  if (access.companyScope !== 'ALL') {
    companyId = access.companyScope.find((c) => UUID.test(c)) ?? null;
  } else {
    companyId = orgCompanies?.[0]?.id ?? null;
  }

  // branch candidates (within the company when the org list says so)
  let candidates: string[];
  if (access.branchScope === 'ALL') {
    candidates = (orgBranches ?? [])
      .filter((b) => companyId === null || b.companyId === companyId)
      .map((b) => b.id);
  } else {
    candidates = access.branchScope.filter((b) => UUID.test(b));
  }
  if (candidates.length === 0) return { ok: false, reason: 'NO_BRANCH_SCOPE' };

  const branchId =
    preferredBranchId && candidates.includes(preferredBranchId)
      ? preferredBranchId
      : candidates[0]!;

  // a scoped cashier with a branch scope but no company scope list: derive the company from the org list when we have it
  if (companyId === null) companyId = companyOfBranch.get(branchId) ?? null;
  if (companyId === null) return { ok: false, reason: 'NO_COMPANY_SCOPE' };

  const companyName = orgCompanies?.find((c) => c.id === companyId)?.legalNameEn ?? null;
  return {
    ok: true,
    context: {
      companyId,
      branchId,
      companyName,
      branchName: branchNames.get(branchId) ?? null,
      canSell: true,
      canViewSales: perms.has('orders:view'),
      canCreateCustomer: perms.has('customers:manage'),
      canViewAccounts: perms.has('customers:view') && perms.has('receivables:view'),
      canCollect:
        perms.has('customers:view') &&
        perms.has('receivables:view') &&
        perms.has('receivables:collect'),
      branchChoices: candidates.map((id) => ({ id, name: branchNames.get(id) ?? null })),
    },
  };
}
