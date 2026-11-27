import { Logger, Module } from '@nestjs/common';
import {
  APP_CONFIG,
  assertSecretsDisabledAuthorization,
  type AppConfig,
} from '../../config/env.js';
import { AuditModule } from '../../common/audit/audit.module.js';
import {
  CRYPTO_PROVIDER,
  CryptoProvider,
  DevCryptoProvider,
  DisabledCryptoProvider,
} from './crypto-provider.js';
import { SecretsRepository } from './secrets.repository.js';
import { SecretsService } from './secrets.service.js';
import { SecretsController } from './secrets.controller.js';

/**
 * The ONE place a crypto provider is chosen. R-1a: the authorization for the disabled vault is re-checked here, so a config assembled
 * without `loadConfig` (a test helper, a future bootstrap path) cannot reach `DisabledCryptoProvider` unauthorized, and an expired
 * authorization stops a restart. The vault being disabled is announced once at startup (never any secret).
 */
export function createCryptoProvider(
  config: AppConfig,
  dev: DevCryptoProvider,
  now: Date = new Date(),
): CryptoProvider {
  assertSecretsDisabledAuthorization(config, now);
  if (config.SECRETS_PROVIDER === 'dev') return dev;
  if (config.SECRETS_PROVIDER === 'disabled') {
    new Logger('SecretsModule').warn(
      `Secrets vault is DISABLED (SECRETS_PROVIDER=disabled): authorized for internal alpha only until ${config.SECRETS_DISABLED_UNTIL}; no provider credential can be stored or read`,
    );
    return new DisabledCryptoProvider();
  }
  throw new Error(
    'SECRETS_PROVIDER=kms: no managed KMS crypto provider is wired yet (production is gated — G16)',
  );
}

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
      useFactory: (config: AppConfig, dev: DevCryptoProvider): CryptoProvider =>
        createCryptoProvider(config, dev),
    },
  ],
  controllers: [SecretsController],
})
export class SecretsModule {}
