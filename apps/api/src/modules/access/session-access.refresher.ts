import { Injectable } from '@nestjs/common';
import { RedisService } from '../../common/redis/redis.module.js';
import { SessionStore } from '../../common/auth/session-store.js';
import { PolicyService } from './policy.service.js';
import { toAccessSnapshot } from './policy.types.js';

/**
 * After an RBAC change, re-resolve and rewrite every live session for the
 * affected user(s) so the change takes effect on their **next request** — without
 * logging them out (that is `SessionService.revoke`, a separate, harsher action).
 *
 * The `usersessions:<userId>` sorted set is maintained by `LimitService`; it is
 * the per-user session index. Impersonation sessions are left untouched (their
 * access is deliberately frozen and read-only — OD7).
 */
@Injectable()
export class SessionAccessRefresher {
  constructor(
    private readonly redis: RedisService,
    private readonly store: SessionStore,
    private readonly policy: PolicyService,
  ) {}

  async refreshUser(tenantId: string, userId: string): Promise<void> {
    const client = this.redis.get();
    if (!client) return;
    const ids = await client.zrange(`usersessions:${userId}`, '0', '-1');
    if (ids.length === 0) return;

    const snapshot = toAccessSnapshot(await this.policy.resolveForUser(userId, tenantId));
    for (const id of ids) {
      const session = await this.store.get(id);
      if (!session || session.impersonatorPlatformUserId) continue;
      session.access = snapshot;
      await this.store.set(session);
    }
  }

  async refreshUsers(tenantId: string, userIds: readonly string[]): Promise<void> {
    for (const userId of userIds) {
      await this.refreshUser(tenantId, userId);
    }
  }
}
