/**
 * The immutable per-request context (SECURITY.md "Isolation layers" — application
 * layer). Populated **only** from the authenticated session (Phase 1 task 1.4/1.5)
 * — never from a request body / param / header / query. Reading a scope value
 * from a request is an ESLint-banned pattern (`no-scope-from-request`).
 *
 * Phase 1 seed: the shape is fixed here; the fields are filled in by the guard
 * pipeline as those guards land. `tenantId` + `branchScope` are what
 * `ScopedRepository` reads.
 */

export type AccountType = 'OWNER' | 'USER' | 'PLATFORM';
export type MfaLevel = 'NONE' | 'MFA' | 'STEP_UP';

/** `'ALL'` (Owner / platform) or an explicit id allow-list. */
export type ScopeSet = 'ALL' | readonly string[];

export interface RequestContextInit {
  requestId: string;
  ip?: string | null;
  userAgent?: string | null;
  tenantId?: string | null;
  userId?: string | null;
  platformUserId?: string | null;
  sessionId?: string | null;
  accountType?: AccountType | null;
  mfaLevel?: MfaLevel;
  posTerminalId?: string | null;
  deviceId?: string | null;
  companyScope?: ScopeSet;
  branchScope?: ScopeSet;
  effectivePermissions?: Iterable<string>;
  entitlements?: Iterable<string>;
  planKey?: string | null;
  /** set while the request runs inside an impersonated session (OD7) */
  impersonatorPlatformUserId?: string | null;
}

export class RequestContext {
  readonly requestId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  readonly tenantId: string | null;
  readonly userId: string | null;
  readonly platformUserId: string | null;
  readonly sessionId: string | null;
  readonly accountType: AccountType | null;
  readonly mfaLevel: MfaLevel;
  readonly posTerminalId: string | null;
  readonly deviceId: string | null;
  readonly companyScope: ScopeSet;
  readonly branchScope: ScopeSet;
  readonly effectivePermissions: ReadonlySet<string>;
  readonly entitlements: ReadonlySet<string>;
  readonly planKey: string | null;
  readonly impersonatorPlatformUserId: string | null;

  constructor(init: RequestContextInit) {
    this.requestId = init.requestId;
    this.ip = init.ip ?? null;
    this.userAgent = init.userAgent ?? null;
    this.tenantId = init.tenantId ?? null;
    this.userId = init.userId ?? null;
    this.platformUserId = init.platformUserId ?? null;
    this.sessionId = init.sessionId ?? null;
    this.accountType = init.accountType ?? null;
    this.mfaLevel = init.mfaLevel ?? 'NONE';
    this.posTerminalId = init.posTerminalId ?? null;
    this.deviceId = init.deviceId ?? null;
    this.companyScope = normaliseScope(init.companyScope);
    this.branchScope = normaliseScope(init.branchScope);
    this.effectivePermissions = new Set(init.effectivePermissions ?? []);
    this.entitlements = new Set(init.entitlements ?? []);
    this.planKey = init.planKey ?? null;
    this.impersonatorPlatformUserId = init.impersonatorPlatformUserId ?? null;
    Object.freeze(this);
  }

  /** Is this a tenant-realm request with a resolved tenant? */
  get isTenantScoped(): boolean {
    return this.tenantId !== null;
  }

  get isImpersonating(): boolean {
    return this.impersonatorPlatformUserId !== null;
  }

  /** The single branch id when the session is bound to exactly one (sets the
   *  `app.branch_id` GUC); `null` for `ALL` or multi-branch. */
  get singleBranchId(): string | null {
    return this.branchScope !== 'ALL' && this.branchScope.length === 1
      ? (this.branchScope[0] ?? null)
      : null;
  }

  hasPermission(key: string): boolean {
    return this.effectivePermissions.has(key);
  }

  /** A derived context — used by the interceptor to layer session data onto the
   *  bootstrap context. */
  with(patch: Partial<RequestContextInit>): RequestContext {
    return new RequestContext({
      requestId: this.requestId,
      ip: this.ip,
      userAgent: this.userAgent,
      tenantId: this.tenantId,
      userId: this.userId,
      platformUserId: this.platformUserId,
      sessionId: this.sessionId,
      accountType: this.accountType,
      mfaLevel: this.mfaLevel,
      posTerminalId: this.posTerminalId,
      deviceId: this.deviceId,
      companyScope: this.companyScope,
      branchScope: this.branchScope,
      effectivePermissions: this.effectivePermissions,
      entitlements: this.entitlements,
      planKey: this.planKey,
      impersonatorPlatformUserId: this.impersonatorPlatformUserId,
      ...patch,
    });
  }
}

function normaliseScope(scope: ScopeSet | undefined): ScopeSet {
  if (scope === undefined) return [];
  if (scope === 'ALL') return 'ALL';
  return Object.freeze([...scope]);
}
