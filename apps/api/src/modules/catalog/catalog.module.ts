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
import { AttributeDefinitionRepository } from './attribute-definition.repository.js';
import { AttributeDefinitionController } from './attribute-definition.controller.js';
import { ProductAttributeRepository } from './product-attribute.repository.js';
import { ProductAttributeController } from './product-attribute.controller.js';

/**
 * `catalog` module (Phase 3).
 *   - Task 3.1: the tenant-realm catalog-capability read + `CatalogCapabilityService`.
 *   - Task 3.2: the generic catalog core — Category / Product Type / Product.
 *   - Task 3.3: typed attribute definitions + ENUM options + per-product typed
 *     attribute values; the required-attribute completeness gate on product
 *     activate lives in `ProductRepository` (atomic, owner K.2).
 * No variants / identifiers / UOM / pricing / tax / inventory — later Task 3.x / Phase 5.
 */
@Module({
  providers: [
    CatalogCapabilityRepository,
    CatalogCapabilityService,
    CategoryRepository,
    ProductTypeRepository,
    ProductRepository,
    ProductService,
    AttributeDefinitionRepository,
    ProductAttributeRepository,
  ],
  controllers: [
    CatalogCapabilityController,
    CategoryController,
    ProductTypeController,
    ProductController,
    AttributeDefinitionController,
    ProductAttributeController,
  ],
  exports: [CatalogCapabilityService],
})
export class CatalogModule {}
