import { z } from 'zod';

/** positive decimal-digit string — mirrors `create-customer-receipt.dto.ts`'s
 *  own `positiveAmountMinor` convention exactly. */
const positiveAmountMinor = z
  .string()
  .regex(/^[1-9]\d*$/, 'amountMinor must be a positive decimal-digit string');

/**
 * `POST .../customers/:customerId/advances/from-payment` body — task 3b.6
 * Checkpoint E (E7). `.strict()` rejects every client-supplied
 * authoritative/server-derived field outright: `customerCompanyAccountId`,
 * `tenantId`/`companyId`/`branchId`, `currencyCode`/`currencyExponent`,
 * `sourceType`, any journal/account key, any pre-computed "available"
 * amount. The server resolves the Payment's trusted attribution, remaining
 * capacity, and scope itself — the caller supplies only WHICH Payment and
 * HOW MUCH of it to convert.
 */
export const createPaymentAdvanceConversionSchema = z
  .object({
    paymentId: z.string().uuid(),
    amountMinor: positiveAmountMinor,
  })
  .strict();

export type CreatePaymentAdvanceConversionDto = z.infer<
  typeof createPaymentAdvanceConversionSchema
>;
