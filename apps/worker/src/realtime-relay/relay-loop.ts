import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import type { Redis } from 'ioredis';
import type { Logger } from '@flower/service-runtime';
import { relayTick, type RelayOptions, type RelayTickResult } from './relay.js';

export interface RealtimeRelayOptions {
  readonly redis: Redis;
  readonly logger: Logger;
  /** how often a tick runs (ms) */
  readonly tickIntervalMs?: number;
  readonly minIdleMs?: number;
  readonly batchSize?: number;
  readonly tenantScanCount?: number;
  /** override for tests — defaults to a random name per process instance */
  readonly consumerName?: string;
}

const DEFAULT_TICK_INTERVAL_MS = 500;

/**
 * The realtime relay (task 2.5, OI-P2-2 — owner-approved 2026-09-04: lives in
 * `apps/worker`, a dedicated loop, **not** a BullMQ queue, mirroring the task
 * 2.4 outbox dispatcher's own shape). One logical consumer of every
 * `rt:stream:{tenantId}` → `PUBLISH rt:live:{tenantId}` with the identical
 * envelope (ADR-0017 §4). A consumer group is fine *here* — this is the
 * relay's own horizontal-scaling / restart-resume mechanism, never the
 * gateway's socket-broadcast path (that would be OD-P2-4's rejected
 * consumer-group-as-broadcast design).
 *
 * Deliberately has **no** dependency on `packages/db` / Postgres / the outbox
 * dispatcher's own modules — it discovers tenant streams via a Redis `SCAN`
 * (`relay.ts`'s `discoverTenantStreams`), never a tenant/outbox table query,
 * so it cannot duplicate the dispatcher's responsibilities even by accident.
 */
export class RealtimeRelay {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private stopped = false;
  private readonly consumerName: string;

  constructor(private readonly opts: RealtimeRelayOptions) {
    this.consumerName = opts.consumerName ?? `relay-${process.pid}-${randomUUID().slice(0, 8)}`;
  }

  /** Run exactly one tick — exposed directly for tests and manual draining. */
  async tick(): Promise<RelayTickResult> {
    const opts: RelayOptions = {
      consumerName: this.consumerName,
      ...(this.opts.minIdleMs !== undefined && { minIdleMs: this.opts.minIdleMs }),
      ...(this.opts.batchSize !== undefined && { batchSize: this.opts.batchSize }),
      ...(this.opts.tenantScanCount !== undefined && {
        tenantScanCount: this.opts.tenantScanCount,
      }),
    };
    return relayTick(this.opts.redis, opts);
  }

  /** Start the periodic loop. Idempotent — a second call is a no-op. */
  start(): void {
    if (this.timer || this.stopped) return;
    const loop = (): void => {
      if (this.stopped) return;
      this.ticking = true;
      this.tick()
        .then((result) => {
          if (result.published > 0) {
            this.opts.logger.debug(result, 'realtime relay tick');
          }
        })
        .catch((err: unknown) => {
          this.opts.logger.error({ err }, 'realtime relay tick failed');
        })
        .finally(() => {
          this.ticking = false;
          if (!this.stopped) {
            this.timer = setTimeout(loop, this.opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS);
          }
        });
    };
    loop();
  }

  /** Stop the loop and wait for any in-flight tick to finish (graceful drain). */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    while (this.ticking) await sleep(20);
  }
}
