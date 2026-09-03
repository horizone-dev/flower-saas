import { Body, Controller, Delete, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { Public } from '../../common/auth/public.decorator.js';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { Ctx } from '../../common/context/index.js';
import type { RequestContext } from '../../common/context/index.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { AuthService } from './auth.service.js';
import {
  loginSchema,
  mfaConfirmSchema,
  mfaVerifySchema,
  refreshSchema,
  setPasswordSchema,
  stepUpSchema,
  type LoginDto,
} from './auth.dto.js';

function client(req: FastifyRequest): { ip: string | null; ua: string | null } {
  const fwd = req.headers['x-forwarded-for'];
  const ip = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim() ?? req.ip ?? null;
  const ua = req.headers['user-agent'] ?? null;
  return { ip, ua: Array.isArray(ua) ? (ua[0] ?? null) : ua };
}
const REFRESH_COOKIE = 'flower_refresh';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(@Body(new ZodBody(loginSchema)) dto: LoginDto, @Req() req: FastifyRequest) {
    const { ip, ua } = client(req);
    return this.auth.login({ ...dto, ip, userAgent: ua });
  }

  @Post('mfa/verify')
  @Public()
  @HttpCode(200)
  async mfaVerify(
    @Body(new ZodBody(mfaVerifySchema)) dto: { mfaChallenge: string; code: string },
    @Req() req: FastifyRequest,
  ) {
    const { ip, ua } = client(req);
    return this.auth.verifyMfa({ ...dto, ip, userAgent: ua });
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  async refresh(
    @Body(new ZodBody(refreshSchema)) dto: { refreshToken?: string },
    @Req() req: FastifyRequest,
  ) {
    const token =
      dto.refreshToken ?? (req as { cookies?: Record<string, string> }).cookies?.[REFRESH_COOKIE];
    if (!token) throw new DomainError('REFRESH_MISSING', 'no refresh token', 400);
    return this.auth.refresh(token, client(req).ip);
  }

  @Post('set-password')
  @Public()
  async setPassword(
    @Body(new ZodBody(setPasswordSchema)) dto: { token: string; newPassword: string },
  ) {
    await this.auth.setPassword(dto.token, dto.newPassword);
    return { status: 'ok' };
  }

  @Post('logout')
  @RequirePermission('users:view') // any authenticated tenant user may end their own session
  @HttpCode(200)
  async logout(@Ctx() ctx: RequestContext) {
    if (ctx.sessionId) await this.auth.logout(ctx.sessionId);
    return { status: 'ok' };
  }

  @Post('step-up')
  @RequirePermission('users:view')
  async stepUp(@Body(new ZodBody(stepUpSchema)) dto: { code: string }, @Ctx() ctx: RequestContext) {
    await this.auth.stepUp(
      {
        sessionId: ctx.sessionId!,
        realm: ctx.accountType === 'PLATFORM' ? 'platform' : 'tenant',
        tenantId: ctx.tenantId,
        userId: ctx.userId,
        platformUserId: ctx.platformUserId,
      },
      dto.code,
    );
    return { status: 'ok' };
  }

  @Post('mfa/enrol')
  @RequirePermission('users:view')
  async mfaEnrol(@Ctx() ctx: RequestContext) {
    if (!ctx.tenantId || !ctx.userId)
      throw new DomainError('NOT_TENANT_USER', 'tenant users only', 403);
    // email is not on the context; the URI label uses the user id as a stable ref
    return this.auth.enrolMfa(ctx.tenantId, ctx.userId, ctx.userId);
  }

  @Post('mfa/confirm')
  @RequirePermission('users:view')
  async mfaConfirm(
    @Body(new ZodBody(mfaConfirmSchema)) dto: { code: string },
    @Ctx() ctx: RequestContext,
  ) {
    if (!ctx.tenantId || !ctx.userId)
      throw new DomainError('NOT_TENANT_USER', 'tenant users only', 403);
    await this.auth.confirmMfa(ctx.tenantId, ctx.userId, dto.code);
    return { status: 'ok' };
  }

  @Delete('sessions/:sessionId')
  @RequirePermission('users:manage')
  async revokeSession(@Param('sessionId') sessionId: string, @Ctx() ctx: RequestContext) {
    await this.auth.revokeSession(sessionId, ctx.userId);
    return { status: 'ok' };
  }
}
