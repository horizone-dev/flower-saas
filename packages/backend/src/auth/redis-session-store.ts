import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { revokeChannel } from '../realtime/channels.js';
import { SessionStore } from './session-store.js';
import type { SessionData } from './session.types.js';

export { revokeChannel };

const key = (id: string): string => `session:${id}`;

/**
 * Redis-backed session store. The TTL is the session's remaining lifetime, so an
 * expired session simply vanishes — a guard/gateway sees "not found" the moment
 * it checks (revocation-by-absence, hard gate G6).
 *
 * Moved here (task 2.5, from `apps/api/src/common/auth/redis-session-store.ts`)
 * so `apps/realtime` reads the identical session record `apps/api` writes — same
 * `key()` shape, same expiry/revocation semantics, never duplicated.
 *
 * **Constructor now takes a raw `ioredis.Redis` client directly** (previously
 * `apps/api`'s own `RedisService` wrapper) — `@flower/backend` stays
 * framework-independent (no Nest-DI-token dependency baked into the class
 * itself); `apps/api` passes `redisService.require()` (one-line change at its
 * single construction site, `session.module.ts`).
 *
 * **A real cross-process gotcha, found and deliberately NOT "fixed" by adding a
 * `keyPrefix` here:** `apps/api`'s `RedisService` constructs its client with
 * `keyPrefix: 'flower:'` (ioredis auto-prepends it to every command), so the
 * session keys this class's `get`/`set`/`revoke`/`delete` build as
 * `session:{id}` land in Redis as `flower:session:{id}` **when constructed with
 * apps/api's client**. `apps/realtime` does **not** use `apps/api`'s
 * `RedisService` (a Nest-DI-bound, apps/api-only class) — it must build its own
 * session-lookup `Redis` client **configured with the identical
 * `keyPrefix: 'flower:'`** (see `apps/realtime/src/auth/redis.ts`) so both
 * processes agree on the same physical Redis key for the same session, without
 * this class hardcoding `'flower:'` into its own key strings (which would
 * double-prefix on `apps/api`'s already-prefixed client). The realtime
 * pipeline's OWN keys (`rt:stream:*` / `rt:live:*` / `rt:revoke:*`) are a
 * deliberately **separate**, unprefixed Redis connection in both processes —
 * never conflate the two connections/prefixes.
 */
@Injectable()
export class RedisSessionStore extends SessionStore {
  constructor(private readonly redis: Redis) {
    super();
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const raw = await this.redis.get(key(sessionId));
    if (!raw) return null;
    const s = JSON.parse(raw) as SessionData;
    if (s.revokedAt !== null || s.expiresAt <= Date.now()) {
      await this.redis.del(key(sessionId));
      return null;
    }
    return s;
  }

  async set(session: SessionData): Promise<void> {
    const ttl = Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 1000));
    await this.redis.set(key(session.sessionId), JSON.stringify(session), 'EX', ttl);
  }

  /**
   * Marks the session revoked **and** publishes to `revokeChannel(sessionId)`
   * (task 2.5) so any realtime gateway instance holding a live socket for this
   * session closes it immediately (<5s gate) rather than waiting for that
   * socket's own next auth re-check. Every existing revocation call site
   * (`logout`, admin session-kill, impersonation-end) gets this for free — the
   * concept of "revoke" now inherently includes "notify realtime", one place,
   * never a call site the caller has to remember to also wire up.
   */
  async revoke(sessionId: string, reason: string): Promise<void> {
    const raw = await this.redis.get(key(sessionId));
    if (!raw) return;
    const s = JSON.parse(raw) as SessionData;
    s.revokedAt = Date.now();
    s.revokeReason = reason;
    // keep a short tombstone so an in-flight token is rejected explicitly
    await this.redis.set(key(sessionId), JSON.stringify(s), 'EX', 60);
    await this.redis.publish(revokeChannel(sessionId), reason);
  }

  async delete(sessionId: string): Promise<void> {
    await this.redis.del(key(sessionId));
  }
}
