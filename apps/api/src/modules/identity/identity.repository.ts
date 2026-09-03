import { Injectable } from '@nestjs/common';
import { runPlatform, runScoped, type PrismaClient } from '@flower/db';
import { DbService } from '../../common/data/index.js';

export interface LoginUserRow {
  id: string;
  tenantId: string;
  accountType: 'OWNER' | 'USER';
  status: string;
  email: string;
  passwordHash: string | null;
  /** a CONFIRMED TOTP factor, if any */
  mfa: { id: string; secretRef: string } | null;
}

/**
 * Identity reads/writes. Login resolves the tenant from a workspace slug via the
 * audited platform path (BYPASSRLS) — you cannot scope to a tenant before you
 * know which one it is — then every subsequent query is tenant-scoped.
 */
@Injectable()
export class IdentityRepository {
  constructor(private readonly db: DbService) {}

  private get app(): PrismaClient {
    return this.db.appClient();
  }
  private get platform(): PrismaClient {
    return this.db.platformClient();
  }

  /** slug -> { tenantId, status }, via the platform path. */
  resolveTenantBySlug(slug: string): Promise<{ id: string; status: string } | null> {
    return runPlatform(this.platform, (tx) =>
      tx.tenant.findUnique({ where: { slug }, select: { id: true, status: true } }),
    );
  }

  /** Load a user + credential + confirmed MFA factor for login, tenant-scoped. */
  loadLoginUser(tenantId: string, email: string): Promise<LoginUserRow | null> {
    return runScoped(this.app, { tenantId }, async (tx) => {
      const user = await tx.user.findUnique({
        where: { tenantId_email: { tenantId, email } },
        select: {
          id: true,
          tenantId: true,
          accountType: true,
          status: true,
          email: true,
          credential: { select: { hash: true } },
          mfaFactors: {
            where: { kind: 'TOTP', status: 'CONFIRMED' },
            select: { id: true, secretRef: true },
            take: 1,
          },
        },
      });
      if (!user) return null;
      return {
        id: user.id,
        tenantId: user.tenantId,
        accountType: user.accountType as 'OWNER' | 'USER',
        status: user.status,
        email: user.email,
        passwordHash: user.credential?.hash ?? null,
        mfa: user.mfaFactors[0] ?? null,
      };
    });
  }

  loadUserById(tenantId: string, userId: string): Promise<LoginUserRow | null> {
    return runScoped(this.app, { tenantId }, async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          tenantId: true,
          accountType: true,
          status: true,
          email: true,
          credential: { select: { hash: true } },
          mfaFactors: {
            where: { kind: 'TOTP', status: 'CONFIRMED' },
            select: { id: true, secretRef: true },
            take: 1,
          },
        },
      });
      if (!user) return null;
      return {
        id: user.id,
        tenantId: user.tenantId,
        accountType: user.accountType as 'OWNER' | 'USER',
        status: user.status,
        email: user.email,
        passwordHash: user.credential?.hash ?? null,
        mfa: user.mfaFactors[0] ?? null,
      };
    });
  }

  /** Insert the immutable `session` history row (the Redis copy is authoritative
   *  for liveness; this is the audit trail). Written via the platform path so it
   *  works for both realms and before any request scoping. */
  async insertSessionRow(row: {
    id: string;
    tenantId: string;
    userId: string;
    posTerminalId: string | null;
    mfaLevel: string;
    ip: string | null;
    userAgent: string | null;
    expiresAt: Date;
  }): Promise<void> {
    await runPlatform(this.platform, (tx) =>
      tx.session.create({
        data: {
          id: row.id,
          tenantId: row.tenantId,
          userId: row.userId,
          posTerminalId: row.posTerminalId,
          mfaLevel: row.mfaLevel,
          ip: row.ip,
          userAgent: row.userAgent,
          expiresAt: row.expiresAt,
        },
      }),
    );
  }

  async markSessionRowRevoked(sessionId: string, reason: string): Promise<void> {
    await runPlatform(this.platform, (tx) =>
      tx.session.updateMany({
        where: { id: sessionId, revokedAt: null },
        data: { revokedAt: new Date(), revokeReason: reason },
      }),
    );
  }

  /** Consume a single-use set-password token (hash compared, not the raw). */
  async consumeSetPasswordToken(
    tokenHash: string,
  ): Promise<{ userId: string; tenantId: string } | null> {
    return runPlatform(this.platform, async (tx) => {
      const row = await tx.setPasswordToken.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, tenantId: true, expiresAt: true, usedAt: true },
      });
      if (!row || row.usedAt !== null || row.expiresAt <= new Date()) return null;
      const consumed = await tx.setPasswordToken.updateMany({
        where: { id: row.id, usedAt: null },
        data: { usedAt: new Date() },
      });
      if (consumed.count !== 1) return null;
      return { userId: row.userId, tenantId: row.tenantId };
    });
  }

  async upsertPasswordCredential(tenantId: string, userId: string, hash: string): Promise<void> {
    await runScoped(this.app, { tenantId }, (tx) =>
      tx.credential.upsert({
        where: { userId },
        create: { tenantId, userId, kind: 'PASSWORD', hash },
        update: { hash },
      }),
    );
  }

  // ── MFA factors ────────────────────────────────────────────────────────
  async upsertMfaFactor(tenantId: string, userId: string, secretRef: string): Promise<void> {
    await runScoped(this.app, { tenantId }, async (tx) => {
      await tx.mfaFactor.deleteMany({ where: { userId, kind: 'TOTP', status: 'PENDING' } });
      await tx.mfaFactor.create({
        data: { tenantId, userId, kind: 'TOTP', secretRef, status: 'PENDING' },
      });
    });
  }

  pendingMfaFactor(
    tenantId: string,
    userId: string,
  ): Promise<{ id: string; secretRef: string } | null> {
    return runScoped(this.app, { tenantId }, (tx) =>
      tx.mfaFactor.findFirst({
        where: { userId, kind: 'TOTP', status: 'PENDING' },
        select: { id: true, secretRef: true },
        orderBy: { createdAt: 'desc' },
      }),
    );
  }

  async confirmMfaFactor(tenantId: string, factorId: string): Promise<void> {
    await runScoped(this.app, { tenantId }, (tx) =>
      tx.mfaFactor.update({
        where: { id: factorId },
        data: { status: 'CONFIRMED', confirmedAt: new Date() },
      }),
    );
  }

  // ── set-password token issuance (admin path — task 1.9 issues, this consumes) ──
  async createSetPasswordToken(
    tenantId: string,
    userId: string,
    tokenHash: string,
    expiresAt: Date,
    createdByUserId: string | null,
    createdByPlatformUserId: string | null,
  ): Promise<void> {
    await runPlatform(this.platform, (tx) =>
      tx.setPasswordToken.create({
        data: { tenantId, userId, tokenHash, expiresAt, createdByUserId, createdByPlatformUserId },
      }),
    );
  }

  async writeLoginSecurityEvent(evt: {
    tenantId: string | null;
    userId: string | null;
    kind: string;
    ip: string | null;
    userAgent: string | null;
    detail?: Record<string, unknown>;
  }): Promise<void> {
    await runPlatform(this.platform, (tx) =>
      tx.loginSecurityEvent.create({
        data: {
          tenantId: evt.tenantId,
          userId: evt.userId,
          kind: evt.kind,
          ip: evt.ip,
          userAgent: evt.userAgent,
          ...(evt.detail ? { detail: evt.detail as Record<string, string> } : {}),
        },
      }),
    );
  }
}
