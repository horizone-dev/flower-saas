import { Module } from '@nestjs/common';
import { AccessRepository } from './access.repository.js';
import { PolicyService } from './policy.service.js';
import { PolicyEngine } from './policy-engine.js';

/**
 * `access` module (ARCHITECTURE §3): roles, direct grants/denies, data-scope
 * assignments, the policy engine, permission preview. The guard pipeline (task
 * 1.4) consumes `PolicyEngine`; the auth guard (1.5) consumes `PolicyService`
 * to populate the session context.
 */
@Module({
  providers: [AccessRepository, PolicyService, PolicyEngine],
  exports: [PolicyService, PolicyEngine],
})
export class AccessModule {}
