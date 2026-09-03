import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisService } from '../redis/redis.module.js';
import { SessionStore } from './session-store.js';
import type { SessionData } from './session.types.js';

const key = (id: string): string => `session:${id}`;

/**
 * Redis-backed session store. The TTL is the session's remaining lifetime, so a
 * revoked/expired session simply vanishes — `AuthGuard` sees "not found" on the
 * next request (revocation in seconds, hard gate G6).
 */
@Injectable()
export class RedisSessionStore extends SessionStore {
  constructor(private readonly redis: RedisService) {
    super();
  }

  private get client(): Redis {
    return this.redis.require();
  }

  async get(sessionId: string): Promise<SessionData | null> {
    const raw = await this.client.get(key(sessionId));
    if (!raw) return null;
    const s = JSON.parse(raw) as SessionData;
    if (s.revokedAt !== null || s.expiresAt <= Date.now()) {
      await this.client.del(key(sessionId));
      return null;
    }
    return s;
  }

  async set(session: SessionData): Promise<void> {
    const ttl = Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 1000));
    await this.client.set(key(session.sessionId), JSON.stringify(session), 'EX', ttl);
  }

  async revoke(sessionId: string, reason: string): Promise<void> {
    const raw = await this.client.get(key(sessionId));
    if (!raw) return;
    const s = JSON.parse(raw) as SessionData;
    s.revokedAt = Date.now();
    s.revokeReason = reason;
    // keep a short tombstone so an in-flight token is rejected explicitly
    await this.client.set(key(sessionId), JSON.stringify(s), 'EX', 60);
  }

  async delete(sessionId: string): Promise<void> {
    await this.client.del(key(sessionId));
  }
}
