import { z } from 'zod';

/** positive decimal-digit string — no leading zero, no sign, no decimal point.
 *  Mirrors `payments/dto/create-payment.dto.ts` and
 *  `receivables/dto/create-customer-advance-application.dto.ts` exactly: money is
 *  a STRING on the wire, never a JS number. */
const positiveAmountMinor = z
  .string()
  .regex(/^[1-9]\d*$/, 'amountMinor must be a positive decimal-digit string');

/**
 * One local tender — the SAME shape and the SAME closed method enum as the frozen
 * synchronous-payment DTO (`createPaymentSchema`), never a second schema.
 *
 * `ONLINE_GATEWAY` is deliberately absent (the closed enum rejects it with a
 * standard `400 VALIDATION_FAILED`), and `CARD_TERMINAL` is always the manual /
 * local variant: there is no `providerCredentialId` field to make it provider-backed
 * (and `.strict()` rejects one). The frozen sale plan independently rejects a
 * provider-backed tender, as defence in depth for a caller that bypasses this DTO.
 */
const tenderSchema = z
  .object({
    method: z.enum(['CASH', 'BANK_TRANSFER', 'OTHER_MANUAL', 'CARD_TERMINAL']),
    amountMinor: positiveAmountMinor,
  })
  .strict();

/**
 * One CustomerAdvance the identified customer spends against THIS sale. The target
 * receivable is the sale's own (server-derived), so — unlike the standalone
 * advance-application DTO — there is no `customerReceivableId` here. Currency is
 * never a client field: the advance must already carry the sale's currency.
 */
const advanceApplicationSchema = z
  .object({
    // normalized to lower case so the idempotency fingerprint and the frozen plan's
    // ascending-id lock order are case-insensitive about the same advance
    advanceId: z
      .string()
      .uuid()
      .transform((id) => id.toLowerCase()),
    amountMinor: positiveAmountMinor,
  })
  .strict();

/**
 * `POST …/companies/:companyId/branches/:branchId/orders/:orderId/complete-sale`
 * body — task 3b.9 Checkpoint E.
 *
 * `.strict()` rejects EVERY client-supplied authoritative or server-derived
 * field outright (`400 VALIDATION_FAILED`), per the repository's DTO policy:
 *
 *   - scope / actor:  `tenantId`, `companyId`, `branchId`, `terminalId`,
 *                     `posTerminalId`, `userId`, `actorUserId`
 *   - customer:       `customerId`, `customerCompanyAccountId` — the ORDER's persisted
 *                     customer is the only customer, and the server picks the
 *                     anonymous or the customer path from it (there is no mode flag)
 *   - money authority: invoice / tax / subtotal / discount totals, `currencyCode`,
 *                     `currencyExponent`, any outstanding amount
 *   - server-owned:   `operationKey` (derived from the request `Idempotency-Key`),
 *                     `finalSaleOutstandingMinor` / any credit-exposure value
 *   - bypass:         `creditOverride`, `force`, `override…` — there is no boolean
 *                     and no flag; the ONLY credit input is a reason
 *
 * The order version is NEVER a body field — it comes from the `If-Match` header.
 *
 * `creditLimitExceptionReason` is a REASON ONLY and grants nothing by itself: the
 * server decides whether an override is actually necessary, and only then does the
 * frozen `CreditOverrideAuthorizationService.authorize` (Owner permission + step-up
 * + a bounded, audited reason) run. Its length bounds (1..255 after trimming) are
 * owned by that frozen service; the cap here is a transport sanity limit only, so
 * the credit rule is not duplicated in the DTO.
 *
 * `paymentIntent` is required — no default, no inference from tender presence
 * (credit is never a tender). `tenders` / `advanceApplications` default to empty.
 */
export const completeSaleSchema = z
  .object({
    paymentIntent: z.enum(['PAY_NOW', 'ON_CREDIT']),
    tenders: z.array(tenderSchema).default([]),
    advanceApplications: z.array(advanceApplicationSchema).default([]),
    creditLimitExceptionReason: z.string().max(1024).optional(),
  })
  .strict();

export type CompleteSaleDto = z.infer<typeof completeSaleSchema>;
