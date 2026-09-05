import { Controller, Get, Param, Query } from '@nestjs/common';
import { z } from 'zod';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam } from '../../common/auth/pipeline.decorators.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { LocalizationService } from './localization.service.js';

const referenceQuerySchema = z.object({ at: z.string().datetime().optional() });

function parseAt(raw: string | undefined): Date {
  if (!raw) return new Date();
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new DomainError('INVALID_DATE', '"at" must be a valid ISO-8601 datetime', 400);
  }
  return parsed;
}

/**
 * `/v1/localization` — the minimum authenticated, read-only surface task 2.7
 * needs (task 2.8's probe suite is extended to these routes). Both routes
 * reuse the existing `settings:tenant:manage` permission (already the
 * permission `OrgController`'s company reads use, ARCHITECTURE §9 / task 1
 * precedent) rather than inventing a new key — this data exists specifically
 * to support tenant/company configuration screens, the same purpose
 * `settings:tenant:manage` already governs. Neither route is `@Public()`: the
 * data is non-sensitive, but CLAUDE.md rule 9 and the owner's explicit
 * instruction both require every route to declare an explicit permission.
 */
@Controller('localization')
export class LocalizationController {
  constructor(private readonly localization: LocalizationService) {}

  @Get('reference')
  @RequirePermission('settings:tenant:manage')
  reference(@Query() raw: Record<string, string>) {
    const q = referenceQuerySchema.parse(raw);
    return this.localization.reference(parseAt(q.at));
  }

  @Get('companies/:companyId')
  @RequirePermission('settings:tenant:manage')
  @ScopedParam({ company: 'companyId' })
  companyProfile(@Param('companyId') companyId: string, @Query() raw: Record<string, string>) {
    const q = referenceQuerySchema.parse(raw);
    return this.localization.forCompany(companyId, parseAt(q.at));
  }
}
