import { Module } from '@nestjs/common';
import { ReceivablesModule } from '../receivables/receivables.module.js';
import { PaymentCollectionRepository } from './payment-collection.repository.js';
import { PaymentRepository } from './payment.repository.js';
import { PaymentService } from './payment.service.js';
import { PaymentController } from './payment.controller.js';
import { PaymentAttemptReservationRepository } from './payment-attempt-reservation.repository.js';
import { ProviderConfigRepository } from './provider-config.repository.js';
import { PaymentProviderRegistry } from './payment-provider-registry.js';
import { PaymentAttemptRepository } from './payment-attempt.repository.js';
import { PaymentAttemptService } from './payment-attempt.service.js';
import { PaymentAttemptController } from './payment-attempt.controller.js';
import { WebhookBootstrapRepository } from './webhook-bootstrap.repository.js';
import { ProviderPaymentEventInboxRepository } from './provider-payment-event-inbox.repository.js';
import { WebhookEventProcessorRepository } from './webhook-event-processor.repository.js';
import { PaymentWebhookRepository } from './payment-webhook.repository.js';
import { PaymentWebhookService } from './payment-webhook.service.js';
import { PaymentWebhookController } from './payment-webhook.controller.js';
import { WebhookRecoveryProcessor } from './webhook-recovery.repository.js';

/**
 * `payments` module — task 3b.5 Checkpoints C/D (synchronous capture) plus
 * Checkpoint E (generic provider port / registry / async PaymentAttempt
 * reservation). Never resolves a price/tax and never touches
 * `CatalogModule`/`CustomerModule` directly.
 *
 * Task 3b.6 Checkpoint D (D17) — now imports `ReceivablesModule` so
 * `PaymentCollectionRepository`/`WebhookEventProcessorRepository` can call
 * `PaymentCustomerAttributionRepository` (D4) and
 * `CustomerReceiptEffectsRepository` (D18) for a customer-attributable
 * Invoice collection's customer-account effects — the ONE centralized
 * implementation, never duplicated per producer. A walk-in Invoice
 * collection still never calls `PostingEngineService` at all (D17/D21) —
 * this module's own producers gate that call behind the attribution
 * resolver's own non-null result.
 *
 * `PaymentProviderRegistry` is registered with ZERO concrete adapters
 * (owner §E3) — production has nothing registered until the owner confirms
 * the first concrete provider (out of scope for this checkpoint entirely).
 * A test module registers deterministic fake providers directly against an
 * injected instance of this class.
 *
 * `PaymentCollectionRepository`/`PaymentAttemptReservationRepository`/
 * `ProviderConfigRepository` are deliberately NOT wired to any controller
 * directly (mirrors `InvoiceIssuanceRepository`) — only the two thin
 * controllers (via their own service/repository pair) reach them.
 *
 * Checkpoint F adds the verified-webhook path (`PaymentWebhookController` /
 * `PaymentWebhookService`) and its own primitives
 * (`WebhookBootstrapRepository`, `ProviderPaymentEventInboxRepository`,
 * `WebhookEventProcessorRepository`) — `OutboxWriter` is NOT listed here
 * (it is already `@Global()`-provided by `AuditModule`; re-declaring it
 * would shadow the app-wide singleton, not reuse it).
 *
 * `WebhookRecoveryProcessor` (owner reliability pass §1/§2) is registered
 * here so it is injectable/testable, but its background loop is started
 * ONLY from `main.ts` — never automatically by this module — so an ordinary
 * `Test.createTestingModule({ imports: [AppModule] })` bootstrap (used by
 * every existing integration test) never has a background poll loop
 * running underneath it.
 */
@Module({
  imports: [ReceivablesModule],
  controllers: [PaymentController, PaymentAttemptController, PaymentWebhookController],
  providers: [
    PaymentCollectionRepository,
    PaymentRepository,
    PaymentService,
    PaymentAttemptReservationRepository,
    ProviderConfigRepository,
    PaymentProviderRegistry,
    PaymentAttemptRepository,
    PaymentAttemptService,
    WebhookBootstrapRepository,
    ProviderPaymentEventInboxRepository,
    WebhookEventProcessorRepository,
    PaymentWebhookRepository,
    PaymentWebhookService,
    WebhookRecoveryProcessor,
  ],
  // task 3b.9 Checkpoint E — additive: `SalesModule` reuses THIS instance of the frozen
  // synchronous-capture primitive (never a second provider). Nothing else is exported.
  exports: [PaymentCollectionRepository],
})
export class PaymentModule {}
