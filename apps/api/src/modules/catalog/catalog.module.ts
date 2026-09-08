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
import { OptionGroupRepository } from './option-group.repository.js';
import { VariantRepository } from './variant.repository.js';
import { OptionGroupService, VariantService } from './variant.service.js';
import { OptionGroupController } from './option-group.controller.js';
import { ProductVariantController, VariantController } from './variant.controller.js';
import { IdentifierRepository } from './identifier.repository.js';
import { IdentifierService } from './identifier.service.js';
import { IdentifierController } from './identifier.controller.js';
import { UomRepository } from './uom.repository.js';
import { UomConversionRepository } from './uom-conversion.repository.js';
import { UomService, VariantUomService } from './uom.service.js';
import { UomController, CatalogUomConversionController } from './uom.controller.js';
import { CompanyPricingRepository } from './company-pricing.repository.js';
import { CompanyPricingController } from './company-pricing.controller.js';

/**
 * `catalog` module (Phase 3).
 *   - Task 3.1: the tenant-realm catalog-capability read + `CatalogCapabilityService`.
 *   - Task 3.2: the generic catalog core — Category / Product Type / Product.
 *   - Task 3.3: typed attribute definitions + ENUM options + per-product typed
 *     attribute values; the required-attribute completeness gate on product
 *     activate lives in `ProductRepository` (atomic, owner K.2).
 *   - Task 3.4: variants + option groups (price/currency/SKU/UOM-neutral). The
 *     auto default-variant creation + the "≥1 non-archived variant" gate for a
 *     non-CUSTOM product activation live in `ProductRepository`; explicit
 *     variant / option-group writes gate on the `variants` capability.
 *   - Task 3.5: the scannable-code registry — `item_identifier` (SKU / BARCODE /
 *     QR), VARIANT-only target, tenant-scoped, company/branch/price/stock-neutral.
 *     BARCODE / QR writes gate on `identifiers.barcode_qr`; SKU writes do not.
 *     The Task-3.4 default-variant restructure guard (`VARIANT_HAS_IDENTIFIERS`)
 *     lives in `variant.repository` / `product.repository`.
 *   - Task 3.6: the tenant UOM registry + variant base UOM + variant/product
 *     scoped pack conversions; the `multi_uom` capability gates every write.
 *   - Task 3.7: company per-UOM SELL pricing — `company_variant_price_set`
 *     (the version aggregate) + `company_variant_uom_price` (the independent
 *     stored Money per selling UOM tier, never `base × factor`). `pricing:manage`
 *     writes / `catalog:view` reads; company-scoped; no capability gate (company
 *     pricing is foundational). The additive Task-3.6 guard rules (base-UOM
 *     change / custom-UOM delete blocked while a price row references the
 *     variant / UOM) live in `variant.repository` / `uom.repository`.
 * No branch pricing / tax computation / discount / inventory — later Task 3.x / Phase 5.
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
    OptionGroupRepository,
    VariantRepository,
    OptionGroupService,
    VariantService,
    IdentifierRepository,
    IdentifierService,
    UomRepository,
    UomConversionRepository,
    UomService,
    VariantUomService,
    CompanyPricingRepository,
  ],
  controllers: [
    CatalogCapabilityController,
    CategoryController,
    ProductTypeController,
    ProductController,
    AttributeDefinitionController,
    ProductAttributeController,
    OptionGroupController,
    ProductVariantController,
    VariantController,
    IdentifierController,
    UomController,
    CatalogUomConversionController,
    CompanyPricingController,
  ],
  exports: [CatalogCapabilityService],
})
export class CatalogModule {}
