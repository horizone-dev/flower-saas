import { Injectable } from '@nestjs/common';
import { AccountRepository, type AccountRow } from './account.repository.js';

/**
 * Task 3b.1 — thin pass-through over `AccountRepository`'s scoped entry
 * points for the controller layer. No permission/step-up enforcement here —
 * that is the controller's `@RequirePermission`/step-up-pipeline
 * responsibility. Never opens a transaction itself (ADR-0004 / CLAUDE.md
 * rule 6 — this class deliberately never imports `@flower/db`).
 */
@Injectable()
export class AccountService {
  constructor(private readonly repo: AccountRepository) {}

  list(input: { companyId: string }): Promise<AccountRow[]> {
    return this.repo.listScoped(input);
  }

  updateDisplay(input: {
    companyId: string;
    id: string;
    displayCode?: string;
    displayName?: string;
    expectedUpdatedAt: Date;
  }): Promise<AccountRow> {
    return this.repo.updateDisplayScoped(input);
  }
}
