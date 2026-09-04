// Thin re-export barrel (task 2.5) — moved to `@flower/backend`. See
// `jwt.service.ts` in this directory for why. Its constructor now takes a raw
// `ioredis.Redis` client (was `apps/api`'s own `RedisService` wrapper) — the
// one construction site, `session.module.ts`, is updated accordingly.
export { RedisSessionStore, revokeChannel } from '@flower/backend';
