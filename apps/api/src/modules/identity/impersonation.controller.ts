import { Body, Controller, Delete, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PlatformRealm } from '../../common/auth/pipeline.decorators.js';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { Ctx, type RequestContext } from '../../common/context/index.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { ImpersonationService } from './impersonation.service.js';

const startSchema = z.object({ reason: z.string().min(5).max(500) });

/** Start impersonation — platform realm, platform:tenants:impersonate + step-up. */
@Controller('platform/tenants/:tenantId/impersonate')
@PlatformRealm()
export class ImpersonationController {
  constructor(private readonly impersonation: ImpersonationService) {}

  @Post()
  @RequirePermission('platform:tenants:impersonate')
  @HttpCode(201)
  async start(
    @Param('tenantId') tenantId: string,
    @Body(new ZodBody(startSchema)) dto: { reason: string },
    @Ctx() ctx: RequestContext,
    @Req() req: FastifyRequest,
  ) {
    if (!ctx.platformUserId) throw new DomainError('NOT_PLATFORM', 'platform realm only', 403);
    const ua = req.headers['user-agent'];
    return this.impersonation.start({
      tenantId,
      platformUserId: ctx.platformUserId,
      reason: dto.reason,
      ip: ctx.ip,
      userAgent: Array.isArray(ua) ? (ua[0] ?? null) : (ua ?? null),
    });
  }
}

/**
 * End impersonation — called with the impersonated (tenant) session's token, so
 * this is a tenant-realm route. Any authenticated user may end their own
 * session; the impersonation flag gates the actual work.
 */
@Controller('me/impersonation')
export class EndImpersonationController {
  constructor(private readonly impersonation: ImpersonationService) {}

  @Delete()
  @RequirePermission('users:view')
  @HttpCode(200)
  async stop(@Ctx() ctx: RequestContext) {
    if (ctx.isImpersonating && ctx.sessionId) {
      await this.impersonation.stop(ctx.sessionId, ctx.tenantId, ctx.impersonatorPlatformUserId);
    }
    return { status: 'ok' };
  }
}
