import { Injectable } from '@nestjs/common';
import type { Prisma } from '@flower/db';
import { runPlatform, type ScopedTx } from '@flower/db';
import { DbService } from '../data/index.js';
import { getContext } from '../context/index.js';

export interface OutboxEventInput {
  aggregateType: string;
  aggregateId: string;
  eventType: string;
  payload: Record<string, unknown>;
  tenantId?: string | null;
  /** ADR-0017 §3 envelope scope — set by the trusted domain producer for a
   *  company-scoped event (task 3.10). A branch-scoped event carries BOTH
   *  companyId + branchId (defence in depth). Never a client value. */
  companyId?: string | null;
  /** ADR-0017 §3 envelope scope — set for a branch-scoped event. */
  branchId?: string | null;
  /** ADR-0017 §3 `resource_version` — the aggregate version AFTER the mutation;
   *  gates payload/refetch client-side, never authoritative business state. */
  resourceVersion?: bigint | number | null;
}

/**
 * Transactional outbox writer (CLAUDE.md §28). `enqueue(tx, …)` writes an
 * `outbox` row inside the caller's transaction — the domain write and its event
 * commit together, or neither does. **Phase 1 has no dispatcher** (SKIP LOCKED
 * fan-out is Phase 2 — ADR-0016); rows accumulate with `dispatchedAt` null.
 */
@Injectable()
export class OutboxWriter {
  constructor(private readonly db: DbService) {}

  async enqueue(tx: ScopedTx, input: OutboxEventInput): Promise<void> {
    const ctx = getContext();
    await tx.outbox.create({
      data: {
        tenantId: input.tenantId ?? ctx?.tenantId ?? null,
        companyId: input.companyId ?? null,
        branchId: input.branchId ?? null,
        aggregateType: input.aggregateType,
        aggregateId: input.aggregateId,
        eventType: input.eventType,
        payload: input.payload as Prisma.InputJsonValue,
        ...(input.resourceVersion != null
          ? { resourceVersion: BigInt(input.resourceVersion) }
          : {}),
        dispatchedAt: null,
      },
    });
  }

  /** Standalone enqueue in its own platform transaction. */
  async emit(input: OutboxEventInput): Promise<void> {
    await runPlatform(this.db.platformClient(), (tx) => this.enqueue(tx, input));
  }
}
