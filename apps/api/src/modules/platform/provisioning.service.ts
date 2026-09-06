import { createHash, randomBytes } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { DomainError } from '../../common/errors/domain-error.js';
import { RedisService } from '../../common/redis/redis.module.js';
import { PlanRepository } from './plan.repository.js';
import { ProvisioningRepository } from './provisioning.repository.js';

export interface ProvisionTenantCommand {
  slug: string;
  name: string;
  region: string;
  /** The company's legal-entity country — THE fiscal source (currency / VAT),
   *  resolved atomically from the `country` reference table inside the same
   *  provisioning transaction (task 2.7, architecture correction 4).
   *  Deliberately **not** derived from `region` — the two are independent
   *  concepts (hosting/infra region vs. legal/fiscal jurisdiction) and must
   *  never be silently conflated, even though today's only supported region
   *  happens to share a code with its country. */
  companyCountryCode: string;
  /** Business-Type preset — REQUIRED for a new tenant (owner §1). Validated as a
   *  known ACTIVE `business_type_template.key` inside the provisioning txn. */
  businessTypeKey: string;
  planVersionId: string;
  ownerEmail: string;
  companyLegalNameEn?: string | undefined;
  branchName?: string | undefined;
  branchTimezone?: string | undefined;
  idempotencyKey?: string | undefined;
  actorPlatformUserId: string | null;
}

export interface ProvisionTenantResponse {
  tenantId: string;
  companyId: string;
  branchId: string;
  posTerminalId: string;
  ownerUserId: string;
  /** the single-use set-password link token (returned once — never stored raw, OD3) */
  setPasswordToken: string;
}

@Injectable()
export class ProvisioningService {
  constructor(
    private readonly plans: PlanRepository,
    private readonly repo: ProvisioningRepository,
    private readonly redis: RedisService,
  ) {}

  private get client(): Redis | null {
    return this.redis.get();
  }

  async provision(cmd: ProvisionTenantCommand): Promise<ProvisionTenantResponse> {
    const idemKey = cmd.idempotencyKey ? `idem:provision:${cmd.idempotencyKey}` : null;
    if (idemKey) {
      const cached = await this.client?.get(idemKey);
      if (cached) return JSON.parse(cached) as ProvisionTenantResponse;
    }

    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(cmd.slug)) {
      throw new DomainError('INVALID_SLUG', 'slug must be lowercase alphanumeric + hyphen', 422);
    }
    if (await this.repo.slugTaken(cmd.slug)) {
      throw new DomainError('SLUG_TAKEN', `workspace "${cmd.slug}" already exists`, 409);
    }

    const config = await this.plans.planVersionConfig(cmd.planVersionId);
    if (!config) throw new DomainError('PLAN_VERSION_NOT_FOUND', 'unknown plan version', 422);

    const setPasswordToken = randomBytes(32).toString('base64url');
    const setPasswordTokenHash = createHash('sha256').update(setPasswordToken).digest('hex');

    const result = await this.repo.provision({
      slug: cmd.slug,
      name: cmd.name,
      region: cmd.region,
      companyCountryCode: cmd.companyCountryCode,
      businessTypeKey: cmd.businessTypeKey,
      planVersionId: cmd.planVersionId,
      companyLegalNameEn: cmd.companyLegalNameEn ?? cmd.name,
      branchName: cmd.branchName ?? 'Main Branch',
      branchTimezone: cmd.branchTimezone ?? 'Asia/Dubai',
      posTerminalCode: 'POS-01',
      ownerEmail: cmd.ownerEmail,
      setPasswordTokenHash,
      setPasswordExpiresAt: new Date(Date.now() + 1000 * 60 * 60 * 48),
      entitlements: config.entitlements.map((e) => ({
        moduleKey: e.moduleKey,
        enabled: e.enabled,
      })),
      limits: config.limits.map((l) => ({ limitKey: l.limitKey, value: l.value })),
      actorPlatformUserId: cmd.actorPlatformUserId,
    });

    const response: ProvisionTenantResponse = { ...result, setPasswordToken };
    if (idemKey) await this.client?.set(idemKey, JSON.stringify(response), 'EX', 60 * 60 * 24);
    return response;
  }
}
