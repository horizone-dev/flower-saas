import { Injectable } from '@nestjs/common';
// Deliberate, owner-mandated exception (mirrors every other Checkpoint
// C/D/E primitive in this module): participates in the caller's already-open
// transaction, never opens its own.
import type { ScopedTx } from '@flower/db';
import { assertSanitizedMetadataShape } from './sanitized-metadata.js';
import type { WebhookVerifiedTargetState } from './payment-provider.port.js';

export interface InsertVerifiedInboxEventInput {
  tenantId: string;
  companyId: string;
  branchId: string;
  providerCredentialId: string;
  providerEventId: string;
  eventType: string;
  /** SHA-256 hex digest of the EXACT raw request bytes (owner §F4/§F9). */
  payloadHash: string;
  paymentAttemptId?: string | null;
  providerReference?: string | null;
  targetState?: WebhookVerifiedTargetState | null;
  sanitizedMetadata?: Record<string, unknown>;
}

export interface InsertVerifiedInboxEventResult {
  inboxId: string;
  status: 'RECEIVED' | 'PROCESSED' | 'EXCEPTION';
  /** true when this call discovered an ALREADY-EXISTING row for
   *  `(providerCredentialId, providerEventId)` rather than inserting a new
   *  one (owner §F9/§F10 dedupe — never trusted globally across different
   *  credentials, only within the SAME one). */
  duplicate: boolean;
  /** true when `duplicate` is true AND the newly-verified content
   *  materially disagrees with the ALREADY-STORED row for this same
   *  `(providerCredentialId, providerEventId)` (owner reliability-pass
   *  §10) — compared on `payloadHash`/`paymentAttemptId`/
   *  `providerReference`/`targetState`/`eventType`. The ORIGINAL durable
   *  row is never overwritten (B's own immutability trigger would reject
   *  it anyway); this call performs NO write in that case. Always `false`
   *  when `duplicate` is `false`. */
  payloadConflict: boolean;
}

/**
 * Task 3b.5 Checkpoint F — the verified-webhook durable inbox primitive
 * (owner §F9/§F10). Called ONLY after `PaymentProvider.verifyWebhook` has
 * already authenticated the request — this class never sees, stores, or
 * logs a raw body, and never accepts anything from the request beyond
 * VERIFIED, NORMALIZED fields. UNIQUE `(providerCredentialId,
 * providerEventId)` is B's own frozen dedupe key — a same-credential
 * replay discovers the existing row instead of inserting a second one.
 *
 * §10 (reliability pass) — a same-event-id replay is only ever trusted as
 * "the same event" when its normalized content actually agrees with what
 * is already durably stored; a MATERIALLY DIFFERENT payload under the same
 * id is a bounded anomaly (logged by the caller), never silently accepted
 * as an ordinary replay and never allowed to overwrite the original
 * immutable row.
 */
@Injectable()
export class ProviderPaymentEventInboxRepository {
  async insertVerifiedEventInTx(
    tx: ScopedTx,
    input: InsertVerifiedInboxEventInput,
  ): Promise<InsertVerifiedInboxEventResult> {
    const sanitizedMetadata = input.sanitizedMetadata ?? {};
    assertSanitizedMetadataShape(sanitizedMetadata);

    const insertedRows = await tx.$queryRaw<{ id: string; status: string }[]>`
      INSERT INTO "provider_payment_event"
        ("tenantId", "companyId", "branchId", "providerCredentialId", "providerEventId",
         "eventType", "payloadHash", "paymentAttemptId", "providerReference", "targetState",
         "sanitizedMetadata")
      VALUES (${input.tenantId}::uuid, ${input.companyId}::uuid, ${input.branchId}::uuid,
              ${input.providerCredentialId}::uuid, ${input.providerEventId}, ${input.eventType},
              ${input.payloadHash}, ${input.paymentAttemptId ?? null}::uuid,
              ${input.providerReference ?? null}, ${input.targetState ?? null},
              ${JSON.stringify(sanitizedMetadata)}::jsonb)
      ON CONFLICT ("providerCredentialId", "providerEventId") DO NOTHING
      RETURNING "id", "status"`;

    const inserted = insertedRows[0];
    if (inserted) {
      return {
        inboxId: inserted.id,
        status: inserted.status as InsertVerifiedInboxEventResult['status'],
        duplicate: false,
        payloadConflict: false,
      };
    }

    const existingRows = await tx.$queryRaw<
      {
        id: string;
        status: string;
        payloadHash: string;
        paymentAttemptId: string | null;
        providerReference: string | null;
        targetState: string | null;
        eventType: string;
      }[]
    >`
      SELECT "id", "status", "payloadHash", "paymentAttemptId", "providerReference",
             "targetState", "eventType"
        FROM "provider_payment_event"
       WHERE "providerCredentialId" = ${input.providerCredentialId}::uuid
         AND "providerEventId" = ${input.providerEventId}`;
    const existing = existingRows[0]!;
    const payloadConflict =
      existing.payloadHash !== input.payloadHash ||
      (existing.paymentAttemptId ?? null) !== (input.paymentAttemptId ?? null) ||
      (existing.providerReference ?? null) !== (input.providerReference ?? null) ||
      (existing.targetState ?? null) !== (input.targetState ?? null) ||
      existing.eventType !== input.eventType;
    return {
      inboxId: existing.id,
      status: existing.status as InsertVerifiedInboxEventResult['status'],
      duplicate: true,
      payloadConflict,
    };
  }
}
