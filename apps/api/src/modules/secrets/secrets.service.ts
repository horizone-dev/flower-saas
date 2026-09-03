import { Inject, Injectable } from '@nestjs/common';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { getContext } from '../../common/context/index.js';
import { CRYPTO_PROVIDER, type CryptoProvider } from './crypto-provider.js';
import { SecretsRepository, type CredentialRow } from './secrets.repository.js';

/** What an API response is ever allowed to carry — masked, never the plaintext. */
export interface CredentialView {
  id: string;
  provider: string;
  mode: string;
  status: string;
  version: number;
  companyId: string | null;
  branchId: string | null;
  /** e.g. `••••4242` — only on the single-credential read; `••••` on the list */
  secretMask: string;
  nonSecretConfig: Record<string, unknown>;
  updatedAt: string;
}

export interface UpsertCredentialInput {
  provider: string;
  mode: 'TEST' | 'LIVE';
  secret: string;
  companyId?: string | null | undefined;
  branchId?: string | null | undefined;
  nonSecretConfig?: Record<string, unknown> | undefined;
}

const GENERIC_MASK = '••••';

/**
 * The only module that ever touches a decrypted external credential, and only
 * server-side for a single call (CLAUDE.md §27). Platform-realm only — the guard
 * pipeline rejects a tenant token before this runs. The plaintext is never
 * returned, never logged, never placed on an object that a logger might serialise.
 */
@Injectable()
export class SecretsService {
  constructor(
    private readonly repo: SecretsRepository,
    @Inject(CRYPTO_PROVIDER) private readonly crypto: CryptoProvider,
  ) {}

  async list(tenantId: string): Promise<CredentialView[]> {
    await this.assertTenant(tenantId);
    const rows = await this.repo.list(tenantId);
    return rows.map((r) => this.view(r, GENERIC_MASK));
  }

  async get(tenantId: string, id: string): Promise<CredentialView> {
    await this.assertTenant(tenantId);
    const row = await this.repo.getSealed(tenantId, id);
    if (!row) throw new NotFoundError('provider credential');
    const plaintext = await this.crypto.decrypt(row.sealed, { tenantId });
    return this.view(row, mask(plaintext));
  }

  async create(tenantId: string, input: UpsertCredentialInput): Promise<CredentialView> {
    await this.assertTenant(tenantId);
    const sealed = await this.crypto.encrypt(input.secret, { tenantId });
    const row = await this.repo.create({
      tenantId,
      provider: input.provider,
      mode: input.mode,
      companyId: input.companyId ?? null,
      branchId: input.branchId ?? null,
      nonSecretConfig: input.nonSecretConfig ?? {},
      sealed,
      actorPlatformUserId: getContext()?.platformUserId ?? null,
    });
    return this.view(row, mask(input.secret));
  }

  async rotate(
    tenantId: string,
    id: string,
    input: { secret: string; nonSecretConfig?: Record<string, unknown> | undefined },
  ): Promise<CredentialView> {
    await this.assertTenant(tenantId);
    const existing = await this.repo.getSealed(tenantId, id);
    if (!existing) throw new NotFoundError('provider credential');
    const sealed = await this.crypto.encrypt(input.secret, { tenantId });
    const row = await this.repo.rotate({
      tenantId,
      id,
      sealed,
      nonSecretConfig: input.nonSecretConfig,
      actorPlatformUserId: getContext()?.platformUserId ?? null,
    });
    return this.view(row, mask(input.secret));
  }

  async revoke(tenantId: string, id: string): Promise<void> {
    await this.assertTenant(tenantId);
    const existing = await this.repo.getSealed(tenantId, id);
    if (!existing) throw new NotFoundError('provider credential');
    await this.repo.revoke(tenantId, id, getContext()?.platformUserId ?? null);
  }

  private async assertTenant(tenantId: string): Promise<void> {
    if (!(await this.repo.tenantExists(tenantId))) {
      throw new DomainError('TENANT_NOT_FOUND', 'unknown tenant', 404);
    }
  }

  private view(row: CredentialRow, secretMask: string): CredentialView {
    return {
      id: row.id,
      provider: row.provider,
      mode: row.mode,
      status: row.status,
      version: row.version,
      companyId: row.companyId,
      branchId: row.branchId,
      secretMask,
      nonSecretConfig: row.nonSecretConfig,
      updatedAt: row.updatedAt.toISOString(),
    };
  }
}

/** `••••4242` — the last 4 of the plaintext, nothing more. Short secrets: all dots. */
function mask(plaintext: string): string {
  const tail = plaintext.length >= 8 ? plaintext.slice(-4) : '';
  return `${GENERIC_MASK}${tail}`;
}
