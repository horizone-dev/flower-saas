import { Module } from '@nestjs/common';
import { CatalogCapabilityRepository } from './catalog-capability.repository.js';
import { CatalogCapabilityService } from './catalog-capability.service.js';
import { CatalogCapabilityController } from './catalog-capability.controller.js';

/**
 * `catalog` module (Phase 3). Task 3.1 ships ONLY the tenant-realm
 * catalog-capability read + the runtime `CatalogCapabilityService` that Tasks
 * 3.2–3.10 consume. No categories / products / variants / identifiers / UOM /
 * pricing / tax — those are later Task 3.x.
 */
@Module({
  providers: [CatalogCapabilityRepository, CatalogCapabilityService],
  controllers: [CatalogCapabilityController],
  exports: [CatalogCapabilityService],
})
export class CatalogModule {}
