import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (mirrors `ProviderPaymentEventInboxRepository`
// exactly): participates in the caller's already-open transaction, never
// opens its own.
import type { ScopedTx } from '@flower/db';

export interface InsertVerifiedRefundInboxEventInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  providerCredentialId: string;
  providerEventId: string;
  eventType: string;
  /** SHA-256 hex digest of the EXACT raw request bytes — mirrors
   *  `ProviderPaymentEventInboxRepository`'s own §F4/§F9 convention. */
  payloadHash: string;
  refundAttemptId?: string | null;
  providerReference?: string | null;
  targetState?: 'PENDING' | 'SUCCEEDED' | 'FAILED' | null;
  sanitizedMetadata?: Record<string, unknown>;
}

export interface InsertVerifiedRefundInboxEventResult {
  inboxId: string;
  status: 'RECEIVED' | 'PROCESSED' | 'EXCEPTION';
  /** true when this call discovered an ALREADY-EXISTING row for
   *  `(providerCredentialId, providerEventId)` rather than inserting a new
   *  one. */
  duplicate: boolean;
  /** true when `duplicate` is true AND the newly-supplied content
   *  materially disagrees with the ALREADY-STORED row — the original
   *  durable row is never overwritten. */
  payloadConflict: boolean;
}

/**
 * Task 3b.8 Checkpoint D (provider-stub reconciliation) — the
 * `provider_refund_event` durable inbox primitive, mirroring
 * `ProviderPaymentEventInboxRepository` exactly (same dedup key, same
 * payload-conflict detection, same "never a raw payload" discipline — this
 * class only ever receives ALREADY-NORMALIZED fields). `refundAttemptId` is
 * claimed-not-FK, same rationale as `ProviderPaymentEvent.paymentAttemptId`
 * (the model's own doc comment).
 *
 * This is the "ProviderRefundEvent handling foundation" the frozen schema
 * already supports structurally — it is NOT wired to any HTTP webhook route
 * (no `PaymentProvider.verifyWebhook` contract exists for refund events, and
 * none is invented here). A future checkpoint that adds a concrete adapter
 * calls this primitive exactly as `WebhookEventProcessorRepository` calls
 * `ProviderPaymentEventInboxRepository` today.
 */
@Injectable()
export class ProviderRefundEventInboxRepository {
  async insertVerifiedEventInTx(
    tx: ScopedTx,
    input: InsertVerifiedRefundInboxEventInput,
  ): Promise<InsertVerifiedRefundInboxEventResult> {
    const sanitizedMetadata = input.sanitizedMetadata ?? {};

    const insertedRows = await tx.$queryRaw<{ id: string; status: string }[]>`
      INSERT INTO "provider_refund_event"
        ("tenantId", "companyId", "branchId", "providerCredentialId", "providerEventId",
         "eventType", "payloadHash", "refundAttemptId", "providerReference", "targetState",
         "sanitizedMetadata", "updatedAt")
      VALUES (${input.tenantId}::uuid, ${input.companyId}::uuid, ${input.branchId}::uuid,
              ${input.providerCredentialId}::uuid, ${input.providerEventId}, ${input.eventType},
              ${input.payloadHash}, ${input.refundAttemptId ?? null}::uuid,
              ${input.providerReference ?? null}, ${input.targetState ?? null},
              ${JSON.stringify(sanitizedMetadata)}::jsonb, now())
      ON CONFLICT ("providerCredentialId", "providerEventId") DO NOTHING
      RETURNING "id", "status"`;

    const inserted = insertedRows[0];
    if (inserted) {
      return {
        inboxId: inserted.id,
        status: inserted.status as InsertVerifiedRefundInboxEventResult['status'],
        duplicate: false,
        payloadConflict: false,
      };
    }

    const existingRows = await tx.$queryRaw<
      {
        id: string;
        status: string;
        payloadHash: string;
        refundAttemptId: string | null;
        providerReference: string | null;
        targetState: string | null;
        eventType: string;
      }[]
    >`
      SELECT "id", "status", "payloadHash", "refundAttemptId", "providerReference",
             "targetState", "eventType"
        FROM "provider_refund_event"
       WHERE "providerCredentialId" = ${input.providerCredentialId}::uuid
         AND "providerEventId" = ${input.providerEventId}`;
    const existing = existingRows[0]!;
    const payloadConflict =
      existing.payloadHash !== input.payloadHash ||
      (existing.refundAttemptId ?? null) !== (input.refundAttemptId ?? null) ||
      (existing.providerReference ?? null) !== (input.providerReference ?? null) ||
      (existing.targetState ?? null) !== (input.targetState ?? null) ||
      existing.eventType !== input.eventType;
    return {
      inboxId: existing.id,
      status: existing.status as InsertVerifiedRefundInboxEventResult['status'],
      duplicate: true,
      payloadConflict,
    };
  }
}
