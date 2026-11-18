/**
 * F-7b (PROPOSED, inert) — the scope ceiling for a TENANT-realm staff invitation (the pilot Owner inviting a cashier). The inviter's own data
 * scope comes from the authenticated session (never the request, rule 5); the requested company / branch ids must all lie inside it. A
 * platform-realm operator has no ceiling (they act for the whole workspace) and does not call this. The repository separately proves every id
 * belongs to the workspace.
 */
export interface ActorScope {
  /** `'ALL'` or the explicit company ids the inviter may act on */
  readonly companyScope: 'ALL' | readonly string[];
  readonly branchScope: 'ALL' | readonly string[];
}

export class ScopeExceedsActorError extends Error {
  readonly code = 'SCOPE_EXCEEDS_ACTOR';
  readonly status = 403;
  constructor() {
    super('SCOPE_EXCEEDS_ACTOR: you cannot grant access beyond your own');
  }
}

const within = (allowed: 'ALL' | readonly string[], wanted: readonly string[]): boolean => {
  if (allowed === 'ALL') return true;
  const set = new Set(allowed.map((x) => x.toLowerCase()));
  return wanted.every((x) => set.has(x.toLowerCase()));
};

export function assertScopeWithin(
  actor: ActorScope,
  requested: { companyIds: readonly string[]; branchIds: readonly string[] },
): void {
  if (
    !within(actor.companyScope, requested.companyIds) ||
    !within(actor.branchScope, requested.branchIds)
  ) {
    throw new ScopeExceedsActorError();
  }
}
