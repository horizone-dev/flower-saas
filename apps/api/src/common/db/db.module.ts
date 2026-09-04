/**
 * `DbService` / `DbModule` moved to `@flower/backend` (FC-3 — one Prisma client
 * construction path + RLS posture for `api` / `worker` / `scheduler`). Re-exported
 * here so `apps/api`'s `../db/db.module.js` import path stays stable.
 */
export { DbService, DbModule } from '@flower/backend';
