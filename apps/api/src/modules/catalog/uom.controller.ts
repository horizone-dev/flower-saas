import { Body, Controller, Delete, Get, Headers, Param, Post, Put, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import { uomFamilySchema, UOM_CONVERSION_REPLACE_MAX } from '@flower/shared-types';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { assertUuid, parseIfMatch, requireIfMatch } from './catalog-write.helpers.js';
import { UomService, VariantUomService } from './uom.service.js';
import type { UomListEntry } from './uom.repository.js';

// A loose pre-check only — the authoritative canonicalization + validation
// (trim + lowercase, then `UOM_CODE_RE`) is `requireUomCode` in the repo layer,
// which surfaces a deterministic `422 UOM_INVALID_CODE` (never a zod 400).
const rawCode = z.string().min(1).max(40);
const ratioPart = z.string().regex(/^\d{1,19}$/, 'must be a positive integer');

const createUomSchema = z
  .object({
    code: rawCode,
    family: uomFamilySchema,
    perBaseNum: ratioPart.optional(),
    perBaseDen: ratioPart.optional(),
    maxDecimals: z.number().int().min(0).max(4).optional(),
    nameEn: z.string().min(1).max(120),
    nameAr: z.string().min(1).max(120).nullish(),
  })
  .strict();

const updateUomSchema = z
  .object({
    nameEn: z.string().min(1).max(120).optional(),
    nameAr: z.string().min(1).max(120).nullish(),
  })
  .strict()
  .refine((o) => Object.keys(o).length > 0, { message: 'at least one field is required' });

const variantConversionsSchema = z.object({
  conversions: z
    .array(
      z.object({
        fromUomCode: rawCode,
        num: ratioPart,
        den: ratioPart.optional(),
      }),
    )
    .max(UOM_CONVERSION_REPLACE_MAX),
});

const productConversionsSchema = z.object({
  conversions: z
    .array(
      z.object({
        fromUomCode: rawCode,
        toUomCode: rawCode,
        num: ratioPart,
        den: ratioPart.optional(),
      }),
    )
    .max(UOM_CONVERSION_REPLACE_MAX),
});

const baseUomSchema = z.object({ baseUomCode: rawCode }).strict();

function etagUom(reply: FastifyReply, row: UomListEntry): UomListEntry {
  if (row.version !== null) void reply.header('etag', `"${row.version}"`);
  return row;
}

/**
 * `/v1/catalog/uoms` — the tenant UOM registry (task 3.6). `catalog:view` reads /
 * `catalog:manage` writes. Every write also requires the `multi_uom` capability
 * (enforced in `UomService`). Semantic fields are immutable — `PUT` edits only
 * the display names (`If-Match: <uom.version>`); `POST` create → `Idempotency-Key`.
 */
@Controller('catalog/uoms')
export class UomController {
  constructor(private readonly svc: UomService) {}

  @Get()
  @RequirePermission('catalog:view')
  list(): Promise<UomListEntry[]> {
    return this.svc.list();
  }

  @Get(':code')
  @RequirePermission('catalog:view')
  async get(@Param('code') code: string, @Res({ passthrough: true }) reply: FastifyReply) {
    return etagUom(reply, await this.svc.get(code));
  }

  @Post()
  @RequirePermission('catalog:manage')
  @Idempotent({ scope: 'catalog.uom.create' })
  async create(
    @Body(new ZodBody(createUomSchema)) dto: z.infer<typeof createUomSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return etagUom(reply, await this.svc.create(dto));
  }

  @Put(':code')
  @RequirePermission('catalog:manage')
  async update(
    @Param('code') code: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(updateUomSchema)) dto: z.infer<typeof updateUomSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return etagUom(
      reply,
      await this.svc.updateNames(code, requireIfMatch(parseIfMatch(ifMatch)), dto),
    );
  }

  @Delete(':code')
  @RequirePermission('catalog:manage')
  async remove(
    @Param('code') code: string,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<{ status: 'deleted' }> {
    await this.svc.remove(code, requireIfMatch(parseIfMatch(ifMatch)));
    return { status: 'deleted' };
  }
}

/**
 * `/v1/catalog/variants/:id/base-uom` + the scoped-conversion replace-sets
 * (task 3.6 §M). `variants:manage` writes / `catalog:view` reads.
 *   - base-UOM assignment: `multi_uom` required ONLY for a tenant-custom code.
 *   - conversion writes: `multi_uom` always required.
 * Each replace-set is guarded by the parent `variant` / `product` version
 * (`If-Match`) — no `Idempotency-Key` (D2-9). The variant GET is the EFFECTIVE
 * projection (own + inherited); the product GET is the STORED rows (incl. inert).
 */
@Controller('catalog')
export class CatalogUomConversionController {
  constructor(private readonly svc: VariantUomService) {}

  @Put('variants/:id/base-uom')
  @RequirePermission('variants:manage')
  async setBaseUom(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(baseUomSchema)) dto: z.infer<typeof baseUomSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'variant');
    const row = await this.svc.setBaseUom(
      id,
      requireIfMatch(parseIfMatch(ifMatch)),
      dto.baseUomCode,
    );
    void reply.header('etag', `"${row.version}"`);
    return row;
  }

  @Get('variants/:id/conversions')
  @RequirePermission('catalog:view')
  async getVariantConversions(
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'variant');
    const out = await this.svc.getVariantConversions(id);
    void reply.header('etag', `"${out.variantVersion}"`);
    return out;
  }

  @Put('variants/:id/conversions')
  @RequirePermission('variants:manage')
  async replaceVariantConversions(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(variantConversionsSchema)) dto: z.infer<typeof variantConversionsSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'variant');
    const out = await this.svc.replaceVariantConversions(
      id,
      requireIfMatch(parseIfMatch(ifMatch)),
      dto.conversions,
    );
    void reply.header('etag', `"${out.variantVersion}"`);
    return out;
  }

  @Get('products/:id/conversions')
  @RequirePermission('catalog:view')
  async getProductConversions(
    @Param('id') id: string,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'product');
    const out = await this.svc.getProductConversions(id);
    void reply.header('etag', `"${out.productVersion}"`);
    return out;
  }

  @Put('products/:id/conversions')
  @RequirePermission('variants:manage')
  async replaceProductConversions(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(productConversionsSchema)) dto: z.infer<typeof productConversionsSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'product');
    const out = await this.svc.replaceProductConversions(
      id,
      requireIfMatch(parseIfMatch(ifMatch)),
      dto.conversions,
    );
    void reply.header('etag', `"${out.productVersion}"`);
    return out;
  }
}
