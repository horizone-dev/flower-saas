import { Body, Controller, Get, Headers, Param, Put, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { ProductAttributeRepository } from './product-attribute.repository.js';
import { assertUuid, parseIfMatch, requireIfMatch } from './catalog-write.helpers.js';

const replaceSchema = z.object({
  attributes: z
    .array(
      z.object({
        attributeDefinitionId: z.string().uuid(),
        valueText: z.string().max(4000).nullish(),
        valueNumber: z.string().max(40).nullish(),
        valueBool: z.boolean().nullish(),
        valueDate: z.string().max(10).nullish(),
        optionId: z.string().uuid().nullish(),
      }),
    )
    .max(200),
});

/**
 * `/v1/catalog/products/:productId/attributes` — the typed attribute values of
 * one product (task 3.3). `GET` = `catalog:view`; `PUT` = `catalog:manage`, a
 * replace-set guarded by `If-Match: <product.version>` (owner K.3).
 */
@Controller('catalog/products/:productId/attributes')
export class ProductAttributeController {
  constructor(private readonly repo: ProductAttributeRepository) {}

  @Get()
  @RequirePermission('catalog:view')
  async get(
    @Param('productId') productId: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(productId, 'product');
    const out = await this.repo.getForProduct(productId);
    void reply.header('etag', `"${out.productVersion}"`);
    return out;
  }

  @Put()
  @RequirePermission('catalog:manage')
  async replace(
    @Param('productId') productId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(replaceSchema)) dto: z.infer<typeof replaceSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(productId, 'product');
    const out = await this.repo.replaceForProduct(
      productId,
      requireIfMatch(parseIfMatch(ifMatch)),
      dto.attributes,
    );
    void reply.header('etag', `"${out.productVersion}"`);
    return out;
  }
}
