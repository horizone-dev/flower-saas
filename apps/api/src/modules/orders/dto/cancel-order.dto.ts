import { z } from 'zod';
import { isFiscalDate } from '@flower/shared-types';

/** positive decimal-digit string — mirrors every other Money-input DTO in
 *  this codebase exactly (e.g. `create-opening-balance.dto.ts`). */
const positiveAmountMinor = z
  .string()
  .regex(/^[1-9]\d*$/, 'requestedAmountMinor must be a positive decimal-digit string');

/** strict `YYYY-MM-DD` civil calendar date — reuses the SAME `isFiscalDate`
 *  pure validator task 3.9's DATE-contract freeze already established, the
 *  same one `PostingEngineService.resolveExplicitAccountingDate` re-checks
 *  server-side (no JS `Date` anywhere in this input path). */
const accountingDateField = z
  .string()
  .refine(isFiscalDate, 'accountingDate must be a valid YYYY-MM-DD civil calendar date');

/** the SAME closed reasonCode vocabulary as `CancellationCharge.reasonCode`'s
 *  own frozen CHECK constraint (migration 44,
 *  `cancellation_charge_reason_code_chk`) — never a second vocabulary. */
const cancellationChargeReasonCode = z.enum([
  'CUSTOMER_REQUEST',
  'DUPLICATE',
  'PRICING_ERROR',
  'DAMAGED',
  'SERVICE_NOT_DELIVERED',
  'ORDER_ERROR',
  'OTHER',
]);

/**
 * `POST .../companies/:companyId/branches/:branchId/orders/:id/cancel` body
 * — task 3b.8 Checkpoint C.
 *
 * `reason` is mandatory on EVERY cancellation, charge or not (§7 —
 * Checkpoint A froze a mandatory cancellation reason; its durable authority
 * is `audit_log.reason`, written transactionally with the status transition
 * via `AuditWriter`, mirroring `documentDiscountReason`/`discountReason`'s
 * own `z.string().trim().min(1).max(255)` bound exactly).
 *
 * `cancellationCharge` is OPTIONAL — present only for the WITH-CHARGE path
 * (owner-resolved permission: `cancellation_charges:issue`). `requestedAmountMinor`
 * is the ONE caller-supplied amount (§11 — interpreted per the company's
 * CURRENT fiscal policy, TAX_EXCLUSIVE net or TAX_INCLUSIVE total; never a
 * client-supplied `priceTaxMode`/`taxCategoryKey`/`rateBps`, all resolved
 * server-side). `reasonCode` is the CancellationCharge's OWN closed-vocabulary
 * field (distinct from the outer free-text `reason`, which remains the
 * cancellation-command's own audit reason and also becomes
 * `CancellationCharge.note`). `accountingDate` is optional and ONLY ever
 * meaningful here — the no-charge path has no accounting effect at all and
 * must never accept one (§6/§13).
 *
 * Never accepts `customerId`/`customerCompanyAccountId`/`taxCategoryKey`/
 * `rateBps`/`priceTaxMode`/`roundingMode`/`currencyCode`/`currencyExponent` —
 * every one of these is resolved server-side from the trusted Order/Company
 * (§3 — never trust an identifier the server can derive itself).
 */
export const cancelOrderSchema = z
  .object({
    reason: z.string().trim().min(1).max(255),
    cancellationCharge: z
      .object({
        requestedAmountMinor: positiveAmountMinor,
        reasonCode: cancellationChargeReasonCode,
        accountingDate: accountingDateField.optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CancelOrderDto = z.infer<typeof cancelOrderSchema>;
