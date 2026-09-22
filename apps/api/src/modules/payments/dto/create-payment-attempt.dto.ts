import { z } from 'zod';

/** positive decimal-digit string — mirrors `create-payment.dto.ts`'s own
 *  `positiveAmountMinor` convention exactly. */
const positiveAmountMinor = z
  .string()
  .regex(/^[1-9]\d*$/, 'amountMinor must be a positive decimal-digit string');

/** a bounded, opaque non-secret key naming a registered provider adapter —
 *  never a credential id, never a secret. Loosely bounded (length only) since
 *  no closed enum of provider keys exists at the app layer (owner §E3 — the
 *  registry itself is the only closed vocabulary, and it fails closed on an
 *  unknown key regardless of this shape check). */
const providerKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_-]+$/, 'providerKey must be a lowercase key (letters, digits, - or _)');

/**
 * `POST .../invoices/:invoiceId/payment-attempts` body — task 3b.5
 * Checkpoint E, the async provider-initiation request (owner §E4). `.strict()`
 * rejects every client-supplied authoritative/server-derived field outright:
 * `providerCredentialId`, `currencyCode`, `currencyExponent`, `tenantId`,
 * `companyId`, `branchId`, `paymentGroupId`, any Order-binding value,
 * `providerReference`, `webhookEndpointId`, any secret/api key — none of
 * these has a place in this schema.
 *
 * `method` is restricted to the two methods this async route can ever
 * accept — `ONLINE_GATEWAY` (always provider-backed) and `CARD_TERMINAL`
 * (provider-backed only via the resolved branch credential; the service
 * layer independently re-checks this via `isProviderBackedTender`, as
 * defense-in-depth for a caller that bypasses this DTO). `CASH` /
 * `BANK_TRANSFER` / `OTHER_MANUAL` are REJECTED by the closed enum itself,
 * before the service layer ever runs.
 */
export const createPaymentAttemptSchema = z
  .object({
    method: z.enum(['ONLINE_GATEWAY', 'CARD_TERMINAL']),
    amountMinor: positiveAmountMinor,
    providerKey: providerKeySchema,
  })
  .strict();

export type CreatePaymentAttemptDto = z.infer<typeof createPaymentAttemptSchema>;
