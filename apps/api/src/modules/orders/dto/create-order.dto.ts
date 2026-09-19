import { z } from 'zod';
import { orderLineInputSchema } from './order-line-input.dto.js';

/**
 * `POST .../companies/:companyId/branches/:branchId/orders` body — task 3b.3
 * Checkpoint B, WALK_IN producer only. `.strict()` rejects every
 * client-supplied authoritative/server-derived field outright: `tenantId`,
 * `companyId`, `originBranchId`, `fulfillingBranchId`, `posTerminalId`,
 * `kind`, `status`, `currencyCode`, `currencyExponent`,
 * `commercialSnapshotFingerprint`, `orderNumber`, `version` — none of these
 * has a place in this schema at all (never merely ignored — `.strict()`
 * throws `400 VALIDATION_FAILED` on an unknown key). `customerId` omitted =
 * anonymous WALK_IN (D3b-6) — the ONLY way this schema can express "no
 * customer" (never a `null` — see task 3b.2's own DTO discipline).
 */
export const createOrderSchema = z
  .object({
    customerId: z.string().uuid().optional(),
    lines: z.array(orderLineInputSchema).min(1).max(200),
    documentDiscountMode: z.enum(['NONE', 'AMOUNT', 'PERCENT_BPS']).default('NONE'),
    documentDiscountBps: z.number().int().min(0).max(10000).optional(),
    documentDiscountAmountMinor: z
      .string()
      .regex(/^\d+$/, 'documentDiscountAmountMinor must be a non-negative decimal-digit string')
      .optional(),
    documentDiscountReason: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

export type CreateOrderDto = z.infer<typeof createOrderSchema>;
