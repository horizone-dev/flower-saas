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
import { CategoryRepository, type CategoryRow } from './category.repository.js';
import { assertUuid, parseIfMatch, requireIfMatch } from './catalog-write.helpers.js';

const listQuery = z.object({
  status: z.enum(['ACTIVE', 'ARCHIVED']).optional(),
  parentId: z.string().uuid().optional(),
  q: z.string().max(120).optional(),
});

const createSchema = z.object({
  parentId: z.string().uuid().nullish(),
  slug: z.string().max(63).optional(),
  nameEn: z.string().min(1).max(200),
  nameAr: z.string().min(1).max(200).nullish(),
  sortOrder: z.number().int().min(0).max(1_000_000).optional(),
});

const updateSchema = z
  .object({
    slug: z.string().max(63).optional(),
    nameEn: z.string().min(1).max(200).optional(),
    nameAr: z.string().min(1).max(200).nullish(),
    sortOrder: z.number().int().min(0).max(1_000_000).optional(),
    parentId: z.string().uuid().nullish(),
  })
  .refine((o) => Object.keys(o).length > 0, { message: 'at least one field is required' });

function etag(reply: FastifyReply, row: CategoryRow): CategoryRow {
  void reply.header('etag', `"${row.version}"`);
  return row;
}

/** `/v1/catalog/categories` — tenant catalog category CRUD (task 3.2).
 *  `catalog:view` reads, `catalog:manage` writes. D2-9 concurrency:
 *  POST → `Idempotency-Key`; `PUT` / lifecycle / `DELETE` → `If-Match`;
 *  lifecycle commands take BOTH (owner §14). */
@Controller('catalog/categories')
export class CategoryController {
  constructor(private readonly repo: CategoryRepository) {}

  @Get()
  @RequirePermission('catalog:view')
  list(@Query(new ZodBody(listQuery)) q: z.infer<typeof listQuery>) {
    return this.repo.list(q);
  }

  @Get(':id')
  @RequirePermission('catalog:view')
  async get(@Param('id') id: string, @Res({ passthrough: true }) reply: FastifyReply) {
    assertUuid(id, 'category');
    return etag(reply, await this.repo.get(id));
  }

  @Post()
  @RequirePermission('catalog:manage')
  @Idempotent({ scope: 'catalog.category.create' })
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
    assertUuid(id, 'category');
    return etag(reply, await this.repo.update(id, requireIfMatch(parseIfMatch(ifMatch)), dto));
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermission('catalog:manage')
  @Idempotent({ scope: 'catalog.category.archive' })
  async archive(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'category');
    return etag(
      reply,
      await this.repo.setStatus(id, requireIfMatch(parseIfMatch(ifMatch)), 'ARCHIVED'),
    );
  }

  @Post(':id/activate')
  @HttpCode(200)
  @RequirePermission('catalog:manage')
  @Idempotent({ scope: 'catalog.category.activate' })
  async activate(
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(id, 'category');
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
    assertUuid(id, 'category');
    await this.repo.remove(id, requireIfMatch(parseIfMatch(ifMatch)));
    return { status: 'deleted' };
  }
}
