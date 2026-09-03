import { Body, Controller, Delete, Get, HttpCode, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import { PlatformRealm } from '../../common/auth/pipeline.decorators.js';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { SecretsService } from './secrets.service.js';

const createSchema = z.object({
  provider: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/),
  mode: z.enum(['TEST', 'LIVE']).default('TEST'),
  secret: z.string().min(1).max(8192),
  companyId: z.string().uuid().optional(),
  branchId: z.string().uuid().optional(),
  nonSecretConfig: z.record(z.string(), z.unknown()).optional(),
});
const rotateSchema = z.object({
  secret: z.string().min(1).max(8192),
  nonSecretConfig: z.record(z.string(), z.unknown()).optional(),
});

/**
 * `/v1/platform/tenants/:tenantId/provider-credentials` — the ONLY way an
 * external credential enters or is rotated (CLAUDE.md §26). Platform realm +
 * `platform:secrets:manage` (a step-up platform permission that no tenant role
 * can ever hold — there is no tenant-realm `secrets:*` key). A tenant token is
 * rejected by `AuthGuard` before this controller runs.
 */
@Controller('platform/tenants/:tenantId/provider-credentials')
@PlatformRealm()
export class SecretsController {
  constructor(private readonly secrets: SecretsService) {}

  @Get()
  @RequirePermission('platform:secrets:manage')
  list(@Param('tenantId') tenantId: string) {
    return this.secrets.list(tenantId);
  }

  @Post()
  @RequirePermission('platform:secrets:manage')
  @HttpCode(201)
  create(
    @Param('tenantId') tenantId: string,
    @Body(new ZodBody(createSchema)) dto: z.infer<typeof createSchema>,
  ) {
    return this.secrets.create(tenantId, dto);
  }

  @Get(':id')
  @RequirePermission('platform:secrets:manage')
  get(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    return this.secrets.get(tenantId, id);
  }

  @Put(':id')
  @RequirePermission('platform:secrets:manage')
  rotate(
    @Param('tenantId') tenantId: string,
    @Param('id') id: string,
    @Body(new ZodBody(rotateSchema)) dto: z.infer<typeof rotateSchema>,
  ) {
    return this.secrets.rotate(tenantId, id, dto);
  }

  @Delete(':id')
  @RequirePermission('platform:secrets:manage')
  @HttpCode(200)
  async revoke(@Param('tenantId') tenantId: string, @Param('id') id: string) {
    await this.secrets.revoke(tenantId, id);
    return { status: 'revoked' };
  }
}
