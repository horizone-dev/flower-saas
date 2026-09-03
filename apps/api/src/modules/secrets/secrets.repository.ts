import { Injectable } from '@nestjs/common';
import type { Prisma } from '@flower/db';
import { DbService, PlatformRepository } from '../../common/data/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import type { SealedSecret } from './crypto-provider.js';

const asJson = (v: Record<string, unknown>): Prisma.InputJsonValue => v as Prisma.InputJsonValue;

export interface CredentialRow {
  id: string;
  tenantId: string;
  provider: string;
  mode: string;
  status: string;
  version: number;
  companyId: string | null;
  branchId: string | null;
  nonSecretConfig: Record<string, unknown>;
  updatedAt: Date;
}

interface SealedRow extends CredentialRow {
  sealed: SealedSecret;
}

/**
 * `provider_credential` persistence — the audited platform path only (BYPASSRLS).
 * No tenant-realm code can reach this class (boundary lint). Every mutation
 * writes its `audit_log` row in the same transaction (amendment 2). The three
 * cipher blobs are stored as-is and never selected by a list/read that feeds an
 * API response.
 */
@Injectable()
export class SecretsRepository extends PlatformRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
  ) {
    super(db);
  }

  tenantExists(tenantId: string): Promise<boolean> {
    return this.platform((tx) =>
      tx.tenant
        .findUnique({ where: { id: tenantId }, select: { id: true } })
        .then((t) => t !== null),
    );
  }

  list(tenantId: string): Promise<CredentialRow[]> {
    return this.platform((tx) =>
      tx.providerCredential
        .findMany({
          where: { tenantId },
          orderBy: [{ provider: 'asc' }, { version: 'desc' }],
          select: SELECT_META,
        })
        .then((rows) => rows.map(toRow)),
    );
  }

  async getSealed(tenantId: string, id: string): Promise<SealedRow | null> {
    return this.platform(async (tx) => {
      const row = await tx.providerCredential.findFirst({
        where: { id, tenantId },
        select: {
          ...SELECT_META,
          secretCiphertext: true,
          secretNonce: true,
          dekWrapped: true,
        },
      });
      if (!row) return null;
      return {
        ...toRow(row),
        sealed: {
          ciphertext: row.secretCiphertext,
          nonce: row.secretNonce,
          dekWrapped: row.dekWrapped,
        },
      };
    });
  }

  async create(input: {
    tenantId: string;
    provider: string;
    mode: string;
    companyId: string | null;
    branchId: string | null;
    nonSecretConfig: Record<string, unknown>;
    sealed: SealedSecret;
    actorPlatformUserId: string | null;
  }): Promise<CredentialRow> {
    return this.platform(async (tx) => {
      const row = await tx.providerCredential.create({
        data: {
          tenantId: input.tenantId,
          provider: input.provider,
          mode: input.mode,
          companyId: input.companyId,
          branchId: input.branchId,
          nonSecretConfig: asJson(input.nonSecretConfig),
          secretCiphertext: Buffer.from(input.sealed.ciphertext),
          secretNonce: Buffer.from(input.sealed.nonce),
          dekWrapped: Buffer.from(input.sealed.dekWrapped),
          updatedByPlatformUserId: input.actorPlatformUserId,
        },
        select: SELECT_META,
      });
      await this.audit.record(tx, {
        action: 'provider_credential.created',
        resourceType: 'provider_credential',
        resourceId: row.id,
        tenantId: input.tenantId,
        after: { provider: input.provider, mode: input.mode },
      });
      return toRow(row);
    });
  }

  async rotate(input: {
    tenantId: string;
    id: string;
    sealed: SealedSecret;
    nonSecretConfig?: Record<string, unknown> | undefined;
    actorPlatformUserId: string | null;
  }): Promise<CredentialRow> {
    return this.platform(async (tx) => {
      const row = await tx.providerCredential.update({
        where: { id: input.id },
        data: {
          secretCiphertext: Buffer.from(input.sealed.ciphertext),
          secretNonce: Buffer.from(input.sealed.nonce),
          dekWrapped: Buffer.from(input.sealed.dekWrapped),
          version: { increment: 1 },
          status: 'ACTIVE',
          updatedByPlatformUserId: input.actorPlatformUserId,
          ...(input.nonSecretConfig ? { nonSecretConfig: asJson(input.nonSecretConfig) } : {}),
        },
        select: SELECT_META,
      });
      await this.audit.record(tx, {
        action: 'provider_credential.rotated',
        resourceType: 'provider_credential',
        resourceId: row.id,
        tenantId: input.tenantId,
        after: { version: row.version },
      });
      return toRow(row);
    });
  }

  async revoke(tenantId: string, id: string, actorPlatformUserId: string | null): Promise<void> {
    await this.platform(async (tx) => {
      await tx.providerCredential.update({ where: { id }, data: { status: 'REVOKED' } });
      await this.audit.record(tx, {
        action: 'provider_credential.revoked',
        resourceType: 'provider_credential',
        resourceId: id,
        tenantId,
        actorPlatformUserId,
      });
    });
  }
}

const SELECT_META = {
  id: true,
  tenantId: true,
  provider: true,
  mode: true,
  status: true,
  version: true,
  companyId: true,
  branchId: true,
  nonSecretConfig: true,
  updatedAt: true,
} as const;

function toRow(r: {
  id: string;
  tenantId: string;
  provider: string;
  mode: string;
  status: string;
  version: number;
  companyId: string | null;
  branchId: string | null;
  nonSecretConfig: unknown;
  updatedAt: Date;
}): CredentialRow {
  return {
    id: r.id,
    tenantId: r.tenantId,
    provider: r.provider,
    mode: r.mode,
    status: r.status,
    version: r.version,
    companyId: r.companyId,
    branchId: r.branchId,
    nonSecretConfig: (r.nonSecretConfig as Record<string, unknown> | null) ?? {},
    updatedAt: r.updatedAt,
  };
}
