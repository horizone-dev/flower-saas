import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { HealthModule } from './health/health.module.js';

/**
 * Root module. Domain modules are registered here per phase (`src/modules/*`).
 * Phase 0: config + health only.
 */
@Module({
  imports: [ConfigModule, HealthModule],
})
export class AppModule {}
