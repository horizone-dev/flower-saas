import 'reflect-metadata'; // required before any @flower/backend @Injectable() class is
// touched — see apps/worker/src/main.ts for the identical, already-established
// precedent (task 2.3); @flower/backend itself deliberately does not
// self-import this, each consuming runtime's entrypoint does, once.
import { z } from 'zod';
import {
  connectRedis,
  createLogger,
  createRedis,
  installShutdown,
  parseEnv,
  redisHealthy,
} from '@flower/service-runtime';
import {
  loadBackendConfig,
  JwtService,
  RedisSessionStore,
  SessionAuthenticator,
} from '@flower/backend';
import { createSessionRedis } from './auth/redis.js';
import { GatewayHub } from './gateway/hub.js';
import { buildRealtimeApp } from './app.js';

/**
 * WebSocket gateway entrypoint (ADR-0009 / ADR-0017 §4, §9; task 2.5).
 * Distinct runtime role, co-deployable with `apps/api` until socket volume
 * warrants a split (OD-P2-8).
 */
async function main(): Promise<void> {
  const env = parseEnv(
    z.object({
      REALTIME_PORT: z.coerce.number().int().positive().default(3002),
      API_HOST: z.string().default('0.0.0.0'),
    }),
  );
  const log = createLogger('realtime', env.LOG_LEVEL, env.NODE_ENV === 'development');

  // Realtime-pipeline connections (rt:stream:*/rt:live:*/rt:revoke:*) —
  // unprefixed, matching apps/worker's convention exactly (@flower/backend's
  // realtime/channels.ts is the single shared source of the channel names).
  const healthRedis = createRedis(env.REDIS_HOST, env.REDIS_PORT);
  const subscriberRedis = createRedis(env.REDIS_HOST, env.REDIS_PORT);
  // A SEPARATE connection for XRANGE/XINFO STREAM (task 2.6 resume/replay) —
  // `subscriberRedis` is locked into Pub/Sub subscriber mode the moment its
  // first SUBSCRIBE happens and can never run a plain command again.
  const commandsRedis = createRedis(env.REDIS_HOST, env.REDIS_PORT);
  await connectRedis(healthRedis);
  await connectRedis(subscriberRedis);
  await connectRedis(commandsRedis);

  // Session lookup — a SEPARATE connection, keyPrefix: 'flower:' (matches
  // apps/api's RedisService exactly; see auth/redis.ts's doc comment for why
  // this must never be the same connection/prefix as the pipeline ones above).
  const sessionRedis = createSessionRedis(env.REDIS_HOST, env.REDIS_PORT);
  await connectRedis(sessionRedis);

  const backendConfig = loadBackendConfig(process.env);
  const jwt = new JwtService(backendConfig);
  const sessions = new RedisSessionStore(sessionRedis);
  const authenticator = new SessionAuthenticator(jwt, sessions);
  const hub = new GatewayHub(subscriberRedis, commandsRedis);

  const app = await buildRealtimeApp({
    redisHealthy: () => redisHealthy(healthRedis),
    authenticator,
    hub,
    onConnect: () => log.debug('ws connected'),
    onClose: () => log.debug('ws closed'),
    onAuthFailed: (reason) => log.debug({ reason }, 'ws auth failed'),
    onMessageError: (err) => log.error({ err }, 'ws message handling failed'),
  });

  installShutdown(log, async () => {
    await app.close();
    healthRedis.disconnect();
    subscriberRedis.disconnect();
    commandsRedis.disconnect();
    sessionRedis.disconnect();
  });

  await app.listen({ port: env.REALTIME_PORT, host: env.API_HOST });
  const ok = await redisHealthy(healthRedis);
  log.info({ port: env.REALTIME_PORT, redis: ok ? 'ok' : 'down' }, 'realtime gateway started');
}

main().catch((err: unknown) => {
  process.stderr.write(`failed to start realtime: ${String(err)}\n`);
  process.exit(1);
});
