import { Global, Module } from '@nestjs/common';
import { DbModule } from './db/db.module.js';

/**
 * The authoritative backend module layer (FC-3 / OD-P2-8).
 *
 * Every runtime — `apps/api`, `apps/worker`, `apps/scheduler` — composes this so
 * a business rule is implemented **once**. It carries **no HTTP / Fastify /
 * transport** code: controllers, request guards/interceptors, cookies, CORS and
 * `main.ts` all stay in `apps/api`.
 *
 * Phase 2-core task 2.3 keeps the cut minimal — just the DB access layer
 * (`DbService` + the `ScopedRepository` / `PlatformRepository` base classes) and
 * the shared request-context + logger primitives. Later tasks add to this module
 * only what a core non-API process actually consumes (2.4: the outbox
 * writer/reader; 2.5: session/topic authorization).
 *
 * `BACKEND_CONFIG` is **not** provided here — each runtime supplies it
 * (`apps/api` from its `AppConfig`; `apps/worker` / `apps/scheduler` via
 * `BackendConfigModule`). That keeps the dependency direction one-way:
 * `apps/* → @flower/backend`, never the reverse.
 */
@Global()
@Module({
  imports: [DbModule],
  exports: [DbModule],
})
export class BackendModule {}
