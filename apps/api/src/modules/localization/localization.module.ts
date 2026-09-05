import { Module } from '@nestjs/common';
import { LocalizationRepository } from './localization.repository.js';
import { LocalizationService } from './localization.service.js';
import { LocalizationController } from './localization.controller.js';
import { TranslationRepository } from './translation.repository.js';
import { TranslationService } from './translation.service.js';
import { E_INVOICING_PROVIDER, NoopEInvoicingProvider } from './einvoicing-provider.port.js';

/**
 * `localization` module (task 2.7, ARCHITECTURE "Localization reference data +
 * service"). `LocalizationService`/`TranslationService` stay in `apps/api` —
 * deliberately **not** extracted into `@flower/backend` (owner decision:
 * speculative extraction is out of scope; a future task performs the minimum
 * shared extraction only if `worker`/`scheduler` actually need this logic,
 * following the same boundary rules task 2.3 already established).
 */
@Module({
  providers: [
    LocalizationRepository,
    LocalizationService,
    TranslationRepository,
    TranslationService,
    { provide: E_INVOICING_PROVIDER, useClass: NoopEInvoicingProvider },
  ],
  controllers: [LocalizationController],
  exports: [LocalizationService, TranslationService],
})
export class LocalizationModule {}
