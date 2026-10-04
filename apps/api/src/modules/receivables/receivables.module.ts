import { Module } from '@nestjs/common';
import { SystemClock } from '../../common/clock/clock.js';
import { AccountingModule } from '../accounting/accounting.module.js';
import { AccessModule } from '../access/access.module.js';
import { CustomerModule } from '../customers/customer.module.js';
import { SettlementsModule } from '../settlements/settlements.module.js';
import { CustomerInvoiceArRepository } from './customer-invoice-ar.repository.js';
import { CreditOverrideAuthorizationService } from './credit-override-authorization.service.js';
import { PaymentCustomerAttributionRepository } from './payment-customer-attribution.repository.js';
import { CustomerReceiptEffectsRepository } from './customer-receipt-effects.repository.js';
import { CustomerReceiptCollectionRepository } from './customer-receipt-collection.repository.js';
import { CustomerReceiptRepository } from './customer-receipt.repository.js';
import { CustomerReceiptService } from './customer-receipt.service.js';
import { CustomerReceiptController } from './customer-receipt.controller.js';
import { PaymentAdvanceConversionRepository } from './payment-advance-conversion.repository.js';
import { PaymentAdvanceConversionHttpRepository } from './payment-advance-conversion.http.repository.js';
import { PaymentAdvanceConversionService } from './payment-advance-conversion.service.js';
import { PaymentAdvanceConversionController } from './payment-advance-conversion.controller.js';
import { CustomerAdvanceApplicationRepository } from './customer-advance-application.repository.js';
import { CustomerAdvanceApplicationHttpRepository } from './customer-advance-application.http.repository.js';
import { CustomerAdvanceApplicationService } from './customer-advance-application.service.js';
import { CustomerAdvanceApplicationController } from './customer-advance-application.controller.js';
import { OpeningBalanceRepository } from './opening-balance.repository.js';
import { OpeningBalanceHttpRepository } from './opening-balance.http.repository.js';
import { OpeningBalanceService } from './opening-balance.service.js';
import { OpeningBalanceController } from './opening-balance.controller.js';
import { CustomerWithOpeningBalanceRepository } from './customer-with-opening-balance.repository.js';
import { CustomerWithOpeningBalanceService } from './customer-with-opening-balance.service.js';
import { CustomerWithOpeningBalanceController } from './customer-with-opening-balance.controller.js';
import { CustomerWithOpeningBalanceFingerprintProvider } from './customer-with-opening-balance-fingerprint.provider.js';
import { CustomerAccountReadRepository } from './customer-account-read.repository.js';
import { CustomerAccountReadHttpRepository } from './customer-account-read.http.repository.js';
import { CustomerAccountReadService } from './customer-account-read.service.js';
import { CustomerAccountReadController } from './customer-account-read.controller.js';
import { RefundExecutionRepository } from './refund-execution.repository.js';
import { RefundAttemptReservationRepository } from './refund-attempt-reservation.repository.js';
import { ProviderRefundEventInboxRepository } from './provider-refund-event-inbox.repository.js';
import { RefundRepository } from './refund.repository.js';
import { RefundService } from './refund.service.js';
import { RefundController } from './refund.controller.js';

/**
 * `receivables` module (task 3b.6 Checkpoints C/D/E). Imports `AccountingModule`
 * for `PostingEngineService` (mirrors `CustomerModule`'s own precedent of
 * reusing it unmodified) and `AccessModule` for `PolicyEngine` (the override
 * authorization's only dependency).
 *
 * Checkpoint D additions: `PaymentCustomerAttributionRepository` (D4, the
 * one trusted Payment->customer resolver) and `CustomerReceiptEffectsRepository`
 * (D17/D18, the ONE centralized customer-account-effects primitive) are
 * EXPORTED — `PaymentModule` now imports this module so its two existing
 * Payment-creation producers (`PaymentCollectionRepository`,
 * `WebhookEventProcessorRepository`) can call into them for a
 * customer-attributable Invoice collection, closing the D17 integration gap.
 * `CustomerReceiptController`/`Service`/`Repository`/`CollectionRepository`
 * are the new customer-level receipt primitive (D10-D16).
 *
 * Task 3b.7 Checkpoint D additive import: `SettlementsModule`, for
 * `InvoiceSettlementProjectionRepository` — injected into
 * `CustomerReceiptEffectsRepository`'s own `recomputeInvoicePaymentStatusInTx`
 * tail (the SAME reusable live PAID->SETTLED projection Settlement
 * finalization itself calls, never duplicated).
 *
 * Checkpoint E additions: `PaymentAdvanceConversionRepository` (E3/E8, the
 * explicit Payment->CustomerAdvance conversion primitive) and
 * `CustomerAdvanceApplicationRepository` (E11-E19, the explicit
 * CustomerAdvance->CustomerReceivable application primitive, reusing
 * `CustomerReceiptEffectsRepository.recomputeInvoicePaymentStatusInTx` —
 * never a duplicate arithmetic implementation), plus their own thin
 * HTTP repository/service/controller triads.
 *
 * Task 3b.8 Checkpoint D adds `RefundExecutionRepository`/`RefundRepository`/
 * `RefundService`/`RefundController` — the separate, later, explicit Refund
 * action that drains a CREDIT_NOTE-sourced `CustomerAdvance`. CASH/
 * BANK_TRANSFER execute fully, synchronously; OTHER_MANUAL is rejected (no
 * exact financial account mapping, per `Refund`'s own schema doc comment).
 *
 * Internal provider-refund foundation (same checkpoint, NOT reachable from any
 * public route yet): `RefundAttemptReservationRepository` can durably persist
 * a PENDING `RefundAttempt` — resolving `providerCredentialId` ONLY from the
 * authoritative chain `CustomerAdvance -> CreditNoteCoverageRelease.
 * sourcePaymentId -> Payment.sourceAttemptId -> PaymentAttempt.
 * providerCredentialId` (never invented, never client-supplied), gating on
 * `PROVIDER_REFUND_REQUIRES_FULL_SETTLEMENT` by reusing
 * `InvoiceSettlementProjectionRepository.isPaymentSettlementFinal` (promoted
 * to `public` for this reuse, never duplicated). The public refund route
 * rejects CARD_TERMINAL/ONLINE_GATEWAY with `501 REFUND_PROVIDER_NOT_IMPLEMENTED`
 * BEFORE any transaction, so it is completely side-effect free
 * (`RefundRepository` does not inject the reservation primitive at all) —
 * the foundation is exercised directly by tests until `PaymentProvider.
 * refund`/`getStatus` exist. `ProviderRefundEventInboxRepository` mirrors
 * `ProviderPaymentEventInboxRepository`'s own dedup'd webhook-inbox shape for
 * `provider_refund_event` — likewise a primitive only, wired to no HTTP route
 * (no `verifyWebhook` contract exists for refunds).
 * `SystemClock` is declared locally here too (mirrors `AccountingModule`'s/
 * `OrderModule`'s own local declaration — no shared `ClockModule` exists).
 */
@Module({
  imports: [AccountingModule, AccessModule, CustomerModule, SettlementsModule],
  controllers: [
    CustomerReceiptController,
    PaymentAdvanceConversionController,
    CustomerAdvanceApplicationController,
    OpeningBalanceController,
    CustomerWithOpeningBalanceController,
    CustomerAccountReadController,
    RefundController,
  ],
  providers: [
    SystemClock,
    CustomerInvoiceArRepository,
    CreditOverrideAuthorizationService,
    PaymentCustomerAttributionRepository,
    CustomerReceiptEffectsRepository,
    CustomerReceiptCollectionRepository,
    CustomerReceiptRepository,
    CustomerReceiptService,
    PaymentAdvanceConversionRepository,
    PaymentAdvanceConversionHttpRepository,
    PaymentAdvanceConversionService,
    CustomerAdvanceApplicationRepository,
    CustomerAdvanceApplicationHttpRepository,
    CustomerAdvanceApplicationService,
    OpeningBalanceRepository,
    OpeningBalanceHttpRepository,
    OpeningBalanceService,
    CustomerWithOpeningBalanceRepository,
    CustomerWithOpeningBalanceService,
    CustomerWithOpeningBalanceFingerprintProvider,
    CustomerAccountReadRepository,
    CustomerAccountReadHttpRepository,
    CustomerAccountReadService,
    RefundExecutionRepository,
    RefundAttemptReservationRepository,
    ProviderRefundEventInboxRepository,
    RefundRepository,
    RefundService,
  ],
  exports: [
    CustomerInvoiceArRepository,
    CreditOverrideAuthorizationService,
    PaymentCustomerAttributionRepository,
    CustomerReceiptEffectsRepository,
    OpeningBalanceRepository,
    // task 3b.9 Checkpoint E — additive: `SalesModule` reuses THIS instance of the frozen
    // CustomerAdvance application primitive (never a second provider).
    CustomerAdvanceApplicationRepository,
  ],
})
export class ReceivablesModule {}
