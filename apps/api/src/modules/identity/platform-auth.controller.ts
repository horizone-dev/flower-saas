import { Body, Controller, HttpCode, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../common/auth/public.decorator.js';
import { PlatformRealm } from '../../common/auth/pipeline.decorators.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { AuthService } from './auth.service.js';
import { platformLoginSchema } from './auth.dto.js';

@Controller('platform/auth')
@PlatformRealm()
export class PlatformAuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(
    @Body(new ZodBody(platformLoginSchema)) dto: { email: string; password: string; code?: string },
    @Req() req: FastifyRequest,
  ) {
    const fwd = req.headers['x-forwarded-for'];
    const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() ?? req.ip ?? null;
    const ua = req.headers['user-agent'];
    return this.auth.platformLogin({
      email: dto.email,
      password: dto.password,
      ...(dto.code ? { code: dto.code } : {}),
      ip,
      userAgent: Array.isArray(ua) ? (ua[0] ?? null) : (ua ?? null),
    });
  }
}
