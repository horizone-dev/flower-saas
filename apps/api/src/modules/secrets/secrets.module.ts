import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';
import { AuditModule } from '../../common/audit/audit.module.js';
import { CRYPTO_PROVIDER, CryptoProvider, DevCryptoProvider } from './crypto-provider.js';
import { SecretsRepository } from './secrets.repository.js';
import { SecretsService } from './secrets.service.js';
import { SecretsController } from './secrets.controller.js';

/**
 * `secrets` module (vault shell — task 1.10). Platform-realm only. Envelope
 * encryption for external credentials; the plaintext lives only inside
 * `SecretsService`, for one call. `CryptoProvider` is swappable — the `dev`
 * (env master key) provider is refused in production by `loadConfig` (G16); a
 * managed KMS provider is wired when a region is onboarded.
 */
@Module({
  imports: [AuditModule],
  providers: [
    SecretsRepository,
    SecretsService,
    DevCryptoProvider,
    {
      provide: CRYPTO_PROVIDER,
      inject: [APP_CONFIG, DevCryptoProvider],
      useFactory: (config: AppConfig, dev: DevCryptoProvider): CryptoProvider => {
        if (config.SECRETS_PROVIDER === 'dev') return dev;
        throw new Error(
          'SECRETS_PROVIDER=kms: no managed KMS crypto provider is wired yet (production is gated — G16)',
        );
      },
    },
  ],
  controllers: [SecretsController],
})
export class SecretsModule {}
