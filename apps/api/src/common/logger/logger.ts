/**
 * The root pino logger moved to `@flower/backend` (FC-3 — shared by `api` /
 * `worker` / `scheduler`). Re-exported here so `apps/api`'s
 * `../logger/logger.js` import path stays stable.
 */
export { REDACT_PATHS, createRootLogger, rootLogger } from '@flower/backend';
