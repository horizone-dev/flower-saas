import {
  healthResponseSchema,
  readinessResponseSchema,
  apiErrorSchema,
  type HealthResponse,
  type ReadinessResponse,
} from '@flower/shared-types';

/**
 * Typed REST client for `/v1`. The health endpoints are validated with zod; the
 * Phase 1 platform surface (below) is hand-written and typed structurally — a
 * later phase replaces it with an OpenAPI-generated surface, keeping this
 * transport (auth header, Idempotency-Key, error envelope).
 */

export interface ApiClientOptions {
  baseUrl: string;
  /** injected so the client never reaches for a global fetch implicitly */
  fetch?: typeof fetch;
  /** returns the current access token, or null when unauthenticated */
  getAccessToken?: () => string | null | Promise<string | null>;
  /** `fetch` credentials mode — `'include'` for the browser refresh-cookie flow */
  credentials?: 'omit' | 'same-origin' | 'include';
  /** headers merged into every request (e.g. `x-auth-transport: cookie`) */
  headers?: Record<string, string>;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly correlationId?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

type Query = Record<string, string | number | boolean | undefined | null>;

interface RequestInitLite {
  method?: string;
  body?: unknown;
  query?: Query;
  idempotencyKey?: string;
}

// ── Phase 1 platform types (structural) ──────────────────────────────────────

export type Realm = 'tenant' | 'platform';

export interface LoginResponse {
  status: 'ok' | 'mfa_required';
  accessToken?: string;
  refreshToken?: string;
  mfaChallenge?: string;
  expiresIn?: number;
}

export interface MeSummary {
  userId: string | null;
  platformUserId: string | null;
  accountType: string | null;
  tenantId: string | null;
  mfaLevel: string;
  isImpersonating: boolean;
}

export interface MeAccess {
  accountType: string | null;
  planKey: string | null;
  entitledModules: string[];
  companyScope: 'ALL' | string[];
  branchScope: 'ALL' | string[];
  permissions: string[];
  perBranchOverlay: Record<string, string[]>;
}

export interface TenantSummary {
  id: string;
  slug: string;
  name: string;
  region: string;
  status: string;
  createdAt: string;
}

export interface TenantDetail extends TenantSummary {
  planVersionId: string | null;
  counts: { companies: number; branches: number; users: number; posTerminals: number };
}

export interface PlanSummary {
  id: string;
  key: string;
  name: string;
  isActive: boolean;
  versions: { id: string; version: number; status: string }[];
}

export interface TenantConfig {
  entitlements: { moduleKey: string; enabled: boolean }[];
  limits: { limitKey: string; value: number; isOverride: boolean }[];
}

export interface RoleRow {
  id: string;
  key: string;
  name: string;
  isSystem: boolean;
  isActive: boolean;
  permissionKeys: string[];
}

export interface TenantUserRow {
  id: string;
  email: string;
  accountType: string;
  status: string;
  roleKeys: string[];
}

export type ScopeSet = 'ALL' | string[];

export interface ResolvedUserAccess {
  accountType: string;
  permissions: string[];
  companyScope: ScopeSet;
  branchScope: ScopeSet;
}

export interface AccessPreview {
  current: { permissions: string[]; companyScope: ScopeSet; branchScope: ScopeSet };
  proposed: { permissions: string[]; companyScope: ScopeSet; branchScope: ScopeSet };
  diff: {
    permissionsAdded: string[];
    permissionsRemoved: string[];
    companyScopeChanged: boolean;
    branchScopeChanged: boolean;
  };
}

export interface ProposedAccess {
  roleIds?: string[];
  grants?: { permissionKey: string; effect: 'ALLOW' | 'DENY' }[];
  scope?: {
    companyScopeAll?: boolean;
    companyIds?: string[];
    branchScopeAll?: boolean;
    branchIds?: string[];
  };
}

export interface SessionSummary {
  sessionId: string;
  userId: string | null;
  posTerminalId: string | null;
  mfaLevel: string;
  createdAt: number;
  expiresAt: number;
  impersonated: boolean;
}

export interface AuditRow {
  id: string;
  at: string;
  tenantId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorUserId: string | null;
  actorPlatformUserId: string | null;
  actorAccountType: string;
  impersonatorPlatformUserId: string | null;
  reason: string | null;
}

export interface AuditPage {
  rows: AuditRow[];
  nextBefore: string | null;
}

export interface AuditFilter {
  tenantId?: string;
  actorId?: string;
  action?: string;
  from?: string;
  to?: string;
  before?: string;
  limit?: number;
}

export interface CredentialView {
  id: string;
  provider: string;
  mode: string;
  status: string;
  version: number;
  companyId: string | null;
  branchId: string | null;
  secretMask: string;
  nonSecretConfig: Record<string, unknown>;
  updatedAt: string;
}

export interface ImpersonationResponse {
  accessToken: string;
  banner: boolean;
  expiresIn: number;
}

export interface ProvisionTenantInput {
  slug: string;
  name: string;
  region: string;
  planVersionId: string;
  ownerEmail: string;
  companyLegalNameEn?: string;
  branchName?: string;
}

export interface ProvisionTenantResponse {
  tenantId: string;
  companyId: string;
  branchId: string;
  posTerminalId: string;
  ownerUserId: string;
  setPasswordToken: string;
}

// ── client ──────────────────────────────────────────────────────────────────

export class ApiClient {
  private readonly baseUrl: string;
  private readonly doFetch: typeof fetch;
  private readonly getAccessToken: () => string | null | Promise<string | null>;
  private readonly credentials: 'omit' | 'same-origin' | 'include' | undefined;
  private readonly defaultHeaders: Record<string, string>;

  constructor(opts: ApiClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    const f = opts.fetch ?? globalThis.fetch;
    if (!f) throw new Error('No fetch implementation available; pass one via options');
    this.doFetch = f;
    this.getAccessToken = opts.getAccessToken ?? (() => null);
    this.credentials = opts.credentials;
    this.defaultHeaders = { ...opts.headers };
  }

  private qs(query?: Query): string {
    if (!query) return '';
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
      if (v !== undefined && v !== null) p.set(k, String(v));
    }
    const s = p.toString();
    return s ? `?${s}` : '';
  }

  private async call<T>(
    path: string,
    init: RequestInitLite,
    parse: (raw: unknown) => T,
  ): Promise<T> {
    const token = await this.getAccessToken();
    const headers: Record<string, string> = { accept: 'application/json', ...this.defaultHeaders };
    if (token) headers['authorization'] = `Bearer ${token}`;
    if (init.body !== undefined) headers['content-type'] = 'application/json';
    if (init.idempotencyKey) headers['idempotency-key'] = init.idempotencyKey;

    const res = await this.doFetch(`${this.baseUrl}${path}${this.qs(init.query)}`, {
      method: init.method ?? 'GET',
      headers,
      ...(this.credentials ? { credentials: this.credentials } : {}),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const body: unknown = await res.json().catch(() => undefined);

    if (!res.ok) {
      const err = apiErrorSchema.safeParse(body);
      if (err.success) {
        throw new ApiError(
          res.status,
          err.data.error.code,
          err.data.error.message,
          err.data.error.correlationId,
        );
      }
      throw new ApiError(res.status, 'UNKNOWN', `Request failed with ${res.status}`);
    }
    return parse(body);
  }

  private get<T>(path: string, query?: Query): Promise<T> {
    return this.call<T>(path, { query: query ?? {} }, (raw) => raw as T);
  }
  private send<T>(
    method: string,
    path: string,
    body?: unknown,
    idempotencyKey?: string,
  ): Promise<T> {
    return this.call<T>(
      path,
      idempotencyKey !== undefined ? { method, body, idempotencyKey } : { method, body },
      (raw) => raw as T,
    );
  }

  // ── health (validated) ────────────────────────────────────────────────────
  health(): Promise<HealthResponse> {
    return this.call('/healthz', {}, (raw) => healthResponseSchema.parse(raw));
  }
  readiness(): Promise<ReadinessResponse> {
    return this.call('/readyz', {}, (raw) => readinessResponseSchema.parse(raw));
  }

  // ── auth ──────────────────────────────────────────────────────────────────
  platformLogin(input: { email: string; password: string; code?: string }): Promise<LoginResponse> {
    return this.send('POST', '/v1/platform/auth/login', input);
  }
  tenantLogin(input: {
    workspaceSlug: string;
    email: string;
    password: string;
  }): Promise<LoginResponse> {
    return this.send('POST', '/v1/auth/login', input);
  }
  verifyMfa(input: { mfaChallenge: string; code: string }): Promise<LoginResponse> {
    return this.send('POST', '/v1/auth/mfa/verify', input);
  }
  /** Omit `refreshToken` to use the HttpOnly refresh cookie (browser clients). */
  refresh(refreshToken?: string): Promise<LoginResponse> {
    return this.send('POST', '/v1/auth/refresh', refreshToken ? { refreshToken } : {});
  }
  logout(): Promise<{ status: string }> {
    return this.send('POST', '/v1/auth/logout', {});
  }
  me(): Promise<MeSummary> {
    return this.get('/v1/me');
  }
  meAccess(): Promise<MeAccess> {
    return this.get('/v1/me/access');
  }

  // ── tenants + lifecycle ───────────────────────────────────────────────────
  listTenants(): Promise<TenantSummary[]> {
    return this.get('/v1/platform/tenants');
  }
  getTenant(tenantId: string): Promise<TenantDetail> {
    return this.get(`/v1/platform/tenants/${tenantId}`);
  }
  provisionTenant(
    input: ProvisionTenantInput,
    idempotencyKey: string,
  ): Promise<ProvisionTenantResponse> {
    return this.send('POST', '/v1/platform/tenants', input, idempotencyKey);
  }
  tenantLifecycle(
    tenantId: string,
    action: 'suspend' | 'resume' | 'terminate',
    reason?: string,
  ): Promise<{ status: string }> {
    return this.send(
      'POST',
      `/v1/platform/tenants/${tenantId}/${action}`,
      reason !== undefined ? { reason } : {},
    );
  }

  // ── plans / entitlements / limits ─────────────────────────────────────────
  listPlans(): Promise<PlanSummary[]> {
    return this.get('/v1/platform/plans');
  }
  createPlan(input: { key: string; name: string; description?: string }): Promise<{ id: string }> {
    return this.send('POST', '/v1/platform/plans', input);
  }
  createPlanVersion(
    planId: string,
    input: {
      version: number;
      entitlements?: { moduleKey: string; enabled: boolean }[];
      limits?: { limitKey: string; value: number }[];
    },
  ): Promise<{ id: string }> {
    return this.send('POST', `/v1/platform/plans/${planId}/versions`, input);
  }
  publishPlanVersion(planVersionId: string): Promise<unknown> {
    return this.send('POST', `/v1/platform/plans/versions/${planVersionId}/publish`);
  }
  setPlanEntitlement(
    planVersionId: string,
    moduleKey: string,
    enabled: boolean,
  ): Promise<{ status: string }> {
    return this.send('PUT', `/v1/platform/plans/versions/${planVersionId}/entitlements`, {
      moduleKey,
      enabled,
    });
  }
  setPlanLimit(
    planVersionId: string,
    limitKey: string,
    value: number,
  ): Promise<{ status: string }> {
    return this.send('PUT', `/v1/platform/plans/versions/${planVersionId}/limits`, {
      limitKey,
      value,
    });
  }

  getTenantConfig(tenantId: string): Promise<TenantConfig> {
    return this.get(`/v1/platform/tenants/${tenantId}/config`);
  }
  overrideTenantLimit(
    tenantId: string,
    limitKey: string,
    value: number,
    reason: string,
  ): Promise<{ status: string }> {
    return this.send('PUT', `/v1/platform/tenants/${tenantId}/limits/${limitKey}`, {
      value,
      reason,
    });
  }
  overrideTenantEntitlement(
    tenantId: string,
    moduleKey: string,
    enabled: boolean,
  ): Promise<{ status: string }> {
    return this.send('PUT', `/v1/platform/tenants/${tenantId}/entitlements`, {
      moduleKey,
      enabled,
    });
  }

  // ── tenant RBAC (platform realm) ──────────────────────────────────────────
  listTenantRoles(tenantId: string): Promise<RoleRow[]> {
    return this.get(`/v1/platform/tenants/${tenantId}/roles`);
  }
  createTenantRole(
    tenantId: string,
    input: { key: string; name: string; permissionKeys: string[] },
  ): Promise<{ id: string }> {
    return this.send('POST', `/v1/platform/tenants/${tenantId}/roles`, input);
  }
  setTenantRolePermissions(
    tenantId: string,
    roleId: string,
    permissionKeys: string[],
  ): Promise<{ status: string }> {
    return this.send('PUT', `/v1/platform/tenants/${tenantId}/roles/${roleId}/permissions`, {
      permissionKeys,
    });
  }
  listTenantUsers(tenantId: string): Promise<TenantUserRow[]> {
    return this.get(`/v1/platform/tenants/${tenantId}/users`);
  }
  getTenantUser(tenantId: string, userId: string): Promise<ResolvedUserAccess> {
    return this.get(`/v1/platform/tenants/${tenantId}/users/${userId}`);
  }
  setTenantUserRoles(
    tenantId: string,
    userId: string,
    roleIds: string[],
  ): Promise<{ status: string }> {
    return this.send('PUT', `/v1/platform/tenants/${tenantId}/users/${userId}/roles`, { roleIds });
  }
  setTenantUserGrants(
    tenantId: string,
    userId: string,
    grants: { permissionKey: string; effect: 'ALLOW' | 'DENY'; reason: string }[],
  ): Promise<{ status: string }> {
    return this.send('PUT', `/v1/platform/tenants/${tenantId}/users/${userId}/grants`, { grants });
  }
  setTenantUserScope(
    tenantId: string,
    userId: string,
    scope: {
      companyScopeAll: boolean;
      companyIds: string[];
      branchScopeAll: boolean;
      branchIds: string[];
    },
  ): Promise<{ status: string }> {
    return this.send('PUT', `/v1/platform/tenants/${tenantId}/users/${userId}/scope`, scope);
  }
  previewTenantUserAccess(
    tenantId: string,
    userId: string,
    proposed: ProposedAccess,
  ): Promise<AccessPreview> {
    return this.send(
      'POST',
      `/v1/platform/tenants/${tenantId}/users/${userId}/access-preview`,
      proposed,
    );
  }

  // ── sessions ──────────────────────────────────────────────────────────────
  listTenantSessions(tenantId: string): Promise<SessionSummary[]> {
    return this.get(`/v1/platform/tenants/${tenantId}/sessions`);
  }
  revokeTenantSession(tenantId: string, sessionId: string): Promise<{ status: string }> {
    return this.send('DELETE', `/v1/platform/tenants/${tenantId}/sessions/${sessionId}`);
  }

  // ── audit viewer ──────────────────────────────────────────────────────────
  queryAudit(filter: AuditFilter = {}): Promise<AuditPage> {
    return this.get('/v1/platform/audit', { ...filter });
  }

  // ── impersonation (read-only, time-boxed — OD7) ───────────────────────────
  startImpersonation(tenantId: string, reason: string): Promise<ImpersonationResponse> {
    return this.send('POST', `/v1/platform/tenants/${tenantId}/impersonate`, { reason });
  }
  endImpersonation(): Promise<{ status: string }> {
    return this.send('DELETE', '/v1/me/impersonation');
  }

  // ── provider credentials (secrets vault shell) ────────────────────────────
  listProviderCredentials(tenantId: string): Promise<CredentialView[]> {
    return this.get(`/v1/platform/tenants/${tenantId}/provider-credentials`);
  }
  getProviderCredential(tenantId: string, id: string): Promise<CredentialView> {
    return this.get(`/v1/platform/tenants/${tenantId}/provider-credentials/${id}`);
  }
  createProviderCredential(
    tenantId: string,
    input: {
      provider: string;
      mode: 'TEST' | 'LIVE';
      secret: string;
      nonSecretConfig?: Record<string, unknown>;
    },
  ): Promise<CredentialView> {
    return this.send('POST', `/v1/platform/tenants/${tenantId}/provider-credentials`, input);
  }
  rotateProviderCredential(
    tenantId: string,
    id: string,
    input: { secret: string; nonSecretConfig?: Record<string, unknown> },
  ): Promise<CredentialView> {
    return this.send('PUT', `/v1/platform/tenants/${tenantId}/provider-credentials/${id}`, input);
  }
  revokeProviderCredential(tenantId: string, id: string): Promise<{ status: string }> {
    return this.send('DELETE', `/v1/platform/tenants/${tenantId}/provider-credentials/${id}`);
  }
}

export function createApiClient(opts: ApiClientOptions): ApiClient {
  return new ApiClient(opts);
}
