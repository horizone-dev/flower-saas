import { Module } from '@nestjs/common';
import { ConfigModule } from './config/config.module.js';
import { DbModule } from './common/db/db.module.js';
import { RedisModule } from './common/redis/redis.module.js';
import { AuditModule } from './common/audit/audit.module.js';
import { PipelineModule } from './common/auth/index.js';
import { AccessModule } from './modules/access/access.module.js';
import { PlatformModule } from './modules/platform/platform.module.js';
import { IdentityModule } from './modules/identity/identity.module.js';
import { OrgModule } from './modules/org/org.module.js';
import { HealthModule } from './health/health.module.js';

/**
 * Root module. Domain modules are registered here per phase (`src/modules/*`).
 * Phase 1: config + DB + Redis + the request enforcement pipeline + access +
 * identity (auth) + health.
 */
@Module({
  imports: [
    ConfigModule,
    DbModule,
    RedisModule,
    AuditModule,
    PipelineModule,
    AccessModule,
    PlatformModule,
    IdentityModule,
    OrgModule,
    HealthModule,
  ],
})
export class AppModule {}
