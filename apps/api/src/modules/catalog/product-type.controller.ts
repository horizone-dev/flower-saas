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
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { ProductTypeRepository, type ProductTypeRow } from './product-type.repository.js';
import { assertUuid, parseIfMatch, requireIfMatch } from './catalog-write.helpers.js';

const listQuery = z.object({
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  q: z.string().max(120).optional(),
});

const createSchema = z.object({
  key: z.string().min(2).max(64),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().min(1).max(200).nullish(),
});

const updateSchema = z
  .object({
    nameEn: z.string().min(1).max(200).optional(),
    nameAr: z.string().min(1).max(200).nullish(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'at least one field is required' });

function etag(reply: FastifyReply, row: ProductTypeRow): ProductTypeRow {
  void reply.header('etag', `"${row.version}"`);
  return row;
}

/** `/v1/catalog/product-types` — tenant-defined reusable classifications
 *  (task 3.2). Generic, classification-only — NO behaviour source (owner §4/§10). */
@Controller('catalog/product-types')
export class ProductTypeController {
  constructor(private readonly repo: ProductTypeRepository) {}

  @Get()
  @RequirePermission('catalog:view')
  list(@Query(new ZodBody(listQuery)) q: z.infer<typeof listQuery>) {
    return this.repo.list(q);
  }

  @Get(':id')
  @RequirePermission('catalog:view')
  async get(@Param('id') id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    assertUuid(id, 'product type');
    return etag(reply, await this.repo.get(id));
  }

  @Post()
  @RequirePermission('catalog:manage')
  @Idempotent({ scope: 'catalog.product_type.create' })
  async create(
    @Body(new ZodBody(createSchema)) dto: z.infer<typeof createSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    return etag(reply, await this.repo.create(dto));
  }

  @Put(':id')
  @RequirePermission('catalog:manage')
  async update(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(updateSchema)) dto: z.infer<typeof updateSchema>,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'product type');
    return etag(reply, await this.repo.update(id, requireIfMatch(parseIfMatch(ifMatch)), dto));
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermission('catalog:manage')
  @Idempotent({ scope: 'catalog.product_type.archive' })
  async archive(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'product type');
    return etag(
      reply,
      await this.repo.setStatus(id, requireIfMatch(parseIfMatch(ifMatch)), 'ARCHIVED'),
    );
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermission('catalog:manage')
  @Idempotent({ scope: 'catalog.product_type.activate' })
  async activate(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'product type');
    return etag(
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
    assertUuid(id, 'product type');
    await this.repo.remove(id, requireIfMatch(parseIfMatch(ifMatch)));
    return { status: 'deleted' };
  }
}
