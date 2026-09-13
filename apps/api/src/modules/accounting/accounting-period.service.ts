import { Injectable } from '@nestjs/common';
import {
  AccountingPeriodRepository,
  type AccountingPeriodRow,
} from './accounting-period.repository.js';

/**
 * Task 3b.1 — thin pass-through over `AccountingPeriodRepository`'s scoped
 * entry points for the controller layer. No permission/step-up enforcement
 * here — that is the controller's `@RequirePermission`/step-up-pipeline
 * responsibility. Never opens a transaction itself (ADR-0004 / CLAUDE.md
 * rule 6 — the repository's `*Scoped` methods are the only sanctioned data
 * path from a scoped module; this class deliberately never imports `@flower/db`).
 */
@Injectable()
export class AccountingPeriodService {
  constructor(private readonly repo: AccountingPeriodRepository) {}

  create(input: {
    companyId: string;
    startDate: Date;
    endDate: Date;
  }): Promise<AccountingPeriodRow> {
    return this.repo.createScoped(input);
  }

  list(input: { companyId: string }): Promise<AccountingPeriodRow[]> {
    return this.repo.listScoped(input);
  }

  close(input: {
    companyId: string;
    id: string;
    expectedVersion: number;
    closedByUserId: string | null;
  }): Promise<AccountingPeriodRow> {
    return this.repo.closeScoped(input);
  }
}
