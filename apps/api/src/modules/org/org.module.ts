import { Module } from '@nestjs/common';
import { PlatformModule } from '../platform/platform.module.js';
import { OrgRepository } from './org.repository.js';
import { OrgService } from './org.service.js';
import { OrgController } from './org.controller.js';

/**
 * `org` module (ARCHITECTURE §3): companies / trade licenses / branches / branch
 * settings / POS terminals. Tenant-realm; every create is limit-guarded and
 * scope-checked. `registered_device_required` is not a writable setting in
 * Phase 1 (amendment 1).
 */
@Module({
  imports: [PlatformModule],
  providers: [OrgRepository, OrgService],
  controllers: [OrgController],
  exports: [OrgRepository],
})
export class OrgModule {}
