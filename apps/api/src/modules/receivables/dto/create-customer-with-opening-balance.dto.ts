import { z } from 'zod';
import { isFiscalDate } from '@flower/shared-types';
import { createCustomerSchema } from '../../customers/dto/create-customer.dto.js';

const positiveAmountMinor = z
  .string()
  .regex(/^[1-9]\d*$/, 'amountMinor must be a positive decimal-digit string');

const effectiveDateField = z
  .string()
  .refine(isFiscalDate, 'effectiveDate must be a valid YYYY-MM-DD civil calendar date');

/**
 * `POST .../branches/:branchId/customers` body — task 3b.6 Checkpoint F
 * (F19/F20). Extends the frozen 3b.2 `createCustomerSchema` (displayName/
 * phone/email, byte-for-byte unchanged) with ONE additive optional field:
 * `openingBalance`. Never touches, imports as a mutable reference, or
 * redefines the original schema — this is a wholly separate schema for a
 * wholly separate, NEW route; the original `/companies/:companyId/customers`
 * route/DTO/controller are completely untouched (frozen 3b.2 compatibility
 * preserved, F19).
 *
 * `openingBalance.branchId` deliberately does NOT exist as a body field —
 * CLAUDE.md rule 5 (`no-scope-from-request` ESLint rule) forbids reading
 * `branchId` from a request body under any circumstance. The route's own
 * PATH `:branchId` (already `@ScopedParam`-authorized against the caller's
 * session branch scope) is the ONLY trusted branch for both the Customer's
 * association and its optional opening balance.
 */
export const createCustomerWithOpeningBalanceSchema = createCustomerSchema
  .extend({
    openingBalance: z
      .object({
        type: z.enum(['RECEIVABLE', 'ADVANCE']),
        amountMinor: positiveAmountMinor,
        effectiveDate: effectiveDateField,
        note: z.string().trim().min(1).max(255).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type CreateCustomerWithOpeningBalanceDto = z.infer<
  typeof createCustomerWithOpeningBalanceSchema
>;
