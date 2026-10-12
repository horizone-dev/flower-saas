import { Injectable } from '@nestjs/common';
import { TrialBalanceRepository, type TrialBalanceReport } from './trial-balance.repository.js';

/**
 * Task 3b.10 Checkpoint A — thin pass-through over {@link TrialBalanceRepository}, exactly like
 * every other read service in this code base (no business rule lives here: the date contract,
 * the exact balance algorithm and the fail-closed invariants are in the pure modules and the one
 * repository). NOT registered in any Nest module and NOT reachable over HTTP — a controller and
 * its permission (`accounting:view`) are a later, separately approved checkpoint.
 */
@Injectable()
export class TrialBalanceService {
  constructor(private readonly repo: TrialBalanceRepository) {}

  get(input: { companyId: string; from: unknown; to: unknown }): Promise<TrialBalanceReport> {
    return this.repo.getForCompanyScoped(input);
  }
}
