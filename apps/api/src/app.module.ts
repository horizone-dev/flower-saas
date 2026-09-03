import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './common/db/db.module.js';
import { PipelineModule } from './common/auth/index.js';
import { AccessModule } from './modules/access/access.module.js';
import { HealthModule } from './health/health.module.js';

/**
 * Root module. Domain modules are registered here per phase (`src/modules/*`).
 * Phase 1: config + DB layer + the request enforcement pipeline (auth +
 * permission guards) + access + health.
 */
@Module({
  imports: [ConfigModule, DbModule, PipelineModule, AccessModule, HealthModule],
})
export class AppModule {}
