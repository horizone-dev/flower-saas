import { Inject, Injectable } from '@nestjs/common';
import type { ReadinessResponse } from '@flower/shared-types';
import { APP_CONFIG, type AppConfig } from '../config/env.js';
import { tcpProbe } from './tcp-probe.js';

type CheckState = 'ok' | 'down';

@Injectable()
export class HealthService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  /** Liveness — the process is up and can serve. */
  health(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /**
   * Readiness — every dependency the API needs to do real work.
   * Phase 0: TCP reachability for db / redis / storage; `migrations` is `down`
   * until `packages/db` exists (Task 0.5).
   */
  async readiness(): Promise<ReadinessResponse> {
    const [db, redis, storage] = await Promise.all([
      tcpProbe(this.config.POSTGRES_HOST, this.config.POSTGRES_PORT),
      tcpProbe(this.config.REDIS_HOST, this.config.REDIS_PORT),
      probeUrl(this.config.S3_ENDPOINT),
    ]);

    const checks: Record<string, CheckState> = {
      db: db ? 'ok' : 'down',
      redis: redis ? 'ok' : 'down',
      storage: storage ? 'ok' : 'down',
      migrations: 'down', // wired in Task 0.5
    };

    const anyDown = Object.values(checks).includes('down');
    const allDown = Object.values(checks).every((s) => s === 'down');
    const status: ReadinessResponse['status'] = allDown ? 'down' : anyDown ? 'degraded' : 'ok';

    return { status, checks };
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
