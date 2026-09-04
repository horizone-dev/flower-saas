import { Module } from '@nestjs/common';
import { AuditModule } from '../../common/audit/audit.module.js';
import { AccessRepository } from './access.repository.js';
import { PolicyService } from './policy.service.js';
import { PolicyEngine } from './policy-engine.js';
import { SessionAccessRefresher } from './session-access.refresher.js';
import { AccessAdminService } from './access-admin.service.js';
import { AccessController } from './access.controller.js';
import { PlatformTenantAccessController } from './platform-tenant-access.controller.js';

/**
 * `access` module (ARCHITECTURE §3): roles, direct grants/denies, data-scope
 * assignments, the policy engine, permission preview, and the role/grant/scope
 * admin API (task 1.9). The guard pipeline (task 1.4) consumes `PolicyEngine`;
 * the auth guard (1.5) consumes `PolicyService` to populate the session context.
 * `SessionAccessRefresher` rewrites live sessions after an RBAC change so it
 * takes effect on the next request (no logout).
 */
@Module({
  imports: [AuditModule],
  providers: [
    AccessRepository,
    PolicyService,
    PolicyEngine,
    SessionAccessRefresher,
    AccessAdminService,
  ],
  controllers: [AccessController, PlatformTenantAccessController],
  exports: [PolicyService, PolicyEngine],
})
export class AccessModule {}
