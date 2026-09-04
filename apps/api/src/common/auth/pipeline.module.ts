import { Global, Module } from '@nestjs/common';
import { APP_GUARD, DiscoveryModule, Reflector } from '@nestjs/core';
import { SessionAuthenticator } from '@flower/backend';
import { AccessModule } from '../../modules/access/access.module.js';
import { JwtService } from './jwt.service.js';
import { SessionModule } from './session.module.js';
import { AuthGuard } from './auth.guard.js';
import { PermissionGuard } from './permission.guard.js';

/**
 * The request enforcement pipeline (SECURITY.md). Global guards run in
 * registration order:
 *   1. AuthGuard        — token → session → status; populates RequestContext.
 *                         (`@Public()` bypasses everything.)
 *   2. PermissionGuard  — entitlement → permission (+ step-up) → company scope →
 *                         branch scope, via the pure PolicyEngine.
 *
 * The registered-device step is a documented no-op in Phase 1 (amendment 1). The
 * audit hook (step 13) is added in task 1.14. The Redis-backed SessionStore
 * replaces InMemorySessionStore in task 1.5.
 */
@Global()
@Module({
  imports: [AccessModule, DiscoveryModule, SessionModule],
  providers: [
    Reflector,
    JwtService,
    SessionAuthenticator,
    { provide: APP_GUARD, useClass: AuthGuard },
    { provide: APP_GUARD, useClass: PermissionGuard },
  ],
  exports: [JwtService, SessionAuthenticator, SessionModule],
})
export class PipelineModule {}
