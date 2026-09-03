import { Module } from '@nestjs/common';
import { AccessModule } from '../access/access.module.js';
import { PasswordService } from '../../common/crypto/password.service.js';
import { TotpService } from '../../common/crypto/totp.service.js';
import { IdentityRepository } from './identity.repository.js';
import { PlatformIdentityRepository } from './platform-identity.repository.js';
import { RefreshTokenStore } from './refresh-token.store.js';
import { BruteForceService } from './brute-force.service.js';
import { SessionService } from './session.service.js';
import { AuthService } from './auth.service.js';
import { AuthController } from './auth.controller.js';
import { PlatformAuthController } from './platform-auth.controller.js';
import { MeController } from './me.controller.js';

/**
 * `identity` module (ARCHITECTURE §3): users, credentials, MFA, sessions, refresh
 * tokens, login security events. Auth for both realms + `/v1/me`.
 */
@Module({
  imports: [AccessModule],
  controllers: [AuthController, PlatformAuthController, MeController],
  providers: [
    PasswordService,
    TotpService,
    IdentityRepository,
    PlatformIdentityRepository,
    RefreshTokenStore,
    BruteForceService,
    SessionService,
    AuthService,
  ],
  exports: [AuthService, SessionService, IdentityRepository, PlatformIdentityRepository],
})
export class IdentityModule {}
