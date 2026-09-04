/**
 * The data-access layer (`ScopedRepository`, `PlatformRepository`, `DbService`)
 * moved to `@flower/backend` (FC-3). This barrel keeps `apps/api`'s
 * `../data/index.js` import path stable.
 */
export { ScopedRepository, PlatformRepository, DbModule, DbService } from '@flower/backend';
