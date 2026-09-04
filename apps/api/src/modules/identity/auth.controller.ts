import { Body, Controller, Delete, HttpCode, Inject, Param, Post, Req, Res } from '@nestjs/common';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';
import { Public } from '../../common/auth/public.decorator.js';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { Ctx } from '../../common/context/index.js';
import type { RequestContext } from '../../common/context/index.js';
import { DomainError, ForbiddenError } from '../../common/errors/domain-error.js';
import { parseCookies, serializeCookie } from '../../common/http/cookies.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { AuthService } from './auth.service.js';
import type { LoginResult } from './auth.service.js';
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

/**
 * The refresh token is either returned in the response body (server-side
 * clients — owner-web / super-admin-web store it in their own HttpOnly cookie)
 * or set as an HttpOnly cookie by the API and withheld from the body (browser
 * clients — the POS PWA, which must never hold a refresh credential in
 * JS-readable storage). A client opts into the cookie flow with
 * `X-Auth-Transport: cookie`.
 */
const REFRESH_COOKIE = 'flower_refresh';
const COOKIE_PATH = '/v1/auth';
const TRANSPORT_HEADER = 'x-auth-transport';

function wantsCookie(req: FastifyRequest): boolean {
  const h = req.headers[TRANSPORT_HEADER];
  return (Array.isArray(h) ? h[0] : h) === 'cookie';
}

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  private setRefreshCookie(reply: FastifyReply, value: string): void {
    reply.header(
      'set-cookie',
      serializeCookie(REFRESH_COOKIE, value, {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: COOKIE_PATH,
        maxAge: this.config.AUTH_REFRESH_TOKEN_TTL_SECONDS,
      }),
    );
  }

  private clearRefreshCookie(reply: FastifyReply): void {
    reply.header(
      'set-cookie',
      serializeCookie(REFRESH_COOKIE, '', {
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
        path: COOKIE_PATH,
        maxAge: 0,
      }),
    );
  }

  /** For a cookie-transport client: move the refresh token into an HttpOnly
   *  cookie and strip it from the body. Server-side clients keep the body. */
  private shapeAuthResult(
    result: LoginResult,
    req: FastifyRequest,
    reply: FastifyReply,
  ): LoginResult {
    if (result.status !== 'ok' || !result.refreshToken || !wantsCookie(req)) return result;
    this.setRefreshCookie(reply, result.refreshToken);
    const { refreshToken: _omitted, ...rest } = result;
    void _omitted;
    return rest;
  }

  @Post('login')
  @Public()
  @HttpCode(200)
  async login(
    @Body(new ZodBody(loginSchema)) dto: LoginDto,
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { ip, ua } = client(req);
    return this.shapeAuthResult(await this.auth.login({ ...dto, ip, userAgent: ua }), req, reply);
  }

  @Post('mfa/verify')
  @Public()
  @HttpCode(200)
  async mfaVerify(
    @Body(new ZodBody(mfaVerifySchema)) dto: { mfaChallenge: string; code: string },
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const { ip, ua } = client(req);
    return this.shapeAuthResult(
      await this.auth.verifyMfa({ ...dto, ip, userAgent: ua }),
      req,
      reply,
    );
  }

  @Post('refresh')
  @Public()
  @HttpCode(200)
  async refresh(
    @Body(new ZodBody(refreshSchema)) dto: { refreshToken?: string },
    @Req() req: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const cookieToken = parseCookies(req.headers.cookie)[REFRESH_COOKIE];
    const fromCookie = !dto.refreshToken && !!cookieToken;
    const token = dto.refreshToken ?? cookieToken;
    if (!token) throw new DomainError('REFRESH_MISSING', 'no refresh token', 400);

    // CSRF: a cookie-authenticated refresh must carry the custom transport header.
    // A cross-site page cannot set it on a credentialed request (the CORS
    // allow-list rejects unknown origins), and a form POST cannot set it at all.
    if (fromCookie && !wantsCookie(req)) {
      throw new ForbiddenError(
        'missing X-Auth-Transport header for a cookie refresh',
        'CSRF_BLOCKED',
      );
    }

    const result = await this.auth.refresh(token, client(req).ip);
    return this.shapeAuthResult(result, req, reply);
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
  async logout(@Ctx() ctx: RequestContext, @Res({ passthrough: true }) reply: FastifyReply) {
    if (ctx.sessionId) await this.auth.logout(ctx.sessionId);
    this.clearRefreshCookie(reply); // always — no-op for body-transport clients
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
