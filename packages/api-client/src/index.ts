import {
  healthResponseSchema,
  readinessResponseSchema,
  apiErrorSchema,
  type HealthResponse,
  type ReadinessResponse,
  type CompanyPriceEntry,
  type CompanyVariantPriceSetView,
  type ResolvedCompanyPrice,
} from '@flower/shared-types';

export type {
  MoneyDto,
  CompanyPriceEntry,
  CompanyPriceRowView,
  CompanyVariantPriceSetView,
  CompanyPriceResolveReason,
  ResolvedCompanyPrice,
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
  /** optimistic-concurrency precondition (ETag-style) */
  ifMatch?: string;
  /** surface the response ETag to the caller */
  onEtag?: (etag: string | null) => void;
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
  /** the company's legal-entity country (ISO 3166-1 alpha-2) — the fiscal
   *  source of truth (task 2.7, architecture correction 4). Deliberately
   *  independent of `region`, never derived from it. */
  companyCountryCode: string;
  /** Business-Type preset — REQUIRED (task 3.1 / owner §1). A
   *  `business_type_template.key` (see `listBusinessTypeTemplates`). If no
   *  curated preset fits, pass `"CUSTOM"`. */
  businessTypeKey: string;
  planVersionId: string;
  ownerEmail: string;
  companyLegalNameEn?: string;
  branchName?: string;
}

// ── catalog capability & Business-Type templates (task 3.1) ──────────────────

export interface BusinessTypeTemplateCapabilityRow {
  capabilityKey: string;
  enabled: boolean;
  config: unknown;
}
export interface BusinessTypeTemplateSummary {
  key: string;
  version: number;
  nameEn: string;
  nameAr: string;
  status: 'ACTIVE' | 'DEPRECATED';
  capabilities: BusinessTypeTemplateCapabilityRow[];
}
export interface TenantCatalogCapabilityRow {
  capabilityKey: string;
  enabled: boolean;
  config: unknown;
  sourceKind: 'TEMPLATE' | 'MANUAL' | null;
  sourceTemplateKey: string | null;
  sourceTemplateVersion: number | null;
  overriddenAt: string | null;
  requiredEntitlement: string | null;
  /** true iff `requiredEntitlement` is set AND the tenant is not entitled */
  inert: boolean;
}
export interface TenantCatalogCapabilityState {
  tenantId: string;
  businessTypeKey: string | null;
  businessTypeAppliedVersion: number | null;
  businessTypeAppliedAt: string | null;
  aggregateVersion: number;
  capabilities: TenantCatalogCapabilityRow[];
}
export interface CatalogCapabilityChange {
  capabilityKey: string;
  enabled: boolean;
  config?: unknown;
}

// ── generic catalog core (task 3.2) ─────────────────────────────────────────
export type FulfilmentStrategy = 'STOCKED' | 'BOM' | 'CUSTOM';

export interface CategoryRow {
  id: string;
  parentId: string | null;
  slug: string;
  nameEn: string;
  nameAr: string | null;
  sortOrder: number;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface ProductTypeRow {
  id: string;
  key: string;
  nameEn: string;
  nameAr: string | null;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface ProductRow {
  id: string;
  categoryId: string;
  productTypeId: string | null;
  slug: string;
  nameEn: string;
  nameAr: string | null;
  description: string | null;
  fulfilmentStrategy: FulfilmentStrategy;
  hidePrice: boolean;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface ProductPage {
  data: ProductRow[];
  nextCursor: string | null;
  hasNextPage: boolean;
}
export interface CategoryCreateInput {
  parentId?: string | null;
  slug?: string;
  nameEn: string;
  nameAr?: string | null;
  sortOrder?: number;
}
export interface CategoryUpdateInput {
  parentId?: string | null;
  slug?: string;
  nameEn?: string;
  nameAr?: string | null;
  sortOrder?: number;
}
export interface ProductCreateInput {
  categoryId: string;
  productTypeId?: string | null;
  slug?: string;
  nameEn: string;
  nameAr?: string | null;
  description?: string | null;
  fulfilmentStrategy: FulfilmentStrategy;
  hidePrice?: boolean;
}
export interface ProductUpdateInput {
  categoryId?: string;
  productTypeId?: string | null;
  slug?: string;
  nameEn?: string;
  nameAr?: string | null;
  description?: string | null;
  hidePrice?: boolean;
  /** only honoured while the product is a DRAFT */
  fulfilmentStrategy?: FulfilmentStrategy;
}

// ── typed attributes (task 3.3) ─────────────────────────────────────────────
export type AttributeValueType = 'TEXT' | 'NUMBER' | 'ENUM' | 'BOOLEAN' | 'DATE';

export interface AttributeOptionRow {
  id: string;
  value: string;
  labelEn: string;
  labelAr: string | null;
  sortOrder: number;
}
export interface AttributeDefinitionRow {
  id: string;
  key: string;
  nameEn: string;
  nameAr: string | null;
  valueType: AttributeValueType;
  appliesToCategoryId: string | null;
  appliesToProductTypeId: string | null;
  unitHint: string | null;
  isVariantOption: boolean;
  required: boolean;
  status: 'ACTIVE' | 'ARCHIVED';
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface AttributeDefinitionWithOptions extends AttributeDefinitionRow {
  options: AttributeOptionRow[];
}
export interface AttributeDefinitionCreateInput {
  key: string;
  nameEn: string;
  nameAr?: string | null;
  valueType: AttributeValueType;
  appliesToCategoryId?: string | null;
  appliesToProductTypeId?: string | null;
  unitHint?: string | null;
  isVariantOption?: boolean;
  required?: boolean;
}
export interface AttributeDefinitionUpdateInput {
  nameEn?: string;
  nameAr?: string | null;
  unitHint?: string | null;
  isVariantOption?: boolean;
  required?: boolean;
  appliesToCategoryId?: string | null;
  appliesToProductTypeId?: string | null;
}
export interface AttributeOptionInput {
  value: string;
  labelEn: string;
  labelAr?: string | null;
  sortOrder?: number;
}
export interface ProductAttributeValueRow {
  attributeDefinitionId: string;
  key: string;
  valueType: AttributeValueType;
  valueText: string | null;
  valueNumber: string | null;
  valueBool: boolean | null;
  valueDate: string | null;
  optionId: string | null;
}
export interface ProductAttributeSet {
  productVersion: number;
  values: ProductAttributeValueRow[];
}
export interface ProductAttributeInput {
  attributeDefinitionId: string;
  valueText?: string | null;
  valueNumber?: string | null;
  valueBool?: boolean | null;
  valueDate?: string | null;
  optionId?: string | null;
}

// ── variants + option groups (task 3.4) ─────────────────────────────────────
export type VariantStatus = 'DRAFT' | 'ACTIVE' | 'ARCHIVED';

export interface OptionValueRow {
  id: string;
  value: string;
  labelEn: string;
  labelAr: string | null;
  sortOrder: number;
}
export interface OptionGroupRow {
  id: string;
  productId: string;
  key: string;
  nameEn: string;
  nameAr: string | null;
  sortOrder: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface OptionGroupWithValues extends OptionGroupRow {
  values: OptionValueRow[];
}
export interface OptionGroupCreateInput {
  key: string;
  nameEn: string;
  nameAr?: string | null;
  sortOrder?: number;
}
export interface OptionGroupUpdateInput {
  nameEn?: string;
  nameAr?: string | null;
  sortOrder?: number;
}
export interface OptionValueInput {
  value: string;
  labelEn: string;
  labelAr?: string | null;
  sortOrder?: number;
}
export interface VariantOptionSelectionInput {
  optionGroupId: string;
  optionValueId: string;
}
export interface VariantOptionValueRow {
  optionGroupId: string;
  optionGroupKey: string;
  optionValueId: string;
  optionValue: string;
}
export interface VariantRow {
  id: string;
  productId: string;
  nameEn: string;
  nameAr: string | null;
  sortOrder: number;
  isDefault: boolean;
  optionSignature: string;
  status: VariantStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
}
export interface VariantWithOptions extends VariantRow {
  options: VariantOptionValueRow[];
}
export interface VariantCreateInput {
  optionValues: VariantOptionSelectionInput[];
  nameEn?: string;
  nameAr?: string | null;
  sortOrder?: number;
}
export interface VariantUpdateInput {
  nameEn?: string;
  nameAr?: string | null;
  sortOrder?: number;
  optionValues?: VariantOptionSelectionInput[];
}

// ── identifiers — SKU / barcode / QR (task 3.5) ─────────────────────────────
export type IdentifierCodeType = 'SKU' | 'BARCODE' | 'QR';
export type IdentifierStatus = 'ACTIVE' | 'INACTIVE';

export interface ItemIdentifierRow {
  id: string;
  /** VARIANT only in Phase 3a (INVENTORY_ITEM reserved for Phase 5) */
  targetKind: 'VARIANT';
  targetId: string;
  codeType: IdentifierCodeType;
  value: string;
  status: IdentifierStatus;
  /** task 3.6 — the immutable printed pack-identity snapshot; null unless this
   *  is a BARCODE / QR created with pack metadata */
  packUomCode: string | null;
  packQty: string | null;
  packBaseQty: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface IdentifierCreateInput {
  targetKind: 'VARIANT';
  targetId: string;
  codeType: IdentifierCodeType;
  /** required for SKU / BARCODE; omit for QR (the server generates an opaque
   *  value and rejects a client-supplied one) */
  value?: string;
  /** task 3.6 — BARCODE / QR only; forbidden on a SKU. `packBaseQty` is
   *  computed server-side (exact-or-reject) and is never client-supplied. */
  pack?: { uomCode: string; qty: string };
}

/** the FROZEN pack snapshot returned on a scan resolve (task 3.6 §J) */
export interface IdentifierPackSnapshot {
  uomCode: string;
  qty: string;
  baseUomCode: string;
  baseQty: string;
}

/** the scan-resolve projection — one ACTIVE identifier + its target summary */
export interface IdentifierResolution {
  identifier: ItemIdentifierRow;
  target: { kind: 'VARIANT'; id: string };
  variant: { id: string; productId: string; nameEn: string; status: VariantStatus };
  product: { id: string; slug: string; nameEn: string; status: string };
  /** null when the identifier carries no pack; never recomputed live */
  pack: IdentifierPackSnapshot | null;
}

// ── UOM registry + pack conversions (task 3.6) ──────────────────────────────
export type UomFamily = 'LENGTH' | 'MASS' | 'VOLUME' | 'COUNT' | 'EACH';

export interface UomListEntry {
  code: string;
  family: UomFamily;
  perBaseNum: string;
  perBaseDen: string;
  maxDecimals: number;
  nameEn: string;
  nameAr: string | null;
  /** true for a `@flower/uom` built-in (read-only); false for a tenant unit */
  builtin: boolean;
  /** null for a built-in; the optimistic-concurrency handle for a tenant unit */
  version: number | null;
}

export interface UomCreateInput {
  code: string;
  family: UomFamily;
  perBaseNum?: string;
  perBaseDen?: string;
  maxDecimals?: number;
  nameEn: string;
  nameAr?: string | null;
}

export interface VariantConversionEntry {
  fromUomCode: string;
  num: string;
  den?: string;
}
export interface ProductConversionEntry {
  fromUomCode: string;
  toUomCode: string;
  num: string;
  den?: string;
}
export interface EffectiveConversionRow {
  fromUomCode: string;
  toUomCode: string;
  num: string;
  den: string;
  source: 'VARIANT' | 'PRODUCT';
  inherited: boolean;
}
export interface StoredProductConversionRow {
  id: string;
  fromUomCode: string;
  toUomCode: string;
  num: string;
  den: string;
  appliesToVariantCount: number;
}
export interface VariantConversionsView {
  variantVersion: number;
  baseUomCode: string | null;
  rows: EffectiveConversionRow[];
}
export interface ProductConversionsView {
  productVersion: number;
  rows: StoredProductConversionRow[];
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
    if (init.ifMatch) headers['if-match'] = init.ifMatch;

    const res = await this.doFetch(`${this.baseUrl}${path}${this.qs(init.query)}`, {
      method: init.method ?? 'GET',
      headers,
      ...(this.credentials ? { credentials: this.credentials } : {}),
      ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    init.onEtag?.(res.headers.get('etag'));
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

  // ── catalog capabilities & Business-Type templates (task 3.1) ─────────────
  listBusinessTypeTemplates(): Promise<{ data: BusinessTypeTemplateSummary[] }> {
    return this.get('/v1/platform/business-type-templates');
  }
  getTenantCatalogCapabilities(tenantId: string): Promise<TenantCatalogCapabilityState> {
    return this.get(`/v1/platform/tenants/${tenantId}/catalog-capabilities`);
  }
  /** PATCH a tenant's capability set. `expectedVersion` is the `aggregateVersion`
   *  from the last read (spec §L). A stale value throws `ApiError` 409
   *  `CATALOG_CAPABILITY_VERSION_CONFLICT`. */
  patchTenantCatalogCapabilities(
    tenantId: string,
    changes: CatalogCapabilityChange[],
    expectedVersion: number,
    reason?: string,
  ): Promise<TenantCatalogCapabilityState> {
    return this.call<TenantCatalogCapabilityState>(
      `/v1/platform/tenants/${tenantId}/catalog-capabilities`,
      {
        method: 'PATCH',
        body: reason !== undefined ? { changes, reason } : { changes },
        ifMatch: `"${expectedVersion}"`,
      },
      (raw) => raw as TenantCatalogCapabilityState,
    );
  }
  // ── generic catalog core (task 3.2) — tenant realm ───────────────────────
  // `catalog:view` reads / `catalog:manage` writes. POST → Idempotency-Key;
  // PUT / DELETE → If-Match; activate / archive → BOTH.
  listCategories(query?: {
    status?: 'ACTIVE' | 'ARCHIVED';
    parentId?: string;
    q?: string;
  }): Promise<CategoryRow[]> {
    return this.get('/v1/catalog/categories', query);
  }
  getCategory(id: string): Promise<CategoryRow> {
    return this.get(`/v1/catalog/categories/${id}`);
  }
  createCategory(input: CategoryCreateInput, idempotencyKey: string): Promise<CategoryRow> {
    return this.send('POST', '/v1/catalog/categories', input, idempotencyKey);
  }
  updateCategory(
    id: string,
    input: CategoryUpdateInput,
    expectedVersion: number,
  ): Promise<CategoryRow> {
    return this.call(
      `/v1/catalog/categories/${id}`,
      { method: 'PUT', body: input, ifMatch: `"${expectedVersion}"` },
      (raw) => raw as CategoryRow,
    );
  }
  archiveCategory(
    id: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<CategoryRow> {
    return this.call(
      `/v1/catalog/categories/${id}/archive`,
      { method: 'POST', ifMatch: `"${expectedVersion}"`, idempotencyKey },
      (raw) => raw as CategoryRow,
    );
  }
  activateCategory(
    id: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<CategoryRow> {
    return this.call(
      `/v1/catalog/categories/${id}/activate`,
      { method: 'POST', ifMatch: `"${expectedVersion}"`, idempotencyKey },
      (raw) => raw as CategoryRow,
    );
  }
  deleteCategory(id: string, expectedVersion: number): Promise<{ status: 'deleted' }> {
    return this.call(
      `/v1/catalog/categories/${id}`,
      { method: 'DELETE', ifMatch: `"${expectedVersion}"` },
      (raw) => raw as { status: 'deleted' },
    );
  }

  listProductTypes(query?: {
    status?: 'ACTIVE' | 'ARCHIVED';
    q?: string;
  }): Promise<ProductTypeRow[]> {
    return this.get('/v1/catalog/product-types', query);
  }
  getProductType(id: string): Promise<ProductTypeRow> {
    return this.get(`/v1/catalog/product-types/${id}`);
  }
  createProductType(
    input: { key: string; nameEn: string; nameAr?: string | null },
    idempotencyKey: string,
  ): Promise<ProductTypeRow> {
    return this.send('POST', '/v1/catalog/product-types', input, idempotencyKey);
  }
  updateProductType(
    id: string,
    input: { nameEn?: string; nameAr?: string | null },
    expectedVersion: number,
  ): Promise<ProductTypeRow> {
    return this.call(
      `/v1/catalog/product-types/${id}`,
      { method: 'PUT', body: input, ifMatch: `"${expectedVersion}"` },
      (raw) => raw as ProductTypeRow,
    );
  }
  archiveProductType(
    id: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<ProductTypeRow> {
    return this.call(
      `/v1/catalog/product-types/${id}/archive`,
      { method: 'POST', ifMatch: `"${expectedVersion}"`, idempotencyKey },
      (raw) => raw as ProductTypeRow,
    );
  }
  activateProductType(
    id: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<ProductTypeRow> {
    return this.call(
      `/v1/catalog/product-types/${id}/activate`,
      { method: 'POST', ifMatch: `"${expectedVersion}"`, idempotencyKey },
      (raw) => raw as ProductTypeRow,
    );
  }
  deleteProductType(id: string, expectedVersion: number): Promise<{ status: 'deleted' }> {
    return this.call(
      `/v1/catalog/product-types/${id}`,
      { method: 'DELETE', ifMatch: `"${expectedVersion}"` },
      (raw) => raw as { status: 'deleted' },
    );
  }

  listProducts(query?: {
    status?: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
    categoryId?: string;
    productTypeId?: string;
    fulfilmentStrategy?: FulfilmentStrategy;
    q?: string;
    limit?: number;
    cursor?: string;
  }): Promise<ProductPage> {
    return this.get('/v1/catalog/products', query);
  }
  getProduct(id: string): Promise<ProductRow> {
    return this.get(`/v1/catalog/products/${id}`);
  }
  createProduct(input: ProductCreateInput, idempotencyKey: string): Promise<ProductRow> {
    return this.send('POST', '/v1/catalog/products', input, idempotencyKey);
  }
  updateProduct(
    id: string,
    input: ProductUpdateInput,
    expectedVersion: number,
  ): Promise<ProductRow> {
    return this.call(
      `/v1/catalog/products/${id}`,
      { method: 'PUT', body: input, ifMatch: `"${expectedVersion}"` },
      (raw) => raw as ProductRow,
    );
  }
  activateProduct(
    id: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<ProductRow> {
    return this.call(
      `/v1/catalog/products/${id}/activate`,
      { method: 'POST', ifMatch: `"${expectedVersion}"`, idempotencyKey },
      (raw) => raw as ProductRow,
    );
  }
  archiveProduct(id: string, expectedVersion: number, idempotencyKey: string): Promise<ProductRow> {
    return this.call(
      `/v1/catalog/products/${id}/archive`,
      { method: 'POST', ifMatch: `"${expectedVersion}"`, idempotencyKey },
      (raw) => raw as ProductRow,
    );
  }
  deleteProduct(id: string, expectedVersion: number): Promise<{ status: 'deleted' }> {
    return this.call(
      `/v1/catalog/products/${id}`,
      { method: 'DELETE', ifMatch: `"${expectedVersion}"` },
      (raw) => raw as { status: 'deleted' },
    );
  }

  // ── typed attributes (task 3.3) — catalog:view reads / catalog:manage writes ──
  listAttributeDefinitions(query?: {
    status?: 'ACTIVE' | 'ARCHIVED';
    appliesToCategoryId?: string;
    appliesToProductTypeId?: string;
    valueType?: AttributeValueType;
    isVariantOption?: boolean;
    q?: string;
  }): Promise<AttributeDefinitionRow[]> {
    return this.get('/v1/catalog/attribute-definitions', query);
  }
  getAttributeDefinition(id: string): Promise<AttributeDefinitionWithOptions> {
    return this.get(`/v1/catalog/attribute-definitions/${id}`);
  }
  createAttributeDefinition(
    input: AttributeDefinitionCreateInput,
    idempotencyKey: string,
  ): Promise<AttributeDefinitionWithOptions> {
    return this.send('POST', '/v1/catalog/attribute-definitions', input, idempotencyKey);
  }
  updateAttributeDefinition(
    id: string,
    input: AttributeDefinitionUpdateInput,
    expectedVersion: number,
  ): Promise<AttributeDefinitionWithOptions> {
    return this.call(
      `/v1/catalog/attribute-definitions/${id}`,
      { method: 'PUT', body: input, ifMatch: `"${expectedVersion}"` },
      (raw) => raw as AttributeDefinitionWithOptions,
    );
  }
  /** replace the ENUM option-set (owner K.4); `If-Match` = the definition version */
  setAttributeOptions(
    id: string,
    options: AttributeOptionInput[],
    expectedVersion: number,
  ): Promise<AttributeDefinitionWithOptions> {
    return this.call(
      `/v1/catalog/attribute-definitions/${id}/options`,
      { method: 'PUT', body: { options }, ifMatch: `"${expectedVersion}"` },
      (raw) => raw as AttributeDefinitionWithOptions,
    );
  }
  archiveAttributeDefinition(
    id: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<AttributeDefinitionWithOptions> {
    return this.call(
      `/v1/catalog/attribute-definitions/${id}/archive`,
      { method: 'POST', ifMatch: `"${expectedVersion}"`, idempotencyKey },
      (raw) => raw as AttributeDefinitionWithOptions,
    );
  }
  activateAttributeDefinition(
    id: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<AttributeDefinitionWithOptions> {
    return this.call(
      `/v1/catalog/attribute-definitions/${id}/activate`,
      { method: 'POST', ifMatch: `"${expectedVersion}"`, idempotencyKey },
      (raw) => raw as AttributeDefinitionWithOptions,
    );
  }
  deleteAttributeDefinition(id: string, expectedVersion: number): Promise<{ status: 'deleted' }> {
    return this.call(
      `/v1/catalog/attribute-definitions/${id}`,
      { method: 'DELETE', ifMatch: `"${expectedVersion}"` },
      (raw) => raw as { status: 'deleted' },
    );
  }

  getProductAttributes(productId: string): Promise<ProductAttributeSet> {
    return this.get(`/v1/catalog/products/${productId}/attributes`);
  }
  /** replace-set; `If-Match` = the parent `product.version` (owner K.3) */
  setProductAttributes(
    productId: string,
    attributes: ProductAttributeInput[],
    expectedProductVersion: number,
  ): Promise<ProductAttributeSet> {
    return this.call(
      `/v1/catalog/products/${productId}/attributes`,
      { method: 'PUT', body: { attributes }, ifMatch: `"${expectedProductVersion}"` },
      (raw) => raw as ProductAttributeSet,
    );
  }

  // ── variants + option groups (task 3.4) — catalog:view reads / variants:manage writes ──
  listOptionGroups(productId: string): Promise<OptionGroupWithValues[]> {
    return this.get(`/v1/catalog/products/${productId}/option-groups`);
  }
  createOptionGroup(
    productId: string,
    input: OptionGroupCreateInput,
    idempotencyKey: string,
  ): Promise<OptionGroupWithValues> {
    return this.send(
      'POST',
      `/v1/catalog/products/${productId}/option-groups`,
      input,
      idempotencyKey,
    );
  }
  updateOptionGroup(
    productId: string,
    groupId: string,
    input: OptionGroupUpdateInput,
    expectedVersion: number,
  ): Promise<OptionGroupWithValues> {
    return this.call(
      `/v1/catalog/products/${productId}/option-groups/${groupId}`,
      { method: 'PUT', body: input, ifMatch: `"${expectedVersion}"` },
      (raw) => raw as OptionGroupWithValues,
    );
  }
  /** replace the value-set; `If-Match` = the option-group version (owner L-11) */
  setOptionValues(
    productId: string,
    groupId: string,
    values: OptionValueInput[],
    expectedVersion: number,
  ): Promise<OptionGroupWithValues> {
    return this.call(
      `/v1/catalog/products/${productId}/option-groups/${groupId}/values`,
      { method: 'PUT', body: { values }, ifMatch: `"${expectedVersion}"` },
      (raw) => raw as OptionGroupWithValues,
    );
  }
  deleteOptionGroup(
    productId: string,
    groupId: string,
    expectedVersion: number,
  ): Promise<{ status: 'deleted'; recreatedDefaultVariant: boolean }> {
    return this.call(
      `/v1/catalog/products/${productId}/option-groups/${groupId}`,
      { method: 'DELETE', ifMatch: `"${expectedVersion}"` },
      (raw) => raw as { status: 'deleted'; recreatedDefaultVariant: boolean },
    );
  }

  listVariants(productId: string): Promise<VariantRow[]> {
    return this.get(`/v1/catalog/products/${productId}/variants`);
  }
  getVariant(id: string): Promise<VariantWithOptions> {
    return this.get(`/v1/catalog/variants/${id}`);
  }
  createVariant(
    productId: string,
    input: VariantCreateInput,
    idempotencyKey: string,
  ): Promise<VariantWithOptions> {
    return this.send('POST', `/v1/catalog/products/${productId}/variants`, input, idempotencyKey);
  }
  updateVariant(
    id: string,
    input: VariantUpdateInput,
    expectedVersion: number,
  ): Promise<VariantWithOptions> {
    return this.call(
      `/v1/catalog/variants/${id}`,
      { method: 'PUT', body: input, ifMatch: `"${expectedVersion}"` },
      (raw) => raw as VariantWithOptions,
    );
  }
  activateVariant(
    id: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<VariantWithOptions> {
    return this.call(
      `/v1/catalog/variants/${id}/activate`,
      { method: 'POST', ifMatch: `"${expectedVersion}"`, idempotencyKey },
      (raw) => raw as VariantWithOptions,
    );
  }
  archiveVariant(
    id: string,
    expectedVersion: number,
    idempotencyKey: string,
  ): Promise<VariantWithOptions> {
    return this.call(
      `/v1/catalog/variants/${id}/archive`,
      { method: 'POST', ifMatch: `"${expectedVersion}"`, idempotencyKey },
      (raw) => raw as VariantWithOptions,
    );
  }

  // ── identifiers — SKU / barcode / QR (task 3.5) ───────────────────────────
  //   catalog:view reads / scan-resolve · identifiers:manage writes. No If-Match
  //   (identity is immutable — no version column); create + reactivate carry an
  //   Idempotency-Key; DELETE is plain (deactivate; hard for a DRAFT target).
  createIdentifier(
    input: IdentifierCreateInput,
    idempotencyKey: string,
  ): Promise<ItemIdentifierRow> {
    return this.send('POST', '/v1/catalog/identifiers', input, idempotencyKey);
  }
  /** scan-resolve: a bare scanned value → at most one ACTIVE identifier (404 if
   *  none, or the target variant is ARCHIVED) */
  resolveIdentifier(value: string): Promise<IdentifierResolution> {
    return this.get('/v1/catalog/identifiers', { value });
  }
  /** management view — ACTIVE + INACTIVE identifiers of one variant */
  listVariantIdentifiers(variantId: string): Promise<ItemIdentifierRow[]> {
    return this.get('/v1/catalog/identifiers', { targetKind: 'VARIANT', targetId: variantId });
  }
  /** normal removal — deactivates (ACTIVE → INACTIVE); a DRAFT-target identifier
   *  is hard-deleted instead (nothing external ever committed it) */
  deleteIdentifier(id: string): Promise<{ status: 'deactivated' | 'deleted' }> {
    return this.call(
      `/v1/catalog/identifiers/${id}`,
      { method: 'DELETE' },
      (raw) => raw as { status: 'deactivated' | 'deleted' },
    );
  }
  reactivateIdentifier(id: string, idempotencyKey: string): Promise<ItemIdentifierRow> {
    return this.send('POST', `/v1/catalog/identifiers/${id}/reactivate`, undefined, idempotencyKey);
  }

  // ── UOM registry + pack conversions (task 3.6) ────────────────────────────
  //   catalog:view reads / catalog:manage (uoms) · variants:manage (base-uom +
  //   conversions) writes. Every write except a built-in base-UOM assignment
  //   also requires the `multi_uom` capability. POST → Idempotency-Key; PUT →
  //   If-Match (uom.version for /uoms, variant/product version for conversions).
  listUoms(): Promise<UomListEntry[]> {
    return this.get('/v1/catalog/uoms');
  }
  getUom(code: string): Promise<UomListEntry> {
    return this.get(`/v1/catalog/uoms/${encodeURIComponent(code)}`);
  }
  createUom(input: UomCreateInput, idempotencyKey: string): Promise<UomListEntry> {
    return this.send('POST', '/v1/catalog/uoms', input, idempotencyKey);
  }
  updateUom(
    code: string,
    input: { nameEn?: string; nameAr?: string | null },
    expectedVersion: number,
  ): Promise<UomListEntry> {
    return this.call(
      `/v1/catalog/uoms/${encodeURIComponent(code)}`,
      { method: 'PUT', body: input, ifMatch: `"${expectedVersion}"` },
      (raw) => raw as UomListEntry,
    );
  }
  deleteUom(code: string, expectedVersion: number): Promise<{ status: 'deleted' }> {
    return this.call(
      `/v1/catalog/uoms/${encodeURIComponent(code)}`,
      { method: 'DELETE', ifMatch: `"${expectedVersion}"` },
      (raw) => raw as { status: 'deleted' },
    );
  }
  setVariantBaseUom(
    variantId: string,
    baseUomCode: string,
    expectedVersion: number,
  ): Promise<VariantWithOptions> {
    return this.call(
      `/v1/catalog/variants/${variantId}/base-uom`,
      { method: 'PUT', body: { baseUomCode }, ifMatch: `"${expectedVersion}"` },
      (raw) => raw as VariantWithOptions,
    );
  }
  getVariantConversions(variantId: string): Promise<VariantConversionsView> {
    return this.get(`/v1/catalog/variants/${variantId}/conversions`);
  }
  replaceVariantConversions(
    variantId: string,
    conversions: VariantConversionEntry[],
    expectedVariantVersion: number,
  ): Promise<VariantConversionsView> {
    return this.call(
      `/v1/catalog/variants/${variantId}/conversions`,
      { method: 'PUT', body: { conversions }, ifMatch: `"${expectedVariantVersion}"` },
      (raw) => raw as VariantConversionsView,
    );
  }
  getProductConversions(productId: string): Promise<ProductConversionsView> {
    return this.get(`/v1/catalog/products/${productId}/conversions`);
  }
  replaceProductConversions(
    productId: string,
    conversions: ProductConversionEntry[],
    expectedProductVersion: number,
  ): Promise<ProductConversionsView> {
    return this.call(
      `/v1/catalog/products/${productId}/conversions`,
      { method: 'PUT', body: { conversions }, ifMatch: `"${expectedProductVersion}"` },
      (raw) => raw as ProductConversionsView,
    );
  }

  // ── company per-UOM SELL pricing (task 3.7) ───────────────────────────────
  // company-scoped; `pricing:manage` writes / `catalog:view` reads. NO branchId
  // (task 3.8). NO purchase in the wire contract (D-6). `If-Match` is the
  // dedicated price-set version — `"0"` on the first write.
  getCompanyPrices(companyId: string, variantId: string): Promise<CompanyVariantPriceSetView> {
    return this.get(`/v1/catalog/companies/${companyId}/variants/${variantId}/prices`);
  }
  replaceCompanyPrices(
    companyId: string,
    variantId: string,
    prices: CompanyPriceEntry[],
    expectedVersion: number,
  ): Promise<CompanyVariantPriceSetView> {
    return this.call(
      `/v1/catalog/companies/${companyId}/variants/${variantId}/prices`,
      { method: 'PUT', body: { prices }, ifMatch: `"${expectedVersion}"` },
      (raw) => raw as CompanyVariantPriceSetView,
    );
  }
  resolveCompanyPrice(
    companyId: string,
    variantId: string,
    uomCode: string,
  ): Promise<ResolvedCompanyPrice> {
    return this.get(`/v1/catalog/companies/${companyId}/variants/${variantId}/prices/resolve`, {
      uomCode,
    });
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
