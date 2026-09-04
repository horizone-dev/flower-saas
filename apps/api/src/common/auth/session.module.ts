import { Global, Module } from '@nestjs/common';
import { RedisModule, RedisService } from '../redis/redis.module.js';
import { SessionStore, InMemorySessionStore } from './session-store.js';
import { RedisSessionStore } from './redis-session-store.js';

/**
 * Binds `SessionStore`: Redis when `REDIS_URL` is configured, in-memory otherwise
 * (unit tests only). One binding used by both the guard pipeline and the identity
 * module, so there is no provider-override race.
 */
@Global()
@Module({
  imports: [RedisModule],
  providers: [
    InMemorySessionStore,
    {
      provide: SessionStore,
      inject: [RedisService, InMemorySessionStore],
      useFactory: (redis: RedisService, memory: InMemorySessionStore): SessionStore => {
        // `RedisSessionStore` (task 2.5, `@flower/backend`) takes a raw
        // `ioredis.Redis` client now, not the `RedisService` wrapper itself.
        const client = redis.get();
        return client ? new RedisSessionStore(client) : memory;
      },
    },
  ],
  exports: [SessionStore],
})
export class SessionModule {}
