import { Redis } from 'ioredis';

/**
 * The session-lookup Redis connection — configured with the **identical**
 * `keyPrefix: 'flower:'` `apps/api`'s `RedisService` uses (see
 * `@flower/backend`'s `RedisSessionStore` doc comment for the full
 * cross-process gotcha this avoids). `RedisSessionStore` itself builds plain
 * `session:{id}` keys; it is this connection's `keyPrefix` — not a hardcoded
 * string inside the shared class — that makes them land on the exact same
 * physical Redis key `apps/api` wrote (`flower:session:{id}`).
 *
 * Deliberately a **separate** connection from the realtime-pipeline one
 * (`rt:stream:*` / `rt:live:*` / `rt:revoke:*`, built with
 * `@flower/service-runtime`'s unprefixed `createRedis`) — never share a
 * `keyPrefix`'d connection for stream/channel names, or every realtime key
 * this gateway reads/writes would silently gain a `flower:` prefix that
 * `apps/worker`'s relay/dispatcher never applies, and nothing would ever
 * match.
 */
export function createSessionRedis(host: string, port: number): Redis {
  return new Redis({
    host,
    port,
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    retryStrategy: (times) => Math.min(times * 200, 2000),
    keyPrefix: 'flower:',
  });
}
