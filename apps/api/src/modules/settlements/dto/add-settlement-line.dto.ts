import { z } from 'zod';

const positiveAmountMinor = z
  .string()
  .regex(/^[1-9]\d*$/, 'must be a positive decimal-digit string');

/**
 * `POST .../settlements/:id/lines` body — task 3b.7 Checkpoint C manual
 * ingestion. `.strict()` rejects every server-owned field: `tenantId`/
 * `companyId`/`branchId`/`batchId`/`currencyCode`/`currencyExponent`/
 * `lineKind` (all derived from the parent Batch — never caller-supplied),
 * and `matchedPaymentId` (a line is NEVER created pre-matched — matching is
 * always a separate, explicitly-validated operation through
 * `settlement-matching.ts`, never trusted directly on create).
 */
export const addSettlementLineSchema = z
  .object({
    externalLineId: z.string().trim().min(1).max(200).optional(),
    providerReference: z.string().trim().min(1).max(200).optional(),
    amountMinor: positiveAmountMinor,
  })
  .strict();

export type AddSettlementLineDto = z.infer<typeof addSettlementLineSchema>;
