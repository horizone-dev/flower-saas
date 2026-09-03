import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './common/db/db.module.js';
import { AccessModule } from './modules/access/access.module.js';
import { HealthModule } from './health/health.module.js';

/**
 * Root module. Domain modules are registered here per phase (`src/modules/*`).
 * Phase 1: config + the DB layer + access (policy engine) + health.
 */
@Module({
  imports: [ConfigModule, DbModule, AccessModule, HealthModule],
})
export class AppModule {}
