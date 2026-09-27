import { z } from 'zod';

/** positive decimal-digit string — mirrors `create-payment.dto.ts`'s own
 *  `positiveAmountMinor` convention exactly. */
const positiveAmountMinor = z
  .string()
  .regex(/^[1-9]\d*$/, 'amountMinor must be a positive decimal-digit string');

/**
 * `POST .../customers/:customerId/receipts` body — task 3b.6 Checkpoint D
 * (D10). `.strict()` rejects every client-supplied authoritative/
 * server-derived field outright: `invoiceIds`, `customerCompanyAccountId`,
 * `allocatedAmount`, `advanceAmount`, `credit`, any provider secret, any
 * scope identifier. The server resolves the customer's account and the
 * entire FIFO allocation target set itself — the caller supplies only the
 * intended amount and how it was physically tendered.
 *
 * `method` excludes both `ONLINE_GATEWAY` and `CARD_TERMINAL` outright
 * (closed enum) — the service/repository layer independently re-rejects
 * both as defense-in-depth for a caller that bypasses this DTO (D11 final
 * freeze pass). `CARD_TERMINAL` is excluded here, unlike the frozen
 * invoice-payment DTO (`create-payment.dto.ts`), because this schema
 * genuinely cannot represent "this credential is card-terminal-capable"
 * (no field anywhere binds a `ProviderCredential` to a specific tender
 * method) and the public body carries no `providerCredentialId`/
 * `providerKey` to resolve one from — so there is no way to safely
 * distinguish a local terminal from a provider-integrated one for THIS
 * endpoint. Rejected unconditionally until a future, explicit, trusted
 * terminal/provider-selection mechanism is designed.
 */
export const createCustomerReceiptSchema = z
  .object({
    amountMinor: positiveAmountMinor,
    method: z.enum(['CASH', 'BANK_TRANSFER', 'OTHER_MANUAL']),
  })
  .strict();

export type CreateCustomerReceiptDto = z.infer<typeof createCustomerReceiptSchema>;
