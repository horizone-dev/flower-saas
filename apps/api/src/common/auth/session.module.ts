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
      useFactory: (redis: RedisService, memory: InMemorySessionStore): SessionStore =>
        redis.get() ? new RedisSessionStore(redis) : memory,
    },
  ],
  exports: [SessionStore],
})
export class SessionModule {}
