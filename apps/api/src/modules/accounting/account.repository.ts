import { Injectable } from '@nestjs/common';
import type { ScopedTx } from '@flower/db';
import { ACCOUNTING_REFERENCE_ACCOUNTS } from '@flower/db';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { isPgError } from '../../common/errors/pg-error.js';

const PG_UNIQUE_VIOLATION = '23505';

export interface AccountRow {
  id: string;
  tenantId: string;
  companyId: string;
  key: string;
  category: string;
  displayCode: string;
  displayName: string;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Task 3b.1 — Chart-of-Accounts repository. `ensureDefaultAccounts` is the
 * idempotent existing-company bootstrap primitive (docs/phase-3/PHASE-3B-PLAN.md
 * §J): it inserts any of the 14 frozen reference rows not yet present for a
 * company and NEVER touches an existing row's `displayCode`/`displayName` —
 * an owner's prior customization is preserved on every replay. New-company
 * provisioning seeds all 14 rows directly (`provisioning.repository.ts`); this
 * method exists for a pre-existing company that predates task 3b.1's rollout.
 */
@Injectable()
export class AccountRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
  ) {
    super(db);
  }

  async listScoped(input: { companyId: string }): Promise<AccountRow[]> {
    const { tenantId } = requireTenantContext();
    return this.scoped((tx) => this.list(tx, { tenantId, ...input }));
  }

  /** Opens its own transaction and records `accounting.account_display_updated`. */
  async updateDisplayScoped(input: {
    companyId: string;
    id: string;
    displayCode?: string;
    displayName?: string;
    expectedUpdatedAt: Date;
  }): Promise<AccountRow> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      const updated = await this.updateDisplay(tx, { tenantId, ...input });
      await this.audit.record(tx, {
        action: 'accounting.account_display_updated',
        resourceType: 'account',
        resourceId: updated.id,
        tenantId,
        companyId: input.companyId,
        after: { displayCode: updated.displayCode, displayName: updated.displayName },
      });
      return updated;
    });
  }

  async ensureDefaultAccounts(
    tx: ScopedTx,
    input: { tenantId: string; companyId: string },
  ): Promise<{ insertedCount: number }> {
    const result = await tx.account.createMany({
      data: ACCOUNTING_REFERENCE_ACCOUNTS.map((a) => ({
        tenantId: input.tenantId,
        companyId: input.companyId,
        key: a.key,
        category: a.category,
        displayCode: a.defaultDisplayCode,
        displayName: a.defaultDisplayName,
      })),
      skipDuplicates: true,
    });
    return { insertedCount: result.count };
  }

  async list(tx: ScopedTx, input: { tenantId: string; companyId: string }): Promise<AccountRow[]> {
    const rows = await tx.account.findMany({
      where: { tenantId: input.tenantId, companyId: input.companyId },
      orderBy: { displayCode: 'asc' },
    });
    return rows as AccountRow[];
  }

  /**
   * Only `displayCode`/`displayName` are settable — `key`/`category` are
   * immutable posting identity, never exposed here. No `version` column exists
   * on `account` (V1 decision — the 14 system accounts are fixed, non-
   * disableable); optimistic concurrency instead compares the caller-supplied
   * `expectedUpdatedAt` (an `If-Match`-style precondition) against the row's
   * current `updatedAt`, mirroring the same intent as the int-`version`
   * pattern used elsewhere without adding a column this table doesn't need.
   */
  async updateDisplay(
    tx: ScopedTx,
    input: {
      tenantId: string;
      companyId: string;
      id: string;
      displayCode?: string;
      displayName?: string;
      expectedUpdatedAt: Date;
    },
  ): Promise<AccountRow> {
    const current = await tx.account.findFirst({
      where: { id: input.id, tenantId: input.tenantId, companyId: input.companyId },
    });
    if (!current) throw new DomainError('NOT_FOUND', 'account not found', 404);
    if (current.updatedAt.getTime() !== input.expectedUpdatedAt.getTime()) {
      throw new DomainError(
        'ACCOUNT_VERSION_CONFLICT',
        'account changed elsewhere (stale If-Match)',
        409,
      );
    }
    try {
      const updated = await tx.account.update({
        where: { id: input.id },
        data: {
          ...(input.displayCode !== undefined ? { displayCode: input.displayCode } : {}),
          ...(input.displayName !== undefined ? { displayName: input.displayName } : {}),
        },
      });
      return updated as AccountRow;
    } catch (err) {
      if (isPgError(err, PG_UNIQUE_VIOLATION)) {
        throw new DomainError(
          'ACCOUNT_DISPLAY_CODE_CONFLICT',
          'another account in this company already uses that displayCode',
          409,
        );
      }
      throw err;
    }
  }
}
