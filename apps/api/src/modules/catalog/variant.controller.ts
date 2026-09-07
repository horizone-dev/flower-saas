import { Body, Controller, Get, Headers, HttpCode, Param, Post, Put, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { VariantService } from './variant.service.js';
import type { VariantRow, VariantWithOptions } from './variant.repository.js';
import { assertUuid, parseIfMatch, requireIfMatch } from './catalog-write.helpers.js';

const optionValuesSchema = z
  .array(
    z.object({
      optionGroupId: z.string().uuid(),
      optionValueId: z.string().uuid(),
    }),
  )
  .max(50);

const createSchema = z.object({
  optionValues: optionValuesSchema,
  nameEn: z.string().min(1).max(200).optional(),
  nameAr: z.string().min(1).max(200).nullish(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
});

const updateSchema = z
  .object({
    nameEn: z.string().min(1).max(200).optional(),
    nameAr: z.string().min(1).max(200).nullish(),
    sortOrder: z.number().int().min(0).max(1_000_000).optional(),
    /** a combination change — honoured only while the variant is a DRAFT */
    optionValues: optionValuesSchema.optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'at least one field is required' });

function etagVar(reply: FastifyReply, row: VariantWithOptions): VariantWithOptions {
  void reply.header('etag', `"${row.version}"`);
  return row;
}

/**
 * `/v1/catalog/products/:productId/variants` — list + create the explicit
 * variants of a product (task 3.4). `catalog:view` reads / `variants:manage`
 * writes. The default variant of a simple product is auto-created (no capability
 * check); explicit variants require a product with option groups.
 */
@Controller('catalog/products/:productId/variants')
export class ProductVariantController {
  constructor(private readonly svc: VariantService) {}

  @Get()
  @RequirePermission('catalog:view')
  list(@Param('productId') productId: string): Promise<VariantRow[]> {
    assertUuid(productId, 'product');
    return this.svc.list(productId);
  }

  @Post()
  @RequirePermission('variants:manage')
  @Idempotent({ scope: 'catalog.variant.create' })
  async create(
    @Param('productId') productId: string,
    @Body(new ZodBody(createSchema)) dto: z.infer<typeof createSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(productId, 'product');
    return etagVar(reply, await this.svc.create(productId, dto));
  }
}

/**
 * `/v1/catalog/variants/:id` — a single variant (task 3.4). `catalog:view`
 * reads / `variants:manage` writes. `PUT` → `If-Match: <variant.version>`;
 * `activate` / `archive` → BOTH `Idempotency-Key` + `If-Match` (owner L-15). No
 * public DELETE — archive is the removal / history path.
 */
@Controller('catalog/variants')
export class VariantController {
  constructor(private readonly svc: VariantService) {}

  @Get(':id')
  @RequirePermission('catalog:view')
  async get(@Param('id') id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    assertUuid(id, 'variant');
    return etagVar(reply, await this.svc.get(id));
  }

  @Put(':id')
  @RequirePermission('variants:manage')
  async update(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(updateSchema)) dto: z.infer<typeof updateSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'variant');
    return etagVar(reply, await this.svc.update(id, requireIfMatch(parseIfMatch(ifMatch)), dto));
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermission('variants:manage')
  @Idempotent({ scope: 'catalog.variant.activate' })
  async activate(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'variant');
    return etagVar(reply, await this.svc.activate(id, requireIfMatch(parseIfMatch(ifMatch))));
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermission('variants:manage')
  @Idempotent({ scope: 'catalog.variant.archive' })
  async archive(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'variant');
    return etagVar(reply, await this.svc.archive(id, requireIfMatch(parseIfMatch(ifMatch))));
  }
}
