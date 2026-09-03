import { Inject, Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';
import { RedisService } from '../../common/redis/redis.module.js';

/**
 * Login brute-force protection: a sliding counter keyed by the login identity and
 * by the client IP. After `AUTH_LOGIN_MAX_ATTEMPTS` failures the key locks for
 * `AUTH_LOGIN_LOCKOUT_SECONDS`. A success clears the identity counter.
 */
@Injectable()
export class BruteForceService {
  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly redis: RedisService,
  ) {}

  private get client(): Redis {
    return this.redis.require();
  }

  /** [key, threshold] pairs — the per-identity limit is the configured max; the
   *  per-IP limit is far higher (one IP legitimately serves many users, e.g.
   *  behind a corporate NAT / the app's own proxy). */
  private limits(identity: string, ip: string | null): [string, number][] {
    const max = this.config.AUTH_LOGIN_MAX_ATTEMPTS;
    const pairs: [string, number][] = [[`bf:id:${identity.toLowerCase()}`, max]];
    if (ip) pairs.push([`bf:ip:${ip}`, max * 20]);
    return pairs;
  }

  /** Throws-free check — returns true if currently locked. */
  async isLocked(identity: string, ip: string | null): Promise<boolean> {
    const pairs = this.limits(identity, ip);
    const counts = await this.client.mget(...pairs.map(([k]) => k));
    return pairs.some(([, threshold], i) => {
      const c = counts[i];
      return c !== null && c !== undefined && Number(c) >= threshold;
    });
  }

  async recordFailure(identity: string, ip: string | null): Promise<void> {
    const pipe = this.client.multi();
    for (const [key] of this.limits(identity, ip)) {
      pipe.incr(key);
      pipe.expire(key, this.config.AUTH_LOGIN_LOCKOUT_SECONDS);
    }
    await pipe.exec();
  }

  async recordSuccess(identity: string, ip: string | null): Promise<void> {
    // clear the per-identity counter; leave the per-IP counter (it decays on TTL)
    await this.client.del(this.limits(identity, ip)[0]![0]);
  }
}
