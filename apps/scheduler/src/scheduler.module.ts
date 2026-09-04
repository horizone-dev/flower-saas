import { Module } from '@nestjs/common';
import { BackendConfigModule, BackendModule } from '@flower/backend';

/**
 * The scheduler's Nest application context (FC-3). It composes **only**
 * `@flower/backend` — the same authoritative domain/infra module layer
 * `apps/api` and `apps/worker` consume — so a future repeatable job never
 * re-implements a business rule (CLAUDE.md rule 1).
 *
 * The scheduler only **enqueues**; it runs no BullMQ `Worker` and holds no HTTP
 * controller, Fastify hook or transport module anywhere in this graph — the
 * boundary test proves it.
 */
@Module({
  imports: [BackendConfigModule, BackendModule],
})
export class SchedulerModule {}
