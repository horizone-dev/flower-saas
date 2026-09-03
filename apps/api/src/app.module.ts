import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './common/db/db.module.js';
import { HealthModule } from './health/health.module.js';

/**
 * Root module. Domain modules are registered here per phase (`src/modules/*`).
 * Phase 1: config + the DB layer (scoped/platform clients) + health.
 */
@Module({
  imports: [ConfigModule, DbModule, HealthModule],
})
export class AppModule {}
