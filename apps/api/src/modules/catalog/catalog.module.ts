import { Module } from '@nestjs/common';
import { CatalogCapabilityRepository } from './catalog-capability.repository.js';
import { CatalogCapabilityService } from './catalog-capability.service.js';
import { CatalogCapabilityController } from './catalog-capability.controller.js';
import { CategoryRepository } from './category.repository.js';
import { CategoryController } from './category.controller.js';
import { ProductTypeRepository } from './product-type.repository.js';
import { ProductTypeController } from './product-type.controller.js';
import { ProductRepository } from './product.repository.js';
import { ProductService } from './product.service.js';
import { ProductController } from './product.controller.js';

/**
 * `catalog` module (Phase 3).
 *   - Task 3.1: the tenant-realm catalog-capability read + the runtime
 *     `CatalogCapabilityService` (consumed by 3.2+).
 *   - Task 3.2: the generic catalog core — Category / Product Type / Product
 *     CRUD + lifecycle. `ProductService` is the first consumer of
 *     `CatalogCapabilityService` (the `fulfilment_strategy` gate).
 * No variants / attributes / identifiers / UOM / pricing / tax / inventory —
 * those are later Task 3.x / Phase 5.
 */
@Module({
  providers: [
    CatalogCapabilityRepository,
    CatalogCapabilityService,
    CategoryRepository,
    ProductTypeRepository,
    ProductRepository,
    ProductService,
  ],
  controllers: [
    CatalogCapabilityController,
    CategoryController,
    ProductTypeController,
    ProductController,
  ],
  exports: [CatalogCapabilityService],
})
export class CatalogModule {}
