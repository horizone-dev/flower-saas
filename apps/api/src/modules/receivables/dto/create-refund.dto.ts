import { z } from 'zod';

const positiveAmountMinor = z
  .string()
  .regex(/^[1-9]\d*$/, 'requestedAmountMinor must be a positive decimal-digit string');

/** same bounded closed vocabulary as `CreditNote.reasonCode`/
 *  `CancellationCharge.reasonCode` (ADR-0019 §21/§26 taxonomy). */
const refundReasonCode = z.enum([
  'CUSTOMER_REQUEST',
  'DUPLICATE',
  'PRICING_ERROR',
  'DAMAGED',
  'SERVICE_NOT_DELIVERED',
  'ORDER_ERROR',
  'OTHER',
]);

/**
 * Task 3b.8 Checkpoint D — `POST .../advances/:advanceId/refunds` body.
 * `method` carries the full frozen `refund.method` CHECK vocabulary
 * (`CASH | CARD_TERMINAL | BANK_TRANSFER | ONLINE_GATEWAY | OTHER_MANUAL`) —
 * the application layer, not this DTO, narrows which are actually
 * executable in this checkpoint (CASH/BANK_TRANSFER only; CARD_TERMINAL/
 * ONLINE_GATEWAY are rejected with `REFUND_PROVIDER_NOT_IMPLEMENTED`, 501,
 * before any DB work — the `PaymentProvider.refund`/`getStatus` contract has
 * no defined shape anywhere in this repository yet, owner-confirmed out of
 * scope for this checkpoint; OTHER_MANUAL is unconditionally rejected,
 * mirroring `Refund`'s own schema doc comment).
 * `.strict()` rejects `sourcePaymentId`/`customerCompanyAccountId`/any scope
 * identifier — the server resolves the funding Payment from the target
 * Advance's own `CreditNoteCoverageRelease`, never from the client.
 */
export const createRefundSchema = z
  .object({
    requestedAmountMinor: positiveAmountMinor,
    method: z.enum(['CASH', 'CARD_TERMINAL', 'BANK_TRANSFER', 'ONLINE_GATEWAY', 'OTHER_MANUAL']),
    reasonCode: refundReasonCode,
  })
  .strict();

export type CreateRefundDto = z.infer<typeof createRefundSchema>;
