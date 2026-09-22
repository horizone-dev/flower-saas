import { Injectable } from '@nestjs/common';
import { PlatformRepository, DbService } from '../../common/data/index.js';

/**
 * The ONLY trusted identity a webhook request may establish BEFORE its
 * signature has been verified (owner §F3). No secret material, no
 * user-controlled scope — every field here comes from the platform-owned
 * `PaymentWebhookEndpoint`/`ProviderCredential` rows, never the request.
 */
export interface WebhookBootstrapContext {
  endpointId: string;
  providerCredentialId: string;
  providerKey: string;
  tenantId: string;
  companyId: string;
  branchId: string;
  mode: string;
}

/**
 * Task 3b.5 Checkpoint F — the pre-scope webhook bootstrap resolver (owner
 * §F3). Runs BEFORE any tenant `RequestContext` exists (a webhook request
 * carries no session/JWT at all) — uses the SAME narrow
 * `PlatformRepository`/BYPASSRLS convention `SecretsRepository` already
 * establishes for platform-only `provider_credential`/webhook-endpoint
 * access, not a new pattern.
 *
 * Input is `endpointId` alone. Output is exactly the fields listed on
 * {@link WebhookBootstrapContext} — never `secretCiphertext`/`secretNonce`/
 * `dekWrapped`/any decrypted value/`nonSecretConfig`. No `SECURITY DEFINER`
 * SQL anywhere — the query runs under the ordinary `flower_platform`
 * (BYPASSRLS) role via `runPlatform`, exactly like every other
 * `PlatformRepository` subclass.
 *
 * Deliberately does NOT filter on `ProviderCredential.status` — bootstrap
 * answers "does this URL map to a real, structurally-valid, branch-scoped
 * provider integration," not "is this credential currently accepting new
 * payments" (that gate already applies at Checkpoint E's own initiation-time
 * resolution). A REVOKED credential must still be able to receive and
 * correctly correlate a LATE terminal webhook (e.g. a delayed FAILED/
 * CANCELED event for an attempt made before revocation) rather than have
 * bootstrap itself silently swallow it as "unknown endpoint" — owner §F28
 * ("no secret rotation logic belongs in F"; the credential id, not its
 * live status, is what identity/correlation is pinned to).
 *
 * Unknown endpoint -> `null`, with NO distinguishing information — the
 * controller returns the exact same bounded response for "no such
 * endpoint" as for "signature verification failed" (owner §F3 "unknown
 * endpoint fails non-disclosing").
 */
@Injectable()
export class WebhookBootstrapRepository extends PlatformRepository {
  constructor(db: DbService) {
    super(db);
  }

  async resolveEndpoint(endpointId: string): Promise<WebhookBootstrapContext | null> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(endpointId)) {
      return null;
    }
    const rows = await this.platform(
      (tx) =>
        tx.$queryRaw<
          {
            endpointId: string;
            providerCredentialId: string;
            providerKey: string;
            tenantId: string;
            companyId: string;
            branchId: string;
            mode: string;
          }[]
        >`
        SELECT pwe."id" AS "endpointId",
               pwe."providerCredentialId",
               pc."provider" AS "providerKey",
               pwe."tenantId",
               pwe."companyId",
               pwe."branchId",
               pc."mode"
          FROM "payment_webhook_endpoint" pwe
          JOIN "provider_credential" pc ON pc."id" = pwe."providerCredentialId"
         WHERE pwe."id" = ${endpointId}::uuid
           -- endpoint/credential scope must exactly agree (owner §F3) —
           -- structurally guaranteed at INSERT time by B's own trigger, but
           -- re-verified here defensively rather than assumed.
           AND pwe."tenantId" = pc."tenantId"
           AND pwe."companyId" IS NOT NULL
           AND pwe."branchId" IS NOT NULL
           AND pwe."companyId" = pc."companyId"
           AND pwe."branchId" = pc."branchId"`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      endpointId: row.endpointId,
      providerCredentialId: row.providerCredentialId,
      providerKey: row.providerKey,
      tenantId: row.tenantId,
      companyId: row.companyId,
      branchId: row.branchId,
      mode: row.mode,
    };
  }
}
