import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { type LimitKey } from '@flower/shared-types';
import { DomainError } from '../../common/errors/domain-error.js';
import { RedisService } from '../../common/redis/redis.module.js';
import { TenantConfigRepository } from './tenant-config.repository.js';

export class LimitExceededError extends DomainError {
  constructor(limitKey: string, current: number, max: number) {
    super('LIMIT_EXCEEDED', `plan limit "${limitKey}" reached (${current}/${max})`, 422, [
      { field: limitKey, issue: `at ${current} of ${max}` },
    ]);
    this.name = 'LimitExceededError';
  }
}

const USAGE_OF: Partial<Record<LimitKey, Parameters<TenantConfigRepository['usage']>[1]>> = {
  max_companies: 'company',
  max_branches: 'branch',
  max_pos_terminals: 'pos_terminal',
  max_users: 'user_normal',
  max_owner_users: 'user_owner',
};

/**
 * Enforces the ten numeric plan limits (ARCHITECTURE §48) at the boundary. Count
 * limits query the tenant's rows; session limits use a Redis sorted set that
 * `SessionService` maintains.
 */
@Injectable()
export class LimitService {
  constructor(
    private readonly config: TenantConfigRepository,
    private readonly redis: RedisService,
  ) {}

  private get client(): Redis {
    return this.redis.require();
  }

  /** The effective limit value for a tenant (override or plan default). */
  async valueOf(tenantId: string, limitKey: LimitKey): Promise<number> {
    const row = await this.config.limit(tenantId, limitKey);
    return row ? Number(row.value) : Number.MAX_SAFE_INTEGER;
  }

  /**
   * Assert that creating `delta` more of `limitKey`'s resource stays within the
   * plan. Throws `LimitExceededError` (422) otherwise.
   */
  async assertWithin(tenantId: string, limitKey: LimitKey, delta = 1): Promise<void> {
    const max = await this.valueOf(tenantId, limitKey);
    const usageKind = USAGE_OF[limitKey];
    if (!usageKind) return; // session limits are checked via assertSessionWithin
    const current = await this.config.usage(tenantId, usageKind);
    if (current + delta > max) throw new LimitExceededError(limitKey, current, max);
  }

  // ── concurrent sessions (Redis-backed, maintained by SessionService) ───────
  private userKey(userId: string): string {
    return `usersessions:${userId}`;
  }
  private tenantKey(tenantId: string): string {
    return `tenantsessions:${tenantId}`;
  }

  async recordSession(
    tenantId: string,
    userId: string,
    sessionId: string,
    expiresAt: number,
  ): Promise<void> {
    const pipe = this.client.multi();
    for (const key of [this.userKey(userId), this.tenantKey(tenantId)]) {
      pipe.zremrangebyscore(key, '-inf', Date.now());
      pipe.zadd(key, expiresAt, sessionId);
      pipe.expire(key, Math.max(1, Math.ceil((expiresAt - Date.now()) / 1000)));
    }
    await pipe.exec();
  }

  async dropSession(tenantId: string, userId: string, sessionId: string): Promise<void> {
    await this.client.zrem(this.userKey(userId), sessionId);
    await this.client.zrem(this.tenantKey(tenantId), sessionId);
  }

  /** Called at login — refuse a new session if the user is already at the cap. */
  async assertSessionWithin(tenantId: string, userId: string): Promise<void> {
    const perUser = await this.valueOf(tenantId, 'max_sessions_per_user');
    await this.client.zremrangebyscore(this.userKey(userId), '-inf', Date.now());
    const current = await this.client.zcard(this.userKey(userId));
    if (current >= perUser) throw new LimitExceededError('max_sessions_per_user', current, perUser);
  }
}
