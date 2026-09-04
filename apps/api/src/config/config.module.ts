import { Global, Module } from '@nestjs/common';
import { BACKEND_CONFIG, type BackendConfig } from '@flower/backend';
import { APP_CONFIG, loadConfig, type AppConfig } from './env.js';

/**
 * Parses the env once and exposes it under two tokens:
 *   - `APP_CONFIG`      — the full `AppConfig` (HTTP / auth / CORS / secrets),
 *                         used by `apps/api` code.
 *   - `BACKEND_CONFIG`  — the infra subset the `@flower/backend` modules inject
 *                         (`DbService`, `RedisService`, `IdempotencyService`).
 *                         `AppConfig` is a structural superset of `BackendConfig`,
 *                         so it is the *same* frozen object — one parse, one
 *                         source of truth (FC-3).
 */
@Global()
@Module({
  providers: [
    { provide: APP_CONFIG, useFactory: (): AppConfig => loadConfig() },
    {
      provide: BACKEND_CONFIG,
      useFactory: (cfg: AppConfig): BackendConfig => cfg,
      inject: [APP_CONFIG],
    },
  ],
  exports: [APP_CONFIG, BACKEND_CONFIG],
})
export class ConfigModule {}
