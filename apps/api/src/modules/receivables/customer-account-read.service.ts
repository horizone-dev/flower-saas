import { Injectable } from '@nestjs/common';
import { CustomerAccountReadHttpRepository } from './customer-account-read.http.repository.js';

/** Thin pass-through, mirroring `OpeningBalanceService`. */
@Injectable()
export class CustomerAccountReadService {
  constructor(private readonly repo: CustomerAccountReadHttpRepository) {}

  getSummary(input: { companyId: string; branchId: string; customerId: string }) {
    return this.repo.getSummary(input);
  }

  listReceivables(input: {
    companyId: string;
    branchId: string;
    customerId: string;
    cursor?: string;
    limit?: number;
    asOf?: string;
  }) {
    return this.repo.listReceivables(input);
  }

  listAdvances(input: {
    companyId: string;
    branchId: string;
    customerId: string;
    cursor?: string;
    limit?: number;
  }) {
    return this.repo.listAdvances(input);
  }

  listUnappliedReceipts(input: {
    companyId: string;
    branchId: string;
    customerId: string;
    cursor?: string;
    limit?: number;
  }) {
    return this.repo.listUnappliedReceipts(input);
  }

  getStatement(input: {
    companyId: string;
    branchId: string;
    customerId: string;
    from?: string;
    to?: string;
    cursor?: string;
    limit?: number;
  }) {
    return this.repo.getStatement(input);
  }
}
