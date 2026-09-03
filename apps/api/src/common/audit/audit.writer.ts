import { Injectable } from '@nestjs/common';
import { runPlatform, type ScopedTx } from '@flower/db';
import { DbService } from '../data/index.js';
import { getContext } from '../context/index.js';

export interface AuditRecordInput {
  action: string;
  resourceType: string;
  resourceId?: string | null;
  tenantId?: string | null;
  companyId?: string | null;
  branchId?: string | null;
  posTerminalId?: string | null;
  reason?: string | null;
  before?: unknown;
  after?: unknown;
  /** override — normally taken from the request context */
  actorPlatformUserId?: string | null;
  impersonatorPlatformUserId?: string | null;
}

/**
 * Minimal append-only audit writer (Phase 1 task 1.14 adds the auditable-action
 * registry + the request interceptor; the hash chain + dispatcher are Phase 2).
 *
 * `record(tx, …)` writes inside a caller's transaction — so a rolled-back
 * operation leaves no audit row, and a multi-effect operation can write several
 * rows atomically (amendment 2). `emit(…)` opens its own platform transaction
 * for a standalone write.
 */
@Injectable()
export class AuditWriter {
  constructor(private readonly db: DbService) {}

  async record(tx: ScopedTx, input: AuditRecordInput): Promise<void> {
    const ctx = getContext();
    await tx.auditLog.create({
      data: {
        action: input.action,
        resourceType: input.resourceType,
        resourceId: input.resourceId ?? null,
        tenantId: input.tenantId ?? ctx?.tenantId ?? null,
        companyId: input.companyId ?? null,
        branchId: input.branchId ?? null,
        posTerminalId: input.posTerminalId ?? ctx?.posTerminalId ?? null,
        actorUserId: ctx?.userId ?? null,
        actorPlatformUserId: input.actorPlatformUserId ?? ctx?.platformUserId ?? null,
        actorAccountType: ctx?.accountType ?? 'SYSTEM',
        impersonatorPlatformUserId:
          input.impersonatorPlatformUserId ?? ctx?.impersonatorPlatformUserId ?? null,
        reason: input.reason ?? null,
        ...(input.before !== undefined ? { before: input.before as object } : {}),
        ...(input.after !== undefined ? { after: input.after as object } : {}),
        ip: ctx?.ip ?? null,
      },
    });
  }

  async emit(input: AuditRecordInput): Promise<void> {
    await runPlatform(this.db.platformClient(), (tx) => this.record(tx, input));
  }
}
