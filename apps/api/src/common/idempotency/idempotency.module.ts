import { Global, Module } from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import { IdempotencyInterceptor } from './idempotency.interceptor.js';
import { IdempotencyRepository } from './idempotency.repository.js';
import { IdempotencyService } from './idempotency.service.js';

/**
 * Idempotency store (task 2.2). Opt-in per route via `@Idempotent({ scope })`.
 * The global interceptor no-ops on an undecorated route. `DbService` +
 * `APP_CONFIG` are global.
 */
@Global()
@Module({
  providers: [
    Reflector,
    IdempotencyRepository,
    IdempotencyService,
    { provide: APP_INTERCEPTOR, useClass: IdempotencyInterceptor },
  ],
  exports: [IdempotencyService, IdempotencyRepository],
})
export class IdempotencyModule {}
