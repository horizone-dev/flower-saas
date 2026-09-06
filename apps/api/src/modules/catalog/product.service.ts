import { Injectable } from '@nestjs/common';
import type { FulfilmentStrategy } from '@flower/shared-types';
import { DomainError } from '../../common/errors/domain-error.js';
import { CatalogCapabilityService } from './catalog-capability.service.js';
import {
  ProductRepository,
  type CreateProductInput,
  type ProductRow,
  type UpdateProductInput,
} from './product.repository.js';

/**
 * The first consumer of `CatalogCapabilityService` (owner §5 / §6). It applies
 * the strategy gate — `assertEnabled(strategy.*)` (409 `CAPABILITY_NOT_ENABLED`)
 * ∧ `assertEntitledFor` (403 `MODULE_NOT_ENTITLED`) — on:
 *   - product create
 *   - a DRAFT `fulfilmentStrategy` change
 *   - product activate (DRAFT/ARCHIVED → ACTIVE)
 * `tenant.businessTypeKey` is NEVER consulted (HG3-NO-BT-BRANCH). All data
 * access + optimistic concurrency + audit stays in `ProductRepository`.
 */
@Injectable()
export class ProductService {
  constructor(
    private readonly repo: ProductRepository,
    private readonly caps: CatalogCapabilityService,
  ) {}

  async create(input: CreateProductInput): Promise<ProductRow> {
    await this.caps.assertStrategyAllowed(input.fulfilmentStrategy);
    return this.repo.create(input);
  }

  async update(
    id: string,
    expectedVersion: number,
    input: UpdateProductInput,
  ): Promise<ProductRow> {
    if (input.fulfilmentStrategy !== undefined) {
      const current = await this.repo.get(id);
      const changing = input.fulfilmentStrategy !== current.fulfilmentStrategy;
      if (changing) {
        if (current.status !== 'DRAFT') {
          throw new DomainError(
            'PRODUCT_STRATEGY_LOCKED',
            'fulfilmentStrategy can only change while the product is a DRAFT',
            409,
          );
        }
        await this.caps.assertStrategyAllowed(input.fulfilmentStrategy);
      }
    }
    return this.repo.update(id, expectedVersion, input);
  }

  /** Activation re-runs the strategy gate for the product's CURRENT strategy
   *  (owner §12). "ACTIVE" means "catalog definition active", not "sellable"
   *  (owner §7) — no price / variant / availability check here or later on this
   *  Task 3.2 row. */
  async activate(id: string, expectedVersion: number): Promise<ProductRow> {
    const current = await this.repo.get(id);
    await this.caps.assertStrategyAllowed(current.fulfilmentStrategy as FulfilmentStrategy);
    return this.repo.activate(id, expectedVersion);
  }

  archive(id: string, expectedVersion: number): Promise<ProductRow> {
    return this.repo.archive(id, expectedVersion);
  }

  get(id: string): Promise<ProductRow> {
    return this.repo.get(id);
  }

  list(filter: Parameters<ProductRepository['list']>[0]) {
    return this.repo.list(filter);
  }

  remove(id: string, expectedVersion: number): Promise<void> {
    return this.repo.remove(id, expectedVersion);
  }
}
