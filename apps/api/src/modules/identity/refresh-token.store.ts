import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { RedisService } from '../../common/redis/redis.module.js';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');
const tokenKey = (hash: string): string => `refresh:${hash}`;
const familyKey = (familyId: string): string => `refresh-family:${familyId}`;

export interface RefreshRecord {
  sessionId: string;
  familyId: string;
  used: boolean;
}

export class RefreshReuseError extends Error {
  constructor(readonly familyId: string) {
    super('refresh token reuse detected — the token family has been revoked');
    this.name = 'RefreshReuseError';
  }
}
export class RefreshInvalidError extends Error {
  constructor() {
    super('refresh token is unknown or expired');
    this.name = 'RefreshInvalidError';
  }
}

/**
 * Rotating refresh tokens with family-wide reuse detection (SECURITY.md). One
 * login = one family; every rotation issues a new token in the family and marks
 * the old one `used`. Replaying a `used` token means a stolen token — the whole
 * family (and its sessions) is revoked.
 */
@Injectable()
export class RefreshTokenStore {
  constructor(private readonly redis: RedisService) {}

  private get client(): Redis {
    return this.redis.require();
  }

  private ttl(): number {
    return 60 * 60 * 24 * 30; // 30d — the config value is applied at the session layer
  }

  async issue(
    sessionId: string,
    familyId: string = randomUUID(),
  ): Promise<{ token: string; familyId: string }> {
    const token = randomBytes(32).toString('base64url');
    const hash = sha256(token);
    const rec: RefreshRecord = { sessionId, familyId, used: false };
    const pipe = this.client.multi();
    pipe.set(tokenKey(hash), JSON.stringify(rec), 'EX', this.ttl());
    pipe.sadd(familyKey(familyId), hash);
    pipe.expire(familyKey(familyId), this.ttl());
    await pipe.exec();
    return { token, familyId };
  }

  /**
   * Rotate: consume `oldToken`, issue a fresh one in the same family. Throws
   * `RefreshReuseError` (family already revoked) or `RefreshInvalidError`.
   */
  async rotate(oldToken: string): Promise<{ token: string; sessionId: string; familyId: string }> {
    const hash = sha256(oldToken);
    const raw = await this.client.get(tokenKey(hash));
    if (!raw) throw new RefreshInvalidError();
    const rec = JSON.parse(raw) as RefreshRecord;

    if (rec.used) {
      await this.revokeFamily(rec.familyId);
      throw new RefreshReuseError(rec.familyId);
    }

    // mark used (keep briefly so a replay is caught, not just "unknown")
    rec.used = true;
    await this.client.set(tokenKey(hash), JSON.stringify(rec), 'EX', 120);

    const next = await this.issue(rec.sessionId, rec.familyId);
    return { token: next.token, sessionId: rec.sessionId, familyId: rec.familyId };
  }

  /** Revoke every token in a family. Returns the affected session ids. */
  async revokeFamily(familyId: string): Promise<string[]> {
    const hashes = await this.client.smembers(familyKey(familyId));
    const sessionIds = new Set<string>();
    if (hashes.length > 0) {
      const raws = await this.client.mget(...hashes.map(tokenKey));
      for (const raw of raws) {
        if (raw) sessionIds.add((JSON.parse(raw) as RefreshRecord).sessionId);
      }
      await this.client.del(...hashes.map(tokenKey), familyKey(familyId));
    }
    return [...sessionIds];
  }

  async peek(token: string): Promise<RefreshRecord | null> {
    const raw = await this.client.get(tokenKey(sha256(token)));
    return raw ? (JSON.parse(raw) as RefreshRecord) : null;
  }
}
