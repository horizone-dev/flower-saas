import { Injectable } from '@nestjs/common';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { DomainError } from '../../common/errors/domain-error.js';

/**
 * The ONLY information Checkpoint E's generic orchestration is allowed to
 * hold about a resolved provider configuration (owner §E6). Never
 * `secretCiphertext`/`secretNonce`/`dekWrapped`/a decrypted value/a masked
 * secret. A future concrete adapter resolves the actual secret material
 * itself, internally, via `SecretsService` — never through this repository.
 */
export interface ResolvedProviderConfig {
  providerCredentialId: string;
  providerKey: string;
  mode: string;
  webhookEndpointId: string;
}

/**
 * Task 3b.5 Checkpoint E — branch-scoped payment-provider configuration
 * resolution (owner §E5). The caller identifies only a non-secret
 * `providerKey`; this resolves the actual usable `ProviderCredential`.
 *
 * A usable config requires, all simultaneously:
 *   - exact tenantId/companyId/branchId match against the TRUSTED route
 *     scope (never a request-supplied value)
 *   - companyId/branchId NOT NULL (frozen Checkpoint B rule: payments never
 *     accept a tenant-wide or company-only credential, even though
 *     `provider_credential` itself permits both for OTHER platform domains)
 *   - `provider` == the requested `providerKey`
 *   - `status` = 'ACTIVE' (a REVOKED credential is never usable)
 *   - an associated `PaymentWebhookEndpoint` (INNER JOIN — the only other
 *     payment-domain marker this repository has for "this credential is
 *     actually wired for payment use", per owner §E5's own conditional)
 *
 * Zero usable rows -> `PAYMENT_PROVIDER_CONFIG_NOT_FOUND` (409 — a
 * business-configuration prerequisite not met, mirroring
 * `ORDER_COMPANY_ACCOUNTING_TIMEZONE_NOT_CONFIGURED`'s own precedent, not a
 * REST "resource not found"). More than one usable row for the exact same
 * tenant/company/branch/provider -> `PAYMENT_PROVIDER_CONFIG_AMBIGUOUS`
 * (409) — FAILS CLOSED, never "pick the first row". `providerCredentialId`
 * is NEVER accepted from a tenant/POS client anywhere in this module.
 */
@Injectable()
export class ProviderConfigRepository extends ScopedRepository {
  constructor(db: DbService) {
    super(db);
  }

  async resolveForBranchScoped(
    companyId: string,
    branchId: string,
    providerKey: string,
  ): Promise<ResolvedProviderConfig> {
    const { tenantId } = requireTenantContext();
    // read-only lookup — no Invoice/PaymentAttempt lock is held here, and it
    // must run BEFORE any monetary reservation transaction opens (owner
    // §E8 item 1), so it deliberately runs in its OWN short transaction,
    // never sharing Phase 1's `ScopedTx`.
    const rows = await this.scoped(
      (tx) =>
        tx.$queryRaw<{ id: string; provider: string; mode: string; webhookEndpointId: string }[]>`
        SELECT pc."id", pc."provider", pc."mode", pwe."id" AS "webhookEndpointId"
          FROM "provider_credential" pc
          JOIN "payment_webhook_endpoint" pwe ON pwe."providerCredentialId" = pc."id"
         WHERE pc."tenantId" = ${tenantId}::uuid
           AND pc."companyId" = ${companyId}::uuid
           AND pc."branchId" = ${branchId}::uuid
           AND pc."companyId" IS NOT NULL
           AND pc."branchId" IS NOT NULL
           AND pc."provider" = ${providerKey}
           AND pc."status" = 'ACTIVE'`,
    );

    if (rows.length === 0) {
      throw new DomainError(
        'PAYMENT_PROVIDER_CONFIG_NOT_FOUND',
        `no usable ACTIVE branch-scoped payment provider configuration exists for providerKey "${providerKey}"`,
        409,
      );
    }
    if (rows.length > 1) {
      throw new DomainError(
        'PAYMENT_PROVIDER_CONFIG_AMBIGUOUS',
        `more than one usable payment provider configuration exists for providerKey "${providerKey}" in this branch — refusing to guess`,
        409,
      );
    }
    const row = rows[0]!;
    return {
      providerCredentialId: row.id,
      providerKey: row.provider,
      mode: row.mode,
      webhookEndpointId: row.webhookEndpointId,
    };
  }

  /**
   * Recovery-path check ONLY (owner recovery-pass §7) — verifies a
   * RECOVERED PaymentAttempt's already-stored `providerCredentialId` is
   * still usable, WITHOUT re-resolving/rebinding to whatever config
   * currently happens to be active for that branch/provider (which could
   * now be a different row entirely — e.g. after a rotation-by-replacement
   * or a revoke). Never called for a brand-new attempt (that path uses
   * {@link resolveForBranchScoped} exactly as before). Returns `false`
   * (never throws) so the orchestration can fail closed with a bounded,
   * attempt-specific error and leave the reservation visible for
   * operational reconciliation, exactly per §7's instruction — this method
   * itself makes no judgment about what "unusable" should mean to the
   * caller.
   */
  async verifyCredentialStillUsable(
    providerCredentialId: string,
    scope: { companyId: string; branchId: string },
  ): Promise<boolean> {
    const { tenantId } = requireTenantContext();
    const rows = await this.scoped(
      (tx) =>
        tx.$queryRaw<{ id: string }[]>`
        SELECT "id"
          FROM "provider_credential"
         WHERE "id" = ${providerCredentialId}::uuid
           AND "tenantId" = ${tenantId}::uuid
           AND "companyId" = ${scope.companyId}::uuid
           AND "branchId" = ${scope.branchId}::uuid
           AND "status" = 'ACTIVE'`,
    );
    return rows.length === 1;
  }
}
