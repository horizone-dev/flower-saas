import { Module } from '@nestjs/common';
import { AccountingModule } from '../accounting/accounting.module.js';
import { AccessModule } from '../access/access.module.js';
import { CustomerModule } from '../customers/customer.module.js';
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
 * Checkpoint E additions: `PaymentAdvanceConversionRepository` (E3/E8, the
 * explicit Payment->CustomerAdvance conversion primitive) and
 * `CustomerAdvanceApplicationRepository` (E11-E19, the explicit
 * CustomerAdvance->CustomerReceivable application primitive, reusing
 * `CustomerReceiptEffectsRepository.recomputeInvoicePaymentStatusInTx` —
 * never a duplicate arithmetic implementation), plus their own thin
 * HTTP repository/service/controller triads.
 */
@Module({
  imports: [AccountingModule, AccessModule, CustomerModule],
  controllers: [
    CustomerReceiptController,
    PaymentAdvanceConversionController,
    CustomerAdvanceApplicationController,
    OpeningBalanceController,
    CustomerWithOpeningBalanceController,
    CustomerAccountReadController,
  ],
  providers: [
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
  ],
  exports: [
    CustomerInvoiceArRepository,
    CreditOverrideAuthorizationService,
    PaymentCustomerAttributionRepository,
    CustomerReceiptEffectsRepository,
    OpeningBalanceRepository,
  ],
})
export class ReceivablesModule {}
