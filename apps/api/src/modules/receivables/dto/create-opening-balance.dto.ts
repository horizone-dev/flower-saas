import { z } from 'zod';
import { isFiscalDate } from '@flower/shared-types';

/** positive decimal-digit string — mirrors every other Money-input DTO in
 *  this module exactly. */
const positiveAmountMinor = z
  .string()
  .regex(/^[1-9]\d*$/, 'amountMinor must be a positive decimal-digit string');

/** strict `YYYY-MM-DD` civil calendar date, no time/timezone component —
 *  reuses the SAME `isFiscalDate` pure validator task 3.9's DATE-contract
 *  freeze already established (no JS `Date` anywhere in this input path). */
const effectiveDateField = z
  .string()
  .refine(isFiscalDate, 'effectiveDate must be a valid YYYY-MM-DD civil calendar date');

/**
 * `POST .../customers/:customerId/opening-balance` body — task 3b.6
 * Checkpoint F (F4/F6/F8/F15/F16). `.strict()` rejects every client-supplied
 * authoritative/server-derived field outright: `tenantId`/`companyId`/
 * `branchId`, `customerCompanyAccountId`, `currencyCode`/`currencyExponent`
 * (F6 — company currency is the sole authoritative Money basis, resolved
 * server-side), any internal `sourceType`/journal account key, any
 * pre-computed projection amount. The server resolves scope, currency, and
 * the uniqueness invariant itself — the caller supplies only WHICH type,
 * HOW MUCH, the historical effective date, and an optional note.
 *
 * `type` is REQUIRED and exactly one of `'RECEIVABLE' | 'ADVANCE'` (F4 — no
 * default opening balance, no signed-number/ambiguous-sign semantics, never
 * both simultaneously).
 */
export const createOpeningBalanceSchema = z
  .object({
    type: z.enum(['RECEIVABLE', 'ADVANCE']),
    amountMinor: positiveAmountMinor,
    effectiveDate: effectiveDateField,
    note: z.string().trim().min(1).max(255).optional(),
  })
  .strict();

export type CreateOpeningBalanceDto = z.infer<typeof createOpeningBalanceSchema>;
