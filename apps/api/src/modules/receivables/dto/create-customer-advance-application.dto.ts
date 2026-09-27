import { z } from 'zod';

/** positive decimal-digit string — mirrors every other Money-amount DTO
 *  field in this module exactly. */
const positiveAmountMinor = z
  .string()
  .regex(/^[1-9]\d*$/, 'amountMinor must be a positive decimal-digit string');

/**
 * `POST .../customers/:customerId/advances/:advanceId/applications` body —
 * task 3b.6 Checkpoint E (E11). `.strict()` rejects every client-supplied
 * authoritative/server-derived field: no invoice id, no account scope, no
 * FIFO hint, no journal/account key. The caller names the EXACT target
 * receivable and amount — the server resolves everything else (the
 * Advance itself, its account, the receivable's own Invoice where
 * applicable) and never auto-selects a target (E11 — "No auto FIFO in E").
 */
export const createCustomerAdvanceApplicationSchema = z
  .object({
    customerReceivableId: z.string().uuid(),
    amountMinor: positiveAmountMinor,
  })
  .strict();

export type CreateCustomerAdvanceApplicationDto = z.infer<
  typeof createCustomerAdvanceApplicationSchema
>;
