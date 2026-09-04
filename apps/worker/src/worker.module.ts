import { Module } from '@nestjs/common';
import { BackendConfigModule, BackendModule } from '@flower/backend';

/**
 * The worker's Nest application context (FC-3). It composes **only**
 * `@flower/backend` — the authoritative domain/infra module layer — so a
 * processor calls the same services `apps/api` does and never re-implements a
 * business rule (CLAUDE.md rule 1).
 *
 * `BackendConfigModule` parses the shared infra env into `BACKEND_CONFIG`;
 * `BackendModule` provides `DbService` (+ the scoped/platform DB base classes).
 * There is no HTTP controller, Fastify hook or transport module anywhere in this
 * graph — the boundary test proves it.
 *
 * Domain processors + the outbox dispatcher (task 2.4) add their own
 * `@flower/backend` modules here in later phases.
 */
@Module({
  imports: [BackendConfigModule, BackendModule],
})
export class WorkerModule {}
