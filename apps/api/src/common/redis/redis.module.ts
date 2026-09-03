import { Global, Inject, Injectable, Module, type OnModuleDestroy } from '@nestjs/common';
import { Redis } from 'ioredis';
import { APP_CONFIG, type AppConfig } from '../../config/env.js';

export const REDIS = Symbol('REDIS');

/**
 * Redis connection for sessions, refresh-token families, brute-force counters and
 * (Phase 2) streams. Returns `null` when no Redis is configured — the session
 * store then falls back to in-memory (unit tests only).
 */
@Injectable()
export class RedisService implements OnModuleDestroy {
  private client: Redis | null = null;

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  get(): Redis | null {
    if (this.client) return this.client;
    const url = this.config.REDIS_URL;
    if (!url) return null;
    this.client = new Redis(url, {
      lazyConnect: false,
      maxRetriesPerRequest: 2,
      enableReadyCheck: true,
      keyPrefix: 'flower:',
    });
    return this.client;
  }

  /** Throws if Redis is required but absent (the identity module needs it). */
  require(): Redis {
    const c = this.get();
    if (!c) throw new Error('REDIS_URL is not set — required for auth/sessions');
    return c;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      this.client.disconnect();
      this.client = null;
    }
  }
}

@Global()
@Module({
  providers: [RedisService],
  exports: [RedisService],
})
export class RedisModule {}
