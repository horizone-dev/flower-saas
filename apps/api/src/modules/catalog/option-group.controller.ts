import { Body, Controller, Delete, Get, Headers, Param, Post, Put, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { OptionGroupService } from './variant.service.js';
import type { OptionGroupWithValues } from './option-group.repository.js';
import { assertUuid, parseIfMatch, requireIfMatch } from './catalog-write.helpers.js';

const createSchema = z.object({
  key: z.string().min(2).max(64),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().min(1).max(200).nullish(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
});

const updateSchema = z
  .object({
    // `key` is immutable (owner L-11) — not accepted
    nameEn: z.string().min(1).max(200).optional(),
    nameAr: z.string().min(1).max(200).nullish(),
    sortOrder: z.number().int().min(0).max(1_000_000).optional(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'at least one field is required' });

const valuesSchema = z.object({
  values: z
    .array(
      z.object({
        value: z
          .string()
          .min(1)
          .max(120)
          .regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,119}$/, 'invalid option value'),
        labelEn: z.string().min(1).max(200),
        labelAr: z.string().min(1).max(200).nullish(),
        sortOrder: z.number().int().min(0).max(1_000_000).optional(),
      }),
    )
    .max(200),
});

function etagG(reply: FastifyReply, row: OptionGroupWithValues): OptionGroupWithValues {
  void reply.header('etag', `"${row.version}"`);
  return row;
}

/**
 * `/v1/catalog/products/:productId/option-groups` — per-product variant
 * dimensions (task 3.4). `catalog:view` reads / `variants:manage` writes (the
 * ALREADY-RESERVED key — owner L-16). Structural add / remove only while the
 * product is DRAFT; values are a parent-controlled replace-set guarded by
 * `If-Match: <option_group.version>` (owner L-11 / L-12).
 */
@Controller('catalog/products/:productId/option-groups')
export class OptionGroupController {
  constructor(private readonly svc: OptionGroupService) {}

  @Get()
  @RequirePermission('catalog:view')
  list(@Param('productId') productId: string): Promise<OptionGroupWithValues[]> {
    assertUuid(productId, 'product');
    return this.svc.list(productId);
  }

  @Post()
  @RequirePermission('variants:manage')
  @Idempotent({ scope: 'catalog.option_group.create' })
  async create(
    @Param('productId') productId: string,
    @Body(new ZodBody(createSchema)) dto: z.infer<typeof createSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(productId, 'product');
    return etagG(reply, await this.svc.create(productId, dto));
  }

  @Put(':groupId')
  @RequirePermission('variants:manage')
  async update(
    @Param('productId') productId: string,
    @Param('groupId') groupId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(updateSchema)) dto: z.infer<typeof updateSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(productId, 'product');
    assertUuid(groupId, 'option group');
    return etagG(
      reply,
      await this.svc.update(productId, groupId, requireIfMatch(parseIfMatch(ifMatch)), dto),
    );
  }

  @Put(':groupId/values')
  @RequirePermission('variants:manage')
  async setValues(
    @Param('productId') productId: string,
    @Param('groupId') groupId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(valuesSchema)) dto: z.infer<typeof valuesSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(productId, 'product');
    assertUuid(groupId, 'option group');
    return etagG(
      reply,
      await this.svc.replaceValues(
        productId,
        groupId,
        requireIfMatch(parseIfMatch(ifMatch)),
        dto.values,
      ),
    );
  }

  @Delete(':groupId')
  @RequirePermission('variants:manage')
  async remove(
    @Param('productId') productId: string,
    @Param('groupId') groupId: string,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<{ status: 'deleted'; recreatedDefaultVariant: boolean }> {
    assertUuid(productId, 'product');
    assertUuid(groupId, 'option group');
    const out = await this.svc.remove(productId, groupId, requireIfMatch(parseIfMatch(ifMatch)));
    return { status: 'deleted', recreatedDefaultVariant: out.recreatedDefaultVariant };
  }
}
