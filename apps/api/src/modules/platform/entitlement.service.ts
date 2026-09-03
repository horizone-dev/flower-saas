import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisService } from '../../common/redis/redis.module.js';
import { TenantConfigRepository } from './tenant-config.repository.js';

const cacheKey = (tenantId: string): string => `entitlements:${tenantId}`;
const CACHE_TTL = 300;

/**
 * The effective feature-module set for a tenant (ARCHITECTURE §48). Cached in
 * Redis; the cache is dropped whenever an entitlement changes so a flip takes
 * effect on the next resolve. Session-cached `ctx.entitlements` (task 1.4)
 * refreshes on token refresh.
 */
@Injectable()
export class EntitlementService {
  constructor(
    private readonly config: TenantConfigRepository,
    private readonly redis: RedisService,
  ) {}

  private get client(): Redis | null {
    return this.redis.get();
  }

  async resolve(tenantId: string): Promise<Set<string>> {
    const cached = await this.client?.get(cacheKey(tenantId));
    if (cached) return new Set(JSON.parse(cached) as string[]);

    const rows = await this.config.entitlements(tenantId);
    const enabled = rows.filter((r) => r.enabled).map((r) => r.moduleKey);
    await this.client?.set(cacheKey(tenantId), JSON.stringify(enabled), 'EX', CACHE_TTL);
    return new Set(enabled);
  }

  async invalidate(tenantId: string): Promise<void> {
    await this.client?.del(cacheKey(tenantId));
  }

  async setEnabled(tenantId: string, moduleKey: string, enabled: boolean): Promise<void> {
    await this.config.setEntitlement(tenantId, moduleKey, enabled);
    await this.invalidate(tenantId);
  }
}
