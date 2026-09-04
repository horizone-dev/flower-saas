/**
 * Moved to `@flower/backend` (FC-3 — the sanctioned scoped DB path is shared by
 * `api` / `worker` / `scheduler`). Re-exported here so `apps/api` import paths
 * stay stable.
 */
export { ScopedRepository } from '@flower/backend';
