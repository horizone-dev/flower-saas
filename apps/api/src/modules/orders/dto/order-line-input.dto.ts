import { z } from 'zod';

/**
 * Task 3b.3 Checkpoint B — the client-submittable COMMERCIAL INTENT for one
 * order line. `.strict()` rejects any client-supplied authoritative/derived
 * field outright (unit price, currency, tax snapshot, UOM conversion ratio,
 * product/variant display names, SKU, `resolutionSource`) — every one of
 * those is server-resolved from Phase 3a's authoritative Catalog/pricing/tax
 * services (`OrderRepository`), never accepted from the request body.
 *
 * `quantity` is a decimal-digit STRING with at most 4 fractional places
 * (`@flower/uom`'s `Quantity` scale), never a JS `number` — mirrors the
 * `creditLimitMinor` decimal-string convention (task 3b.2 §12) for the
 * identical reason: a `number` cannot safely round-trip an arbitrary
 * fixed-point value. `discountAmountMinor` (AMOUNT mode only) is likewise a
 * decimal-digit STRING of a non-negative BigInt minor-unit amount.
 */
export const orderLineInputSchema = z
  .object({
    productId: z.string().uuid(),
    variantId: z.string().uuid(),
    selectedUomCode: z.string().trim().min(1).max(32),
    quantity: z.string().regex(/^\d+(\.\d{1,4})?$/, 'quantity must be a positive decimal (≤4 dp)'),
    discountMode: z.enum(['NONE', 'AMOUNT', 'PERCENT_BPS']).default('NONE'),
    discountBps: z.number().int().min(0).max(10000).optional(),
    discountAmountMinor: z
      .string()
      .regex(/^\d+$/, 'discountAmountMinor must be a non-negative decimal-digit string')
      .optional(),
    discountReason: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

export type OrderLineInputDto = z.infer<typeof orderLineInputSchema>;
