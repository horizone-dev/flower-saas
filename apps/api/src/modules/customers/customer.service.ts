import { Injectable } from '@nestjs/common';
import {
  CustomerRepository,
  type CustomerRow,
  type CustomerCompanyAccountRow,
} from './customer.repository.js';

/**
 * Task 3b.2 — thin pass-through over `CustomerRepository`'s scoped entry
 * points, mirroring task 3b.1's `AccountService`/`AccountingPeriodService`
 * exactly. No permission/step-up enforcement here (checkpoint C's
 * `@RequirePermission`/step-up-pipeline concern); never opens a transaction
 * or imports `@flower/db` itself (ADR-0004).
 */
@Injectable()
export class CustomerService {
  constructor(private readonly repo: CustomerRepository) {}

  createForCompany(input: {
    companyId: string;
    displayName: string;
    phone?: string | null;
    email?: string | null;
    createdByUserId?: string | null;
  }): Promise<{ customer: CustomerRow; companyAccount: CustomerCompanyAccountRow }> {
    return this.repo.createForCompanyScoped(input);
  }

  listForCompany(input: {
    companyId: string;
    cursor?: string;
    limit?: number;
  }): Promise<{ data: CustomerRow[]; nextCursor: string | null }> {
    return this.repo.listForCompanyScoped(input);
  }

  searchForCompany(input: {
    companyId: string;
    cursor?: string;
    limit?: number;
    displayNameQuery?: string;
    phoneE164?: string;
    emailNormalized?: string;
  }): Promise<{ data: CustomerRow[]; nextCursor: string | null }> {
    return this.repo.searchForCompanyScoped(input);
  }

  getForCompany(input: { companyId: string; customerId: string }): Promise<CustomerRow> {
    return this.repo.getForCompanyScoped(input);
  }

  updateForCompany(input: {
    companyId: string;
    customerId: string;
    expectedVersion: number;
    displayName?: string;
    phone?: string | null;
    email?: string | null;
  }): Promise<CustomerRow> {
    return this.repo.updateForCompanyScoped(input);
  }

  archiveForCompany(input: {
    companyId: string;
    customerId: string;
    expectedVersion: number;
  }): Promise<CustomerRow> {
    return this.repo.archiveForCompanyScoped(input);
  }

  associateWithCompany(input: {
    companyId: string;
    customerId: string;
  }): Promise<{ companyAccount: CustomerCompanyAccountRow; created: boolean }> {
    return this.repo.associateWithCompanyScoped(input);
  }

  getCompanyAccount(input: {
    companyId: string;
    customerId: string;
  }): Promise<CustomerCompanyAccountRow> {
    return this.repo.getCompanyAccountScoped(input);
  }

  configureCredit(input: {
    companyId: string;
    customerId: string;
    expectedVersion: number;
    creditEnabled: boolean;
    creditLimitMinor?: bigint;
  }): Promise<CustomerCompanyAccountRow> {
    return this.repo.configureCreditScoped(input);
  }

  listForTenant(input: {
    cursor?: string;
    limit?: number;
  }): Promise<{ data: CustomerRow[]; nextCursor: string | null }> {
    return this.repo.listForTenantScoped(input);
  }

  getForTenant(input: { customerId: string }): Promise<CustomerRow> {
    return this.repo.getForTenantScoped(input);
  }
}
