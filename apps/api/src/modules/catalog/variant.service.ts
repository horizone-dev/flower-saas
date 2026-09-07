import { Injectable } from '@nestjs/common';
import { CatalogCapabilityService } from './catalog-capability.service.js';
import {
  OptionGroupRepository,
  type CreateOptionGroupInput,
  type OptionGroupWithValues,
  type OptionValueInput,
  type UpdateOptionGroupInput,
} from './option-group.repository.js';
import {
  VariantRepository,
  type CreateVariantInput,
  type UpdateVariantInput,
  type VariantRow,
  type VariantWithOptions,
} from './variant.repository.js';

/**
 * The `variants` catalog-capability gate (task 3.1 / spec §A). It guards
 * option-group configuration + EXPLICIT (non-default) variant creation /
 * configuration / lifecycle (owner L-13). It does NOT guard the auto-created
 * default variant (that path is in `ProductRepository`, no capability check) or
 * any read (`catalog:view`). `variants` needs no entitlement module, so only
 * `assertEnabled` is called — never `assertEntitledFor`. Business Type is never
 * consulted (HG3-NO-BT-BRANCH). All data access / concurrency / audit stays in
 * the repositories.
 */
@Injectable()
export class OptionGroupService {
  constructor(
    private readonly repo: OptionGroupRepository,
    private readonly caps: CatalogCapabilityService,
  ) {}

  list(productId: string): Promise<OptionGroupWithValues[]> {
    return this.repo.listForProduct(productId);
  }

  async create(productId: string, input: CreateOptionGroupInput): Promise<OptionGroupWithValues> {
    await this.caps.assertEnabled('variants');
    return this.repo.create(productId, input);
  }

  async update(
    productId: string,
    groupId: string,
    expectedVersion: number,
    input: UpdateOptionGroupInput,
  ): Promise<OptionGroupWithValues> {
    await this.caps.assertEnabled('variants');
    return this.repo.update(productId, groupId, expectedVersion, input);
  }

  async replaceValues(
    productId: string,
    groupId: string,
    expectedVersion: number,
    values: OptionValueInput[],
  ): Promise<OptionGroupWithValues> {
    await this.caps.assertEnabled('variants');
    return this.repo.replaceValues(productId, groupId, expectedVersion, values);
  }

  async remove(
    productId: string,
    groupId: string,
    expectedVersion: number,
  ): Promise<{ recreatedDefaultVariant: boolean }> {
    await this.caps.assertEnabled('variants');
    return this.repo.remove(productId, groupId, expectedVersion);
  }
}

@Injectable()
export class VariantService {
  constructor(
    private readonly repo: VariantRepository,
    private readonly caps: CatalogCapabilityService,
  ) {}

  list(productId: string): Promise<VariantRow[]> {
    return this.repo.listForProduct(productId);
  }

  get(id: string): Promise<VariantWithOptions> {
    return this.repo.get(id);
  }

  async create(productId: string, input: CreateVariantInput): Promise<VariantWithOptions> {
    await this.caps.assertEnabled('variants');
    return this.repo.create(productId, input);
  }

  async update(
    id: string,
    expectedVersion: number,
    input: UpdateVariantInput,
  ): Promise<VariantWithOptions> {
    await this.caps.assertEnabled('variants');
    return this.repo.update(id, expectedVersion, input);
  }

  async activate(id: string, expectedVersion: number): Promise<VariantWithOptions> {
    await this.caps.assertEnabled('variants');
    return this.repo.activate(id, expectedVersion);
  }

  async archive(id: string, expectedVersion: number): Promise<VariantWithOptions> {
    await this.caps.assertEnabled('variants');
    return this.repo.archive(id, expectedVersion);
  }
}
