import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { createPrismaClient, type PrismaClient } from '@flower/db';
import { BACKEND_CONFIG, type BackendConfig } from '../config/backend-env.js';

/**
 * The single place a `PrismaClient` is constructed. Two connections:
 *   - the **app** client — every tenant-scoped query runs through `runScoped`,
 *     which drops to `flower_app` and sets `app.tenant_id` (RLS enforced).
 *   - the **platform** client — the separate, audited cross-tenant path
 *     (`flower_platform`, BYPASSRLS — ADR-0014), used only by `PlatformRepository`.
 *
 * In dev/CI both may point at the same `DATABASE_URL`; `runScoped` / `runPlatform`
 * still switch role via `SET LOCAL ROLE`.
 *
 * Shared by `apps/api`, `apps/worker` and `apps/scheduler` (FC-3) — one client
 * construction path, one RLS posture, for every runtime.
 */
@Injectable()
export class DbService implements OnModuleDestroy {
  private app: PrismaClient | null = null;
  private platform: PrismaClient | null = null;

  constructor(@Inject(BACKEND_CONFIG) private readonly config: BackendConfig) {}

  /** The app connection. Never call `.<model>` on it directly from a scoped
   *  module — go through `ScopedRepository` (lint-enforced). */
  appClient(): PrismaClient {
    if (!this.app) {
      if (!this.config.DATABASE_URL) throw new Error('DATABASE_URL is not set');
      this.app = createPrismaClient({ connectionString: this.config.DATABASE_URL });
    }
    return this.app;
  }

  /** The platform (BYPASSRLS) connection. Reachable only from `PlatformRepository`. */
  platformClient(): PrismaClient {
    if (!this.platform) {
      const url = this.config.PLATFORM_DATABASE_URL ?? this.config.DATABASE_URL;
      if (!url) throw new Error('PLATFORM_DATABASE_URL / DATABASE_URL is not set');
      this.platform = createPrismaClient({ connectionString: url });
    }
    return this.platform;
  }

  async onModuleDestroy(): Promise<void> {
    await Promise.allSettled([this.app?.$disconnect(), this.platform?.$disconnect()]);
  }
}

@Global()
@Module({
  providers: [DbService],
  exports: [DbService],
})
export class DbModule {}
