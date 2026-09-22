import { z } from 'zod';

/** positive decimal-digit string — no leading zero, no sign, no decimal
 *  point (mirrors `documentDiscountAmountMinor`'s convention, tightened to
 *  exclude zero since a payment amount must be strictly positive). */
const positiveAmountMinor = z
  .string()
  .regex(/^[1-9]\d*$/, 'amountMinor must be a positive decimal-digit string');

/**
 * `POST .../invoices/:invoiceId/payments` body — task 3b.5 Checkpoint D,
 * the final synchronous request shape (Checkpoint C's single-tender route
 * completed to N>=1 tenders, not redesigned — a length-1 `tenders` array is
 * still exactly Checkpoint C's own behavior). `.strict()` rejects every
 * client-supplied authoritative/server-derived field outright:
 * `currencyCode`, `currencyExponent`, `providerKey`, `providerCredentialId`,
 * `paymentGroupId`, any Order-binding value, any scope identifier, any
 * computed outstanding amount — none of these has a place in this schema.
 *
 * `method` deliberately excludes `ONLINE_GATEWAY` — the closed enum itself
 * rejects it with a standard `400 VALIDATION_FAILED`, before the service
 * layer ever runs (the service/repository layer independently rejects it
 * too, via `isProviderBackedTender`, as defense-in-depth for a caller that
 * bypasses this DTO). `CARD_TERMINAL` here is always the manual/local
 * variant (no `providerCredentialId` field exists to make it otherwise).
 *
 * `tenders` has no upper bound — no established repository-wide maximum
 * exists for a synchronous tender count, and inventing one "merely for
 * Checkpoint D" is explicitly out of scope (owner contract §D2).
 *
 * The top-level `amountMinor` is the intended TOTAL of this payment
 * operation; the service/repository layer requires it to exactly equal the
 * sum of every `tenders[].amountMinor` (`PAYMENT_MULTI_PAYMENT_SUM_MISMATCH`
 * otherwise) — making the frozen "component sum == intended amount"
 * contract explicit and testable at the API boundary.
 */
const tenderSchema = z
  .object({
    method: z.enum(['CASH', 'BANK_TRANSFER', 'OTHER_MANUAL', 'CARD_TERMINAL']),
    amountMinor: positiveAmountMinor,
  })
  .strict();

export const createPaymentSchema = z
  .object({
    amountMinor: positiveAmountMinor,
    tenders: z.array(tenderSchema).min(1),
  })
  .strict();

export type CreatePaymentDto = z.infer<typeof createPaymentSchema>;
