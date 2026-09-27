import { z } from 'zod';
import { isFiscalDate } from '@flower/shared-types';

const positiveAmountMinor = z
  .string()
  .regex(/^[1-9]\d*$/, 'must be a positive decimal-digit string');
const nonNegativeAmountMinor = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, 'must be a non-negative decimal-digit string');
const providerSettlementDateField = z
  .string()
  .refine(isFiscalDate, 'providerSettlementDate must be a valid YYYY-MM-DD civil calendar date');

/**
 * `PATCH .../settlements/:id` body — task 3b.7 Checkpoint C. Only the fields
 * Checkpoint A froze as DRAFT-editable: `providerSettlementDate` and the
 * gross/fee/net Money triple. Identity fields (`providerCredentialId`,
 * `externalSettlementId`) and scope stay fixed after create — no route
 * accepts a change to them (default conservative rule, no Checkpoint A
 * exception was frozen for them).
 *
 * If ANY of `grossSettlementMinor`/`providerFeeMinor`/`netBankMinor` is
 * supplied, ALL THREE must be — a partial Money edit is ambiguous (which
 * combination did the caller intend?), so it is rejected outright rather
 * than silently reusing the old value for the omitted field(s).
 */
export const editSettlementBatchSchema = z
  .object({
    providerSettlementDate: providerSettlementDateField.optional(),
    grossSettlementMinor: positiveAmountMinor.optional(),
    providerFeeMinor: nonNegativeAmountMinor.optional(),
    netBankMinor: nonNegativeAmountMinor.optional(),
  })
  .strict()
  .refine(
    (v) => {
      const present = [
        v.grossSettlementMinor !== undefined,
        v.providerFeeMinor !== undefined,
        v.netBankMinor !== undefined,
      ];
      return present.every((p) => p) || present.every((p) => !p);
    },
    {
      message:
        'grossSettlementMinor/providerFeeMinor/netBankMinor must be edited together, or not at all',
    },
  )
  .refine((v) => v.providerSettlementDate !== undefined || v.grossSettlementMinor !== undefined, {
    message: 'at least one editable field is required',
  });

export type EditSettlementBatchDto = z.infer<typeof editSettlementBatchSchema>;
