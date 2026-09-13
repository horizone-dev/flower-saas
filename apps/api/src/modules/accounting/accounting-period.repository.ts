import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { isPgError } from '../../common/errors/pg-error.js';

export interface AccountingPeriodRow {
  id: string;
  tenantId: string;
  companyId: string;
  startDate: Date;
  endDate: Date;
  status: string;
  version: number;
  closedAt: Date | null;
  closedByUserId: string | null;
}

export interface CloseAccountingPeriodResult extends AccountingPeriodRow {
  /** true when this call observed an already-applied close (idempotent replay) — the
   *  caller must not emit a second `accounting.period_closed` audit row for it. */
  alreadyClosedReplay: boolean;
}

const PG_EXCLUSION_VIOLATION = '23P01';
const PG_UNIQUE_VIOLATION = '23505';

/**
 * Task 3b.1 — Accounting Period repository. Overlap safety is DB-enforced (the
 * `btree_gist` exclusion constraint from the 3b.1 migration) — `create` only
 * adds a friendlier app-layer `startDate <= endDate` check before attempting
 * the insert. `findOpenForPostingDate` is the LOCKING lookup the Posting
 * Engine uses: it locks the matched row `FOR SHARE` and inspects that locked
 * row's status, never a pre-lock read, so a concurrent close cannot race it
 * into an inconsistent state (docs/phase-3/PHASE-3B-PLAN.md §J).
 */
@Injectable()
export class AccountingPeriodRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
  ) {
    super(db);
  }

  /** Opens its own transaction (ADR-0004 — the ONLY sanctioned data path for a
   *  scoped module; the service/controller layer never imports `@flower/db`
   *  directly) and records `accounting.period_created` alongside the write. */
  async createScoped(input: {
    companyId: string;
    startDate: Date;
    endDate: Date;
  }): Promise<AccountingPeriodRow> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      const created = await this.create(tx, { tenantId, ...input });
      await this.audit.record(tx, {
        action: 'accounting.period_created',
        resourceType: 'accounting_period',
        resourceId: created.id,
        tenantId,
        companyId: input.companyId,
        after: { startDate: created.startDate, endDate: created.endDate },
      });
      return created;
    });
  }

  async listScoped(input: { companyId: string }): Promise<AccountingPeriodRow[]> {
    const { tenantId } = requireTenantContext();
    return this.scoped((tx) => this.list(tx, { tenantId, ...input }));
  }

  /** Opens its own transaction and records `accounting.period_closed` — never
   *  a second row for an idempotent close-replay (see `close()`'s doc). */
  async closeScoped(input: {
    companyId: string;
    id: string;
    expectedVersion: number;
    closedByUserId: string | null;
  }): Promise<CloseAccountingPeriodResult> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      const closed = await this.close(tx, { tenantId, ...input });
      if (!closed.alreadyClosedReplay) {
        await this.audit.record(tx, {
          action: 'accounting.period_closed',
          resourceType: 'accounting_period',
          resourceId: closed.id,
          tenantId,
          companyId: input.companyId,
          after: { version: closed.version, closedAt: closed.closedAt },
        });
      }
      return closed;
    });
  }

  async create(
    tx: ScopedTx,
    input: { tenantId: string; companyId: string; startDate: Date; endDate: Date },
  ): Promise<AccountingPeriodRow> {
    if (input.startDate > input.endDate) {
      throw new DomainError('VALIDATION_FAILED', 'startDate must be <= endDate', 400);
    }
    try {
      const row = await tx.accountingPeriod.create({
        data: {
          tenantId: input.tenantId,
          companyId: input.companyId,
          startDate: input.startDate,
          endDate: input.endDate,
        },
      });
      return row as AccountingPeriodRow;
    } catch (err) {
      if (isPgError(err, PG_EXCLUSION_VIOLATION) || isPgError(err, PG_UNIQUE_VIOLATION)) {
        throw new DomainError(
          'ACCOUNTING_PERIOD_OVERLAP',
          'this date range overlaps an existing accounting period for this company',
          409,
        );
      }
      throw err;
    }
  }

  /** Locking lookup used by the Posting Engine — see class doc. */
  async findOpenForPostingDate(
    tx: ScopedTx,
    input: { tenantId: string; companyId: string; postingDate: string },
  ): Promise<AccountingPeriodRow> {
    const rows = await tx.$queryRaw<AccountingPeriodRow[]>`
      SELECT "id", "tenantId", "companyId", "startDate", "endDate", "status", "version",
             "closedAt", "closedByUserId"
        FROM "accounting_period"
       WHERE "tenantId" = ${input.tenantId}::uuid
         AND "companyId" = ${input.companyId}::uuid
         AND ${input.postingDate}::date BETWEEN "startDate" AND "endDate"
       FOR SHARE`;
    const row = rows[0];
    if (!row) {
      throw new DomainError(
        'NO_OPEN_ACCOUNTING_PERIOD',
        `no accounting period covers posting date ${input.postingDate}`,
        422,
      );
    }
    if (row.status === 'CLOSED') {
      throw new DomainError(
        'ACCOUNTING_PERIOD_CLOSED',
        `the accounting period covering ${input.postingDate} is closed`,
        422,
      );
    }
    return row;
  }

  async list(
    tx: ScopedTx,
    input: { tenantId: string; companyId: string },
  ): Promise<AccountingPeriodRow[]> {
    const rows = await tx.accountingPeriod.findMany({
      where: { tenantId: input.tenantId, companyId: input.companyId },
      orderBy: { startDate: 'asc' },
    });
    return rows as AccountingPeriodRow[];
  }

  /**
   * `FOR UPDATE` on the target row, re-checks `expectedVersion`. A period
   * already CLOSED whose current version equals `expectedVersion + 1` (i.e.
   * this exact close already happened) is treated as an idempotent success,
   * not a version-mismatch error — a retried close request should not error.
   */
  async close(
    tx: ScopedTx,
    input: {
      tenantId: string;
      companyId: string;
      id: string;
      expectedVersion: number;
      closedByUserId: string | null;
    },
  ): Promise<CloseAccountingPeriodResult> {
    const rows = await tx.$queryRaw<AccountingPeriodRow[]>`
      SELECT "id", "tenantId", "companyId", "startDate", "endDate", "status", "version",
             "closedAt", "closedByUserId"
        FROM "accounting_period" WHERE "id" = ${input.id}::uuid FOR UPDATE`;
    const row = rows[0];
    // companyId (and tenantId, belt-and-suspenders alongside RLS) checked
    // BEFORE any state logic — a period id from a different company in the
    // same tenant must 404, never leak via a version-conflict/close response.
    if (!row || row.tenantId !== input.tenantId || row.companyId !== input.companyId) {
      throw new DomainError('NOT_FOUND', 'accounting period not found', 404);
    }

    if (row.status === 'CLOSED') {
      if (row.version === input.expectedVersion + 1) {
        return { ...row, alreadyClosedReplay: true }; // idempotent replay of an already-applied close
      }
      throw new DomainError(
        'ACCOUNTING_PERIOD_VERSION_CONFLICT',
        `accounting period changed elsewhere (expected version ${input.expectedVersion}, now ${row.version})`,
        409,
      );
    }
    if (row.version !== input.expectedVersion) {
      throw new DomainError(
        'ACCOUNTING_PERIOD_VERSION_CONFLICT',
        `accounting period changed elsewhere (expected version ${input.expectedVersion}, now ${row.version})`,
        409,
      );
    }

    const updated = await tx.accountingPeriod.update({
      where: { id: input.id },
      data: {
        status: 'CLOSED',
        closedAt: new Date(),
        closedByUserId: input.closedByUserId,
        version: { increment: 1 },
      },
    });
    return { ...(updated as AccountingPeriodRow), alreadyClosedReplay: false };
  }
}
