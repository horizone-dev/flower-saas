import { Inject, Injectable, Logger } from '@nestjs/common';
import type { ReadinessResponse } from '@flower/shared-types';
import type { PrismaClient } from '@flower/db';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { DbService } from '../common/db/db.module.js';
import { tcpProbe } from './tcp-probe.js';

type CheckState = 'ok' | 'down';

@Injectable()
export class HealthService {
  private readonly log = new Logger(HealthService.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly dbService: DbService,
  ) {}

  private db(): PrismaClient | null {
    try {
      return this.dbService.appClient();
    } catch {
      return null;
    }
  }

  /** Liveness — the process is up and can serve. */
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness — every dependency the API needs to do real work.
   * db: `SELECT 1`. migrations: the latest `_prisma_migrations` row is finished
   * and not rolled back. redis / storage: TCP reachability (protocol-level checks
   * arrive with those modules in later phases).
   */
  async readiness(): Promise<ReadinessResponse> {
    const [db, migrations, redis, storage] = await Promise.all([
      this.checkDb(),
      this.checkMigrations(),
      tcpProbe(this.config.REDIS_HOST, this.config.REDIS_PORT),
      probeUrl(this.config.S3_ENDPOINT),
    ]);

    const checks: Record<string, CheckState> = {
      db: db ? 'ok' : 'down',
      redis: redis ? 'ok' : 'down',
      storage: storage ? 'ok' : 'down',
      migrations: migrations ? 'ok' : 'down',
    };

    const anyDown = Object.values(checks).includes('down');
    const allDown = Object.values(checks).every((s) => s === 'down');
    const status: ReadinessResponse['status'] = allDown ? 'down' : anyDown ? 'degraded' : 'ok';

    return { status, checks };
  }

  private async checkDb(): Promise<boolean> {
    const prisma = this.db();
    if (!prisma) return false;
    try {
      await prisma.$queryRaw`SELECT 1`;
      return true;
    } catch (err) {
      this.log.debug(`db check failed: ${String(err)}`);
      return false;
    }
  }

  private async checkMigrations(): Promise<boolean> {
    const prisma = this.db();
    if (!prisma) return false;
    try {
      const rows = await prisma.$queryRawUnsafe<
        { migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]
      >(
        'SELECT migration_name, finished_at, rolled_back_at FROM _prisma_migrations ORDER BY started_at DESC LIMIT 1',
      );
      const latest = rows[0];
      return latest != null && latest.finished_at != null && latest.rolled_back_at == null;
    } catch (err) {
      this.log.debug(`migrations check failed: ${String(err)}`);
      return false;
    }
  }
}

async function probeUrl(endpoint: string): Promise<boolean> {
  try {
    const u = new URL(endpoint);
    const port = u.port ? Number(u.port) : u.protocol === 'https:' ? 443 : 80;
    return await tcpProbe(u.hostname, port);
  } catch {
    return false;
  }
}
