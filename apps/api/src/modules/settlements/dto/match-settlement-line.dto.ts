import { z } from 'zod';

/** `POST .../lines/:lineId/match` body — the caller proposes ONLY a
 *  `paymentId`. Trusted scope/provider/currency are never accepted from the
 *  client; the server re-validates the proposal against the complete frozen
 *  eligibility predicate (`settlement-matching.ts`). */
export const matchSettlementLineSchema = z
  .object({
    paymentId: z.string().uuid(),
  })
  .strict();

export type MatchSettlementLineDto = z.infer<typeof matchSettlementLineSchema>;
