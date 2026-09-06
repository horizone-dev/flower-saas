import { Module } from '@nestjs/common';
import { PlanRepository } from './plan.repository.js';
import { TenantConfigRepository } from './tenant-config.repository.js';
import { TenantRepository } from './tenant.repository.js';
import { ProvisioningRepository } from './provisioning.repository.js';
import { EntitlementService } from './entitlement.service.js';
import { LimitService } from './limit.service.js';
import { ProvisioningService } from './provisioning.service.js';
import { TenantLifecycleService } from './tenant-lifecycle.service.js';
import { AuditReadRepository } from './audit-read.repository.js';
import { PlatformCatalogCapabilityRepository } from './catalog-capability.repository.js';
import { PlatformCatalogCapabilityService } from './catalog-capability.service.js';
import { PlanController } from './plan.controller.js';
import { TenantConfigController } from './tenant-config.controller.js';
import { TenantController } from './tenant.controller.js';
import { AuditController } from './audit.controller.js';
import {
  BusinessTypeTemplateController,
  PlatformTenantCatalogCapabilityController,
} from './catalog-capability.controller.js';

/**
 * `platform` module (ARCHITECTURE §3): plans + versions, entitlements, limits,
 * per-tenant overrides, tenant provisioning + lifecycle. Impersonation lives in
 * `identity` (it needs SessionService). Everything is platform-realm.
 */
@Module({
  providers: [
    PlanRepository,
    TenantConfigRepository,
    TenantRepository,
    ProvisioningRepository,
    EntitlementService,
    LimitService,
    ProvisioningService,
    TenantLifecycleService,
    AuditReadRepository,
    PlatformCatalogCapabilityRepository,
    PlatformCatalogCapabilityService,
  ],
  controllers: [
    PlanController,
    TenantConfigController,
    TenantController,
    AuditController,
    BusinessTypeTemplateController,
    PlatformTenantCatalogCapabilityController,
  ],
  exports: [
    PlanRepository,
    TenantConfigRepository,
    TenantRepository,
    EntitlementService,
    LimitService,
    ProvisioningService,
  ],
})
export class PlatformModule {}
