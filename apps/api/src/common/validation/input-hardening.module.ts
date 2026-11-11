import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR, APP_PIPE } from '@nestjs/core';
import { FreeTextCardGuardPipe } from './card-data.js';
import { UuidCastErrorInterceptor } from './uuid-cast-error.interceptor.js';

/**
 * Request-input hardening (Phase 3B closure — Task 3b.11 findings F3, V-1, V-2). Two application-wide providers, registered here
 * (imported by `AuditModule`, which already hosts a cross-cutting interceptor) because the request pipeline module and the root
 * module are content-hash-pinned by earlier checkpoints:
 *  - `FreeTextCardGuardPipe` (global pipe): a payment card number is refused in any free-text field of any request body (F3);
 *  - `UuidCastErrorInterceptor` (global interceptor): an unhandled "this id is not a UUID" database / scope error is a 404, never a
 *    500 (V-1 / V-2). Handlers that validate their own ids keep their exact behaviour.
 */
@Module({
  providers: [
    { provide: APP_PIPE, useClass: FreeTextCardGuardPipe },
    { provide: APP_INTERCEPTOR, useClass: UuidCastErrorInterceptor },
  ],
})
export class InputHardeningModule {}
