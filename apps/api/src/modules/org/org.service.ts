import { Injectable } from '@nestjs/common';
import { requireTenantContext } from '../../common/context/index.js';
import { LimitService } from '../platform/limit.service.js';
import { OrgRepository } from './org.repository.js';

@Injectable()
export class OrgService {
  constructor(
    private readonly repo: OrgRepository,
    private readonly limits: LimitService,
  ) {}

  private get tenantId(): string {
    return requireTenantContext().tenantId;
  }

  createCompany(input: Parameters<OrgRepository['createCompany']>[0]) {
    return this.guardLimit('max_companies', () => this.repo.createCompany(input));
  }

  createBranch(input: Parameters<OrgRepository['createBranch']>[0]) {
    return this.guardLimit('max_branches', () => this.repo.createBranch(input));
  }

  createPosTerminal(input: Parameters<OrgRepository['createPosTerminal']>[0]) {
    return this.guardLimit('max_pos_terminals', () => this.repo.createPosTerminal(input));
  }

  private async guardLimit<T>(
    key: 'max_companies' | 'max_branches' | 'max_pos_terminals',
    create: () => Promise<T>,
  ): Promise<T> {
    await this.limits.assertWithin(this.tenantId, key);
    return create();
  }
}
