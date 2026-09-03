import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisService } from '../../common/redis/redis.module.js';
import { TenantRepository } from './tenant.repository.js';

type LifecycleAction = 'suspend' | 'resume' | 'terminate';
const NEXT_STATUS: Record<LifecycleAction, string> = {
  suspend: 'SUSPENDED',
  resume: 'ACTIVE',
  terminate: 'TERMINATED',
};

@Injectable()
export class TenantLifecycleService {
  constructor(
    private readonly repo: TenantRepository,
    private readonly redis: RedisService,
  ) {}

  private get client(): Redis | null {
    return this.redis.get();
  }

  async transition(
    tenantId: string,
    action: LifecycleAction,
    actorPlatformUserId: string | null,
    reason?: string,
  ): Promise<{ status: string }> {
    const next = NEXT_STATUS[action];
    await this.repo.setStatus(tenantId, action, next, actorPlatformUserId, reason);

    // suspend / terminate end every session for the tenant (revocation in seconds).
    // Terminating deletes NO history rows (legal hold) — only sessions are killed.
    if (action !== 'resume') {
      const client = this.client;
      if (client) {
        const ids = await client.zrange(`tenantsessions:${tenantId}`, '0', '-1');
        if (ids.length > 0) {
          await client.del(...ids.map((id) => `session:${id}`), `tenantsessions:${tenantId}`);
        }
      }
      await this.repo.markTenantSessionsRevoked(tenantId, `tenant ${action}`);
    }

    return { status: next };
  }
}
