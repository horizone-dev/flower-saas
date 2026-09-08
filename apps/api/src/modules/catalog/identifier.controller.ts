import { Body, Controller, Delete, Get, HttpCode, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import { identifierCodeTypeSchema } from '@flower/shared-types';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { IdentifierService } from './identifier.service.js';
import type { IdentifierResolution, ItemIdentifierRow } from './identifier.repository.js';
import { assertUuid } from './catalog-write.helpers.js';

const createSchema = z
  .object({
    // owner decision 1 — VARIANT is the only accepted target kind
    targetKind: z.literal('VARIANT'),
    targetId: z.string().uuid(),
    codeType: identifierCodeTypeSchema,
    /** required for SKU / BARCODE; MUST be omitted for QR (server-generated) */
    value: z.string().min(1).max(128).optional(),
    /** task 3.6 — BARCODE / QR only; forbidden on a SKU. `packBaseQty` is
     *  computed server-side (exact-or-reject) and is NEVER client-supplied. */
    pack: z
      .object({
        // canonicalized + validated (422 UOM_INVALID_CODE) in the repo layer
        uomCode: z.string().min(1).max(40),
        qty: z.string().min(1).max(40),
      })
      .strict()
      .optional(),
  })
  .strict();

const listQuery = z.object({
  value: z.string().min(1).max(128).optional(),
  targetKind: z.literal('VARIANT').optional(),
  targetId: z.string().uuid().optional(),
});

/**
 * `/v1/catalog/identifiers` — the scannable-code registry (task 3.5).
 * `catalog:view` reads + scan-resolve / `identifiers:manage` writes. Concurrency
 * (owner "CONCURRENCY"): identity is immutable, so there is NO `PUT` and NO
 * `If-Match`; `POST` create + `POST …/reactivate` carry an `Idempotency-Key`;
 * `DELETE` is plain (deactivate — or a hard delete for a DRAFT target).
 * BARCODE / QR writes additionally require the `identifiers.barcode_qr`
 * capability (enforced in `IdentifierService`); SKU writes do not.
 */
@Controller('catalog/identifiers')
export class IdentifierController {
  constructor(private readonly svc: IdentifierService) {}

  @Get()
  @RequirePermission('catalog:view')
  get(
    @Query(new ZodBody(listQuery)) q: z.infer<typeof listQuery>,
  ): Promise<IdentifierResolution | ItemIdentifierRow[]> {
    if (q.value !== undefined) return this.svc.resolve(q.value);
    if (q.targetKind !== undefined && q.targetId !== undefined) {
      return this.svc.listForVariant(q.targetId);
    }
    throw new DomainError(
      'IDENTIFIER_QUERY_INVALID',
      'provide either ?value=<scanned value> or ?targetKind=VARIANT&targetId=<variantId>',
      422,
    );
  }

  @Post()
  @RequirePermission('identifiers:manage')
  @Idempotent({ scope: 'catalog.identifier.create' })
  create(
    @Body(new ZodBody(createSchema)) dto: z.infer<typeof createSchema>,
  ): Promise<ItemIdentifierRow> {
    return this.svc.create({
      targetKind: dto.targetKind,
      targetId: dto.targetId,
      codeType: dto.codeType,
      value: dto.value,
      pack: dto.pack ? { uomCode: dto.pack.uomCode, qty: dto.pack.qty } : undefined,
    });
  }

  @Delete(':id')
  @RequirePermission('identifiers:manage')
  async remove(@Param('id') id: string): Promise<{ status: 'deactivated' | 'deleted' }> {
    assertUuid(id, 'identifier');
    return this.svc.deactivateOrDelete(id);
  }

  @Post(':id/reactivate')
  @HttpCode(200)
  @RequirePermission('identifiers:manage')
  @Idempotent({ scope: 'catalog.identifier.reactivate' })
  async reactivate(@Param('id') id: string): Promise<ItemIdentifierRow> {
    assertUuid(id, 'identifier');
    return this.svc.reactivate(id);
  }
}
