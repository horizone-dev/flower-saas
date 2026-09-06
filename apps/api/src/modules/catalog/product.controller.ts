import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Put,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { fulfilmentStrategySchema } from '@flower/shared-types';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { ProductService } from './product.service.js';
import type { ProductRow } from './product.repository.js';
import { assertUuid, parseIfMatch, requireIfMatch } from './catalog-write.helpers.js';

const listQuery = z.object({
  status: z.enum(['DRAFT', 'ACTIVE', 'ARCHIVED']).optional(),
  categoryId: z.string().uuid().optional(),
  productTypeId: z.string().uuid().optional(),
  fulfilmentStrategy: fulfilmentStrategySchema.optional(),
  q: z.string().max(120).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().uuid().optional(),
});

const createSchema = z.object({
  categoryId: z.string().uuid(),
  productTypeId: z.string().uuid().nullish(),
  slug: z.string().max(128).optional(),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().min(1).max(200).nullish(),
  description: z.string().max(4000).nullish(),
  fulfilmentStrategy: fulfilmentStrategySchema,
  hidePrice: z.boolean().optional(),
});

const updateSchema = z
  .object({
    categoryId: z.string().uuid().optional(),
    productTypeId: z.string().uuid().nullish(),
    slug: z.string().max(128).optional(),
    nameEn: z.string().min(1).max(200).optional(),
    nameAr: z.string().min(1).max(200).nullish(),
    description: z.string().max(4000).nullish(),
    hidePrice: z.boolean().optional(),
    fulfilmentStrategy: fulfilmentStrategySchema.optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'at least one field is required' });

function etag(reply: FastifyReply, row: ProductRow): ProductRow {
  void reply.header('etag', `"${row.version}"`);
  return row;
}

/**
 * `/v1/catalog/products` — the generic tenant catalog product (task 3.2).
 * `catalog:manage` writes / `catalog:view` reads. The `fulfilmentStrategy`
 * capability + entitlement gate is applied by `ProductService` on create, a
 * DRAFT strategy change, and activate — Business Type is never consulted.
 * Concurrency: POST → `Idempotency-Key`; `PUT` / `DELETE` → `If-Match`;
 * `activate` / `archive` → BOTH (owner §14).
 */
@Controller('catalog/products')
export class ProductController {
  constructor(private readonly svc: ProductService) {}

  @Get()
  @RequirePermission('catalog:view')
  list(@Query(new ZodBody(listQuery)) q: z.infer<typeof listQuery>) {
    return this.svc.list(q);
  }

  @Get(':id')
  @RequirePermission('catalog:view')
  async get(@Param('id') id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    assertUuid(id, 'product');
    return etag(reply, await this.svc.get(id));
  }

  @Post()
  @RequirePermission('catalog:manage')
  @Idempotent({ scope: 'catalog.product.create' })
  async create(
    @Body(new ZodBody(createSchema)) dto: z.infer<typeof createSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return etag(reply, await this.svc.create(dto));
  }

  @Put(':id')
  @RequirePermission('catalog:manage')
  async update(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(updateSchema)) dto: z.infer<typeof updateSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'product');
    return etag(reply, await this.svc.update(id, requireIfMatch(parseIfMatch(ifMatch)), dto));
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermission('catalog:manage')
  @Idempotent({ scope: 'catalog.product.activate' })
  async activate(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'product');
    return etag(reply, await this.svc.activate(id, requireIfMatch(parseIfMatch(ifMatch))));
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermission('catalog:manage')
  @Idempotent({ scope: 'catalog.product.archive' })
  async archive(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'product');
    return etag(reply, await this.svc.archive(id, requireIfMatch(parseIfMatch(ifMatch))));
  }

  @Delete(':id')
  @RequirePermission('catalog:manage')
  async remove(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<{ status: 'deleted' }> {
    assertUuid(id, 'product');
    await this.svc.remove(id, requireIfMatch(parseIfMatch(ifMatch)));
    return { status: 'deleted' };
  }
}
