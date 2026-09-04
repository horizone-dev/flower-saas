import { Controller, Delete, Get, HttpCode, NotFoundException, Param } from '@nestjs/common';
import { PlatformRealm } from '../../common/auth/pipeline.decorators.js';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { SessionService } from './session.service.js';
import { AuthService } from './auth.service.js';

/**
 * `/v1/platform/tenants/:tenantId/sessions` — the Super Admin sessions viewer +
 * revoke (PHASE-1-PLAN §1.11). Platform realm; `platform:sessions:revoke`
 * (step-up). Revocation ends access in seconds (G6). An impersonation token is
 * tenant-realm, so it is rejected here by `AuthGuard`.
 */
@Controller('platform/tenants/:tenantId/sessions')
@PlatformRealm()
export class PlatformSessionsController {
  constructor(
    private readonly sessions: SessionService,
    private readonly auth: AuthService,
  ) {}

  @Get()
  @RequirePermission('platform:sessions:revoke')
  list(@Param('tenantId') tenantId: string) {
    return this.sessions.listForTenant(tenantId);
  }

  @Delete(':sessionId')
  @RequirePermission('platform:sessions:revoke')
  @HttpCode(200)
  async revoke(@Param('tenantId') tenantId: string, @Param('sessionId') sessionId: string) {
    const session = await this.sessions.get(sessionId);
    if (!session || session.tenantId !== tenantId) {
      throw new NotFoundException('session not found');
    }
    // routes through AuthService so the `session.revoked` audit row + the
    // login_security_event are written (task 1.14).
    await this.auth.revokeSession(sessionId, null);
    return { status: 'revoked' };
  }
}
