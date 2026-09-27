import { z } from 'zod';
import { isFiscalDate } from '@flower/shared-types';

/** positive decimal-digit string — mirrors every other Money-input DTO in
 *  this codebase exactly (e.g. `create-opening-balance.dto.ts`). */
const positiveAmountMinor = z
  .string()
  .regex(/^[1-9]\d*$/, 'must be a positive decimal-digit string');

/** non-negative decimal-digit string (fee/net may legitimately be zero). */
const nonNegativeAmountMinor = z
  .string()
  .regex(/^(0|[1-9]\d*)$/, 'must be a non-negative decimal-digit string');

const currencyCodeField = z.string().regex(/^[A-Z]{3}$/, 'must be a 3-letter ISO currency code');

const providerSettlementDateField = z
  .string()
  .refine(isFiscalDate, 'providerSettlementDate must be a valid YYYY-MM-DD civil calendar date');

/**
 * `POST .../settlements` body — task 3b.7 Checkpoint C. `.strict()` rejects
 * every client-supplied authoritative/server-derived field outright:
 * `tenantId`/`companyId`/`branchId` (trusted scope comes ONLY from the
 * authenticated session + path params — never the body), `currencyExponent`
 * (NEVER trusted from the client — resolved server-side from `currencyCode`
 * via `packages/money`), `state`/`version`/`journalEntryId`/`finalizedAt`
 * (server-owned lifecycle fields).
 */
export const createSettlementBatchSchema = z
  .object({
    providerCredentialId: z.string().uuid(),
    externalSettlementId: z.string().trim().min(1).max(200),
    providerSettlementDate: providerSettlementDateField,
    grossSettlementMinor: positiveAmountMinor,
    providerFeeMinor: nonNegativeAmountMinor,
    netBankMinor: nonNegativeAmountMinor,
    currencyCode: currencyCodeField,
  })
  .strict();

export type CreateSettlementBatchDto = z.infer<typeof createSettlementBatchSchema>;
