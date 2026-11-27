import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { OrgRepository } from './org.repository.js';
import { OrgService } from './org.service.js';
import { OrgController } from './org.controller.js';
import { ReceiptIdentityRepository } from './receipt-identity.repository.js';
import { ReceiptIdentityController } from './receipt-identity.controller.js';

/**
 * `org` module (ARCHITECTURE §3): companies / trade licenses / branches / branch settings / POS terminals. PR 1a registers only the F-3
 * receipt-identity route here (the frozen `app.module.ts` is byte-locked); the Phase 4 module imports are added by the PRs that ship those modules.
 */
@Module({
  imports: [PlatformModule],
  providers: [OrgRepository, OrgService, ReceiptIdentityRepository],
  controllers: [OrgController, ReceiptIdentityController],
  exports: [OrgRepository],
})
export class OrgModule {}
