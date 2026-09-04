import { Injectable } from '@nestjs/common';
import { runPlatform, type PrismaClient } from '@flower/db';
import { DbService } from '../../common/data/index.js';

export interface AuditFilter {
  tenantId?: string | undefined;
  actorId?: string | undefined;
  action?: string | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
  limit: number;
  /** ISO timestamp of the last row on the previous page (keyset on `at`) */
  before?: Date | undefined;
}

export interface AuditRow {
  id: string;
  at: string;
  tenantId: string | null;
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorUserId: string | null;
  actorPlatformUserId: string | null;
  actorAccountType: string;
  impersonatorPlatformUserId: string | null;
  reason: string | null;
}

/** Read-only audit-log access for the Super Admin audit viewer (platform path,
 *  BYPASSRLS). Writes go through `AuditWriter`; this never mutates. */
@Injectable()
export class AuditReadRepository {
  constructor(private readonly db: DbService) {}
  private get c(): PrismaClient {
    return this.db.platformClient();
  }

  async query(filter: AuditFilter): Promise<{ rows: AuditRow[]; nextBefore: string | null }> {
    const where: Record<string, unknown> = {};
    if (filter.tenantId) where['tenantId'] = filter.tenantId;
    if (filter.action) where['action'] = { startsWith: filter.action };
    if (filter.actorId) {
      where['OR'] = [
        { actorUserId: filter.actorId },
        { actorPlatformUserId: filter.actorId },
        { impersonatorPlatformUserId: filter.actorId },
      ];
    }
    const at: Record<string, Date> = {};
    if (filter.from) at['gte'] = filter.from;
    if (filter.to) at['lte'] = filter.to;
    if (filter.before) at['lt'] = filter.before;
    if (Object.keys(at).length > 0) where['at'] = at;

    const rows = await runPlatform(this.c, (tx) =>
      tx.auditLog.findMany({
        where,
        orderBy: { at: 'desc' },
        take: filter.limit + 1,
        select: {
          id: true,
          at: true,
          tenantId: true,
          action: true,
          resourceType: true,
          resourceId: true,
          actorUserId: true,
          actorPlatformUserId: true,
          actorAccountType: true,
          impersonatorPlatformUserId: true,
          reason: true,
        },
      }),
    );

    const page = rows.slice(0, filter.limit);
    const nextBefore =
      rows.length > filter.limit ? (page[page.length - 1]?.at.toISOString() ?? null) : null;
    return {
      rows: page.map((r) => ({ ...r, at: r.at.toISOString() })),
      nextBefore,
    };
  }

  /** The `security_event` view (task 1.14): security-relevant `audit_log` rows +
   *  every `login_security_event`, newest first. */
  async securityEvents(filter: {
    tenantId?: string | undefined;
    limit: number;
  }): Promise<SecurityEventRow[]> {
    const params: unknown[] = [];
    let sql =
      'SELECT "id","at","tenantId","kind","resourceType","resourceId","actorUserId",' +
      '"actorPlatformUserId","actorAccountType","impersonatorPlatformUserId","reason","source" ' +
      'FROM "security_event"';
    if (filter.tenantId) {
      params.push(filter.tenantId);
      sql += ` WHERE "tenantId" = $${params.length}::uuid`;
    }
    params.push(Math.min(500, Math.max(1, filter.limit)));
    sql += ` ORDER BY "at" DESC LIMIT $${params.length}`;

    return runPlatform(this.c, async (tx) => {
      const rows = await tx.$queryRawUnsafe<(Omit<SecurityEventRow, 'at'> & { at: Date })[]>(
        sql,
        ...params,
      );
      return rows.map((r) => ({ ...r, at: r.at.toISOString() }));
    });
  }
}

export interface SecurityEventRow {
  id: string;
  at: string;
  tenantId: string | null;
  kind: string;
  resourceType: string;
  resourceId: string | null;
  actorUserId: string | null;
  actorPlatformUserId: string | null;
  actorAccountType: string | null;
  impersonatorPlatformUserId: string | null;
  reason: string | null;
  source: 'audit' | 'login';
}
