import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';
import { PlatformRealm } from '../../common/auth/pipeline.decorators.js';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { AuditReadRepository } from './audit-read.repository.js';

const querySchema = z.object({
  tenantId: z.string().uuid().optional(),
  actorId: z.string().uuid().optional(),
  action: z.string().max(80).optional(),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  before: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

/** `/v1/platform/audit` — the Super Admin audit viewer (PHASE-1-PLAN §1.11).
 *  Read-only; filter by tenant / actor / action prefix / date; keyset paged. */
@Controller('platform/audit')
@PlatformRealm()
export class AuditController {
  constructor(private readonly audit: AuditReadRepository) {}

  @Get()
  @RequirePermission('platform:audit:view')
  query(@Query() raw: Record<string, string>) {
    const q = querySchema.parse(raw);
    return this.audit.query({
      tenantId: q.tenantId,
      actorId: q.actorId,
      action: q.action,
      from: q.from ? new Date(q.from) : undefined,
      to: q.to ? new Date(q.to) : undefined,
      before: q.before ? new Date(q.before) : undefined,
      limit: q.limit,
    });
  }
}
