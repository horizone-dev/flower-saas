import { Injectable } from '@nestjs/common';
import crypto from 'node:crypto';
import { runScoped } from '@flower/db';
import { DbService } from '../../common/data/index.js';
import { rootLogger } from '../../common/logger/logger.js';
import { ForbiddenError } from '../../common/errors/domain-error.js';
import { WebhookBootstrapRepository } from './webhook-bootstrap.repository.js';
import { PaymentProviderRegistry } from './payment-provider-registry.js';
import { ProviderPaymentEventInboxRepository } from './provider-payment-event-inbox.repository.js';
import { WebhookEventProcessorRepository } from './webhook-event-processor.repository.js';
import { isValidWebhookVerifiedTargetState } from './payment-provider.port.js';

export interface IncomingWebhookRequest {
  endpointId: string;
  rawBody: Buffer;
  headers: Readonly<Record<string, string>>;
}

/**
 * A single, fixed, non-disclosing rejection (owner §F3/§F8) — an unknown
 * endpoint and a failed signature verification are indistinguishable to
 * the caller. Never reveals tenant/branch/credential existence, the
 * expected signature, or any secret/exception detail.
 */
const NON_DISCLOSING_REJECTION = (): ForbiddenError =>
  new ForbiddenError('webhook request could not be authenticated', 'WEBHOOK_UNAUTHENTICATED');

/**
 * Task 3b.5 Checkpoint F — orchestrates the webhook path end to end (owner
 * §F2-§F12, reliability pass §1-§4): bootstrap resolve → provider signature
 * verification → durable inbox insert (ONE transaction) → immediate
 * in-process verified-event processing (a SEPARATE transaction, per F16's
 * own "open ScopedTx" step).
 *
 * FINAL ACK RULE (owner reliability-pass §4, frozen): the webhook returns
 * its bounded success response once signature verification succeeds AND
 * the durable inbox transaction commits — durability from that point on is
 * guaranteed by `WebhookRecoveryProcessor` (a real, running mechanism, not
 * an aspiration), NOT by immediate in-process processing succeeding. The
 * immediate call below is a LATENCY OPTIMIZATION ONLY: if it throws, that
 * is logged and swallowed — the ack still succeeds, because the row is
 * already durably RECEIVED and the recovery processor will pick it up. If
 * the durable inbox transaction ITSELF fails, this method throws and the
 * controller surfaces a 5xx so the provider retries (the only case where
 * this design still benefits from provider redelivery — never relied upon
 * for a row that already committed).
 *
 * NO internal `outbox` row is written for the inbox insert itself (owner
 * Checkpoint G §G14 cleanup — a genuine finding, reported and fixed, not
 * silently kept): the ORIGINAL Checkpoint F design co-committed a generic
 * `payments.provider_event_received` outbox row alongside the inbox insert
 * as its chosen durability record, per that checkpoint's own escape valve.
 * Once `WebhookRecoveryProcessor` (reliability pass §1/§2) was built to
 * poll `ProviderPaymentEvent.status = 'RECEIVED'` directly as the actual
 * durable work item, that outbox row had ZERO consumers — nothing reads
 * `payments.provider_event_received` anywhere in this repository, so it
 * was purely dead/noisy Redis-Stream traffic (CASE B, per §G14's own
 * framing). Removed here as the smallest G eventing cleanup; F's financial
 * semantics are completely unchanged (the outbox row was never load-bearing
 * for correctness, only ever a documentation artifact of an earlier design
 * iteration). Checkpoint G's OWN business events
 * (`payments.payment_recorded`/`payments.attempt_state_changed`) are
 * unaffected and still written by `WebhookEventProcessorRepository`.
 */
@Injectable()
export class PaymentWebhookRepository {
  constructor(
    private readonly db: DbService,
    private readonly bootstrap: WebhookBootstrapRepository,
    private readonly registry: PaymentProviderRegistry,
    private readonly inbox: ProviderPaymentEventInboxRepository,
    private readonly processor: WebhookEventProcessorRepository,
  ) {}

  async handle(request: IncomingWebhookRequest): Promise<void> {
    // ── F3 — pre-scope bootstrap, non-disclosing on an unknown endpoint. ──
    const ctx = await this.bootstrap.resolveEndpoint(request.endpointId);
    if (!ctx) throw NON_DISCLOSING_REJECTION();

    // ── F5/F6/F8 — signature verification via the generic adapter contract,
    //    using ONLY trusted identity + exact raw bytes. A throw here is
    //    treated identically to "unknown endpoint" (owner §F8: zero
    //    disclosure of which check failed). ────────────────────────────────
    let verified;
    try {
      const adapter = this.registry.resolve(ctx.providerKey);
      verified = await adapter.verifyWebhook({
        providerCredentialId: ctx.providerCredentialId,
        rawBody: request.rawBody,
        headers: request.headers,
      });
    } catch (err) {
      rootLogger.warn(
        { err, endpointId: ctx.endpointId },
        'webhook: signature verification failed — zero durable side effects',
      );
      throw NON_DISCLOSING_REJECTION();
    }

    const payloadHash = crypto.createHash('sha256').update(request.rawBody).digest('hex');
    const targetState =
      verified.targetState && isValidWebhookVerifiedTargetState(verified.targetState)
        ? verified.targetState
        : null;
    if (verified.targetState && !targetState) {
      rootLogger.error(
        { endpointId: ctx.endpointId, targetState: verified.targetState },
        'webhook: adapter returned a disallowed targetState — recording as an unsupported event',
      );
    }

    // ── F9 — the durable inbox insert, in its own transaction. No outbox
    //    row (owner §G14 — see the class doc comment above). ───────────────
    const inboxResult = await runScoped(
      this.db.appClient(),
      { tenantId: ctx.tenantId, branchId: ctx.branchId },
      (tx) =>
        this.inbox.insertVerifiedEventInTx(tx, {
          tenantId: ctx.tenantId,
          companyId: ctx.companyId,
          branchId: ctx.branchId,
          providerCredentialId: ctx.providerCredentialId,
          providerEventId: verified.providerEventId,
          eventType: verified.eventType,
          payloadHash,
          paymentAttemptId: verified.paymentAttemptId ?? null,
          providerReference: verified.providerReference ?? null,
          targetState,
          ...(verified.sanitizedMetadata ? { sanitizedMetadata: verified.sanitizedMetadata } : {}),
        }),
    );

    if (inboxResult.payloadConflict) {
      // owner reliability-pass §10 — a same-event-id delivery whose
      // normalized content materially disagrees with the ALREADY-STORED
      // durable row. The original row is never overwritten (nothing was
      // written above for this case) and no financial mutation is
      // attempted for THIS delivery — the stored row remains the sole
      // authoritative record and is still ownable by the recovery
      // processor if it was never resolved. Bounded, logged security
      // anomaly; richer audit visibility is explicitly deferred to G.
      rootLogger.error(
        { inboxId: inboxResult.inboxId, providerEventId: verified.providerEventId },
        'webhook: same providerEventId delivered with materially different verified content — original event left untouched',
      );
      return;
    }

    // ── F10/F13/F16 — immediate in-process processing, a SEPARATE
    //    transaction (never inside the insert transaction above). Reloads
    //    everything from the durable row — never trusts anything computed
    //    above beyond the inbox id + trusted scope. A processing failure is
    //    swallowed here (logged) rather than failing the webhook ack — the
    //    RECEIVED row is never lost; `WebhookRecoveryProcessor` owns retry
    //    from here (owner reliability-pass §4). ─────────────────────────────
    try {
      await runScoped(
        this.db.appClient(),
        { tenantId: ctx.tenantId, branchId: ctx.branchId },
        (tx) =>
          this.processor.processVerifiedInboxEventInTx(tx, {
            tenantId: ctx.tenantId,
            companyId: ctx.companyId,
            branchId: ctx.branchId,
            inboxId: inboxResult.inboxId,
          }),
      );
    } catch (err) {
      rootLogger.error(
        { err, inboxId: inboxResult.inboxId },
        'webhook: verified-event processing failed — the RECEIVED row remains durably reprocessable',
      );
    }
  }
}
