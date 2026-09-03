import { Module } from '@nestjs/common';
import { PlanRepository } from './plan.repository.js';
import { TenantConfigRepository } from './tenant-config.repository.js';
import { EntitlementService } from './entitlement.service.js';
import { LimitService } from './limit.service.js';
import { PlanController } from './plan.controller.js';
import { TenantConfigController } from './tenant-config.controller.js';

/**
 * `platform` module (ARCHITECTURE §3): plans + versions, entitlements, limits,
 * per-tenant overrides. Tenant provisioning + impersonation land here in task
 * 1.7. Everything is platform-realm.
 */
@Module({
  providers: [PlanRepository, TenantConfigRepository, EntitlementService, LimitService],
  controllers: [PlanController, TenantConfigController],
  exports: [PlanRepository, TenantConfigRepository, EntitlementService, LimitService],
})
export class PlatformModule {}
