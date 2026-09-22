import { Injectable } from '@nestjs/common';
import { runPlatform, runScoped } from '@flower/db';
import { DbService } from '../../common/data/index.js';
import { rootLogger } from '../../common/logger/logger.js';
import { WebhookEventProcessorRepository } from './webhook-event-processor.repository.js';

export interface WebhookRecoveryTickResult {
  candidates: number;
  processed: number;
  exceptions: number;
  alreadyTerminal: number;
  skipped: number;
  failed: number;
}

/**
 * Task 3b.5 Checkpoint F (owner reliability pass §1/§2) — the durable
 * RECEIVED-event recovery mechanism. Immediate post-webhook processing
 * (`PaymentWebhookRepository.handle`) is a LATENCY OPTIMIZATION ONLY;
 * correctness/durability does NOT depend on it succeeding. This class is
 * the actual liveness guarantee: it repeatedly discovers
 * `provider_payment_event` rows still `status = 'RECEIVED'` (regardless of
 * WHY — a crash before the immediate call ever ran, a transient failure
 * during it, or simply having never been attempted) and drives them
 * through the SAME `WebhookEventProcessorRepository` primitive used by the
 * webhook path itself — no second financial-mutation model.
 *
 * INSPECTED FIRST (owner §2's own instruction) — existing patterns for
 * this kind of periodic work:
 *   - `apps/worker`'s `OutboxDispatcher`: a hand-rolled `tick()` +
 *     `start()`/`stop()` loop (no `@nestjs/schedule` dependency exists
 *     anywhere in this repo) — mirrored here exactly, including exposing
 *     `tick()` directly for tests (see its own doc comment: "exposed
 *     directly for tests and manual draining").
 *   - `apps/scheduler` + `apps/worker`'s BullMQ `ProcessorRegistry`: the
 *     established pattern for a NEW recurring domain job — but its own doc
 *     comment is explicit that "no business logic lives here — a handler
 *     orchestrates `@flower/backend` services." This payments module's
 *     domain logic lives in `apps/api/src/modules/payments/` specifically
 *     because Checkpoint C/D/E/F's entire canonical lock-order/reservation/
 *     capture logic was built there — moving `WebhookEventProcessorRepository`
 *     (and everything it depends on) into `@flower/backend` so `apps/worker`
 *     could reach it would be a MATERIAL cross-app architecture change, not
 *     a "smallest repository-consistent" one.
 *
 * RESOLUTION: run the recovery loop INSIDE `apps/api`'s own process —
 * zero cross-app dependency, reuses the exact existing DB connection/
 * transaction machinery, and is started ONLY from `main.ts` (never from
 * `AppModule`/`PaymentModule` wiring itself — see `main.ts`'s own comment)
 * so an ordinary `Test.createTestingModule({imports:[AppModule]})`
 * integration test never has a background poll loop running underneath it.
 * Multiple `apps/api` replicas each run their own instance; safety across
 * them comes from `WebhookEventProcessorRepository`'s own row locking
 * (`FOR UPDATE` on Invoice/Attempt, `FOR UPDATE SKIP LOCKED` on the inbox
 * row itself), not from any coordination in this class.
 */
@Injectable()
export class WebhookRecoveryProcessor {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private stopped = false;
  /**
   * Checkpoint G operational-lifecycle proof pass — a genuine idempotency
   * gap found directly by writing the required "start() twice never creates
   * two loops" test, not by inspection: the OLD guard (`if (this.timer ||
   * this.stopped) return`) only protects against a SECOND `start()` call
   * made AFTER the first tick has already settled once — `this.timer` is
   * `null` from construction until `loop()`'s own `.finally()` sets it,
   * which only happens once the FIRST tick's promise resolves. A second
   * `start()` call issued synchronously (or any time before that first tick
   * settles) saw `this.timer === null` too and fell straight through the
   * guard, spawning a genuine second concurrent polling loop. `running` is
   * set synchronously, before any async work begins, closing that window —
   * the very first line of `start()` now makes every subsequent call in the
   * SAME process lifetime a no-op, unconditionally.
   */
  private running = false;

  constructor(
    private readonly db: DbService,
    private readonly processor: WebhookEventProcessorRepository,
  ) {}

  /** Run exactly one recovery pass — exposed directly for tests and manual
   *  draining, mirroring `OutboxDispatcher.tick()`. */
  async tick(batchSize = 20): Promise<WebhookRecoveryTickResult> {
    const candidates = await runPlatform(
      this.db.platformClient(),
      (tx) =>
        tx.$queryRaw<{ id: string; tenantId: string; companyId: string; branchId: string }[]>`
        SELECT "id", "tenantId", "companyId", "branchId"
          FROM "provider_payment_event"
         WHERE "status" = 'RECEIVED'
         ORDER BY "receivedAt" ASC
         LIMIT ${batchSize}`,
    );

    const result: WebhookRecoveryTickResult = {
      candidates: candidates.length,
      processed: 0,
      exceptions: 0,
      alreadyTerminal: 0,
      skipped: 0,
      failed: 0,
    };

    for (const candidate of candidates) {
      try {
        const outcome = await runScoped(
          this.db.appClient(),
          { tenantId: candidate.tenantId, branchId: candidate.branchId },
          (tx) =>
            this.processor.processVerifiedInboxEventInTx(tx, {
              tenantId: candidate.tenantId,
              companyId: candidate.companyId,
              branchId: candidate.branchId,
              inboxId: candidate.id,
            }),
        );
        switch (outcome) {
          case 'PROCESSED':
            result.processed += 1;
            break;
          case 'EXCEPTION':
            result.exceptions += 1;
            break;
          case 'ALREADY_TERMINAL':
            result.alreadyTerminal += 1;
            break;
          case 'SKIPPED':
            result.skipped += 1;
            break;
        }
      } catch (err) {
        // one poisoned candidate must never block the rest of the batch
        // (mirrors `OutboxDispatcher`'s own per-tenant isolation) — the row
        // stays RECEIVED and is retried on the next tick.
        result.failed += 1;
        rootLogger.error(
          { err, inboxId: candidate.id },
          'webhook recovery: a candidate failed — it remains RECEIVED for the next pass',
        );
      }
    }
    return result;
  }

  /** Start the periodic loop. Idempotent — a second call is a no-op (owner
   *  reliability-pass §15). `tickIntervalMs`/`batchSize` are bounded
   *  operational tuning knobs (`WEBHOOK_RECOVERY_TICK_INTERVAL_MS`/
   *  `WEBHOOK_RECOVERY_BATCH_SIZE` — `config/env.ts`), never a
   *  user-facing setting. */
  start(tickIntervalMs = 30_000, batchSize = 20): void {
    if (this.running || this.stopped) return;
    this.running = true;
    const loop = (): void => {
      if (this.stopped) return;
      this.ticking = true;
      this.tick(batchSize)
        .then((result) => {
          if (result.candidates > 0) {
            rootLogger.debug(result, 'webhook recovery tick');
          }
        })
        .catch((err: unknown) => {
          rootLogger.error({ err }, 'webhook recovery tick failed');
        })
        .finally(() => {
          this.ticking = false;
          if (!this.stopped) {
            this.timer = setTimeout(loop, tickIntervalMs);
          }
        });
    };
    loop();
  }

  /** Stop the loop and wait for any in-flight tick to finish. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.ticking) await new Promise((r) => setTimeout(r, 20));
  }
}
