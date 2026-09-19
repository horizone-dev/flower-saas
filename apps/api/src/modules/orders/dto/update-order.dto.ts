import { z } from 'zod';
import { orderLineInputSchema } from './order-line-input.dto.js';

/**
 * `PATCH .../companies/:companyId/branches/:branchId/orders/:id` body — task
 * 3b.3 Checkpoint B, DRAFT-only (§18). REPLACE-SET semantics per top-level
 * section (§18/§19 — "prefer replacement semantics… simplifies snapshot
 * correctness"), matching this repository's existing replace-set precedent
 * (Task 3.7/3.8 `PUT { prices: [] }`):
 *   - `lines` present  -> the COMPLETE new line set, fully re-resolved from
 *     scratch (no stale price/UOM/tax/display snapshot is ever preserved for
 *     a changed line set).
 *   - `lines` omitted  -> the existing lines are left untouched.
 *   - `customerId` present (including explicit `null`) -> replaces the
 *     association (`null` clears it — anonymous WALK_IN); omitted -> unchanged.
 *   - `documentDiscountMode` present -> the complete new document-discount
 *     intent (all 4 document-discount fields are read/validated together);
 *     omitted -> unchanged.
 * At least one section must be present (an empty PATCH is a no-op the client
 * should not send — enforced in the service, not this schema, to keep the
 * 400/422 boundary consistent with the rest of this codebase).
 */
export const updateOrderSchema = z
  .object({
    customerId: z.string().uuid().nullable().optional(),
    lines: z.array(orderLineInputSchema).min(1).max(200).optional(),
    documentDiscountMode: z.enum(['NONE', 'AMOUNT', 'PERCENT_BPS']).optional(),
    documentDiscountBps: z.number().int().min(0).max(10000).optional(),
    documentDiscountAmountMinor: z
      .string()
      .regex(/^\d+$/, 'documentDiscountAmountMinor must be a non-negative decimal-digit string')
      .optional(),
    documentDiscountReason: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

export type UpdateOrderDto = z.infer<typeof updateOrderSchema>;
