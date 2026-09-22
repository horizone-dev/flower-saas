import { Module } from '@nestjs/common';
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
 * reservation). No `AccountingModule`/`CatalogModule`/`CustomerModule`
 * import — this module never calls `PostingEngineService`, never resolves a
 * price/tax, never touches a customer.
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
})
export class PaymentModule {}
