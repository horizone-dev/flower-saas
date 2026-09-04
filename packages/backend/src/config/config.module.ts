import { Global, Module } from '@nestjs/common';
import { BACKEND_CONFIG, loadBackendConfig, type BackendConfig } from './backend-env.js';

/**
 * Provides `BACKEND_CONFIG` by parsing the process env against
 * `backendEnvSchema`. Used by `apps/worker` and `apps/scheduler`.
 *
 * `apps/api` does **not** import this — it provides `BACKEND_CONFIG` itself from
 * its richer `AppConfig` (one parse, one source of truth for the shared fields).
 */
@Global()
@Module({
  providers: [{ provide: BACKEND_CONFIG, useFactory: (): BackendConfig => loadBackendConfig() }],
  exports: [BACKEND_CONFIG],
})
export class BackendConfigModule {}
