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
import { attributeValueTypeSchema } from '@flower/shared-types';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import {
  AttributeDefinitionRepository,
  type AttributeDefinitionRow,
  type AttributeDefinitionWithOptions,
} from './attribute-definition.repository.js';
import { assertUuid, parseIfMatch, requireIfMatch } from './catalog-write.helpers.js';

const listQuery = z.object({
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  appliesToCategoryId: z.string().uuid().optional(),
  appliesToProductTypeId: z.string().uuid().optional(),
  valueType: attributeValueTypeSchema.optional(),
  isVariantOption: z.enum(['true', 'false']).optional(),
  q: z.string().max(120).optional(),
});

const createSchema = z.object({
  key: z.string().min(2).max(64),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().min(1).max(200).nullish(),
  valueType: attributeValueTypeSchema,
  appliesToCategoryId: z.string().uuid().nullish(),
  appliesToProductTypeId: z.string().uuid().nullish(),
  unitHint: z.string().min(1).max(60).nullish(),
  isVariantOption: z.boolean().optional(),
  required: z.boolean().optional(),
});

const updateSchema = z
  .object({
    // `key` and `valueType` are immutable (data-integrity rule 2) — not accepted
    nameEn: z.string().min(1).max(200).optional(),
    nameAr: z.string().min(1).max(200).nullish(),
    unitHint: z.string().min(1).max(60).nullish(),
    isVariantOption: z.boolean().optional(),
    required: z.boolean().optional(),
    appliesToCategoryId: z.string().uuid().nullish(),
    appliesToProductTypeId: z.string().uuid().nullish(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'at least one field is required' });

const optionsSchema = z.object({
  options: z
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
    .max(500),
});

function etagDef<T extends { version: number }>(reply: FastifyReply, row: T): T {
  void reply.header('etag', `"${row.version}"`);
  return row;
}

/** `/v1/catalog/attribute-definitions` — tenant typed attribute definitions +
 *  their ENUM options (task 3.3). `catalog:view` reads / `catalog:manage`
 *  writes. Options are a parent-controlled replace-set (owner K.4). */
@Controller('catalog/attribute-definitions')
export class AttributeDefinitionController {
  constructor(private readonly repo: AttributeDefinitionRepository) {}

  @Get()
  @RequirePermission('catalog:view')
  list(
    @Query(new ZodBody(listQuery)) q: z.infer<typeof listQuery>,
  ): Promise<AttributeDefinitionRow[]> {
    return this.repo.list({
      ...q,
      isVariantOption: q.isVariantOption === undefined ? undefined : q.isVariantOption === 'true',
    });
  }

  @Get(':id')
  @RequirePermission('catalog:view')
  async get(@Param('id') id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    assertUuid(id, 'attribute definition');
    return etagDef(reply, await this.repo.get(id));
  }

  @Post()
  @RequirePermission('catalog:manage')
  @Idempotent({ scope: 'catalog.attribute_definition.create' })
  async create(
    @Body(new ZodBody(createSchema)) dto: z.infer<typeof createSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return etagDef(reply, await this.repo.create(dto));
  }

  @Put(':id')
  @RequirePermission('catalog:manage')
  async update(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(updateSchema)) dto: z.infer<typeof updateSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'attribute definition');
    return etagDef(reply, await this.repo.update(id, requireIfMatch(parseIfMatch(ifMatch)), dto));
  }

  @Put(':id/options')
  @RequirePermission('catalog:manage')
  async setOptions(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(optionsSchema)) dto: z.infer<typeof optionsSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ): Promise<AttributeDefinitionWithOptions> {
    assertUuid(id, 'attribute definition');
    return etagDef(
      reply,
      await this.repo.replaceOptions(id, requireIfMatch(parseIfMatch(ifMatch)), dto.options),
    );
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermission('catalog:manage')
  @Idempotent({ scope: 'catalog.attribute_definition.archive' })
  async archive(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'attribute definition');
    return etagDef(
      reply,
      await this.repo.setStatus(id, requireIfMatch(parseIfMatch(ifMatch)), 'ARCHIVED'),
    );
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermission('catalog:manage')
  @Idempotent({ scope: 'catalog.attribute_definition.activate' })
  async activate(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'attribute definition');
    return etagDef(
      reply,
      await this.repo.setStatus(id, requireIfMatch(parseIfMatch(ifMatch)), 'ACTIVE'),
    );
  }

  @Delete(':id')
  @RequirePermission('catalog:manage')
  async remove(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
  ): Promise<{ status: 'deleted' }> {
    assertUuid(id, 'attribute definition');
    await this.repo.remove(id, requireIfMatch(parseIfMatch(ifMatch)));
    return { status: 'deleted' };
  }
}
