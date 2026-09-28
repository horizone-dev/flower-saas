import { z } from 'zod';

/**
 * `POST .../settlements/:id/lines/import` body — task 3b.7 Checkpoint C
 * normalized CSV ingestion. No multipart/upload infrastructure exists
 * anywhere in this repository (verified by inspection) — inventing one is
 * out of scope for a DRAFT-ingestion checkpoint, so the CSV travels as a
 * plain string field inside the existing JSON body pipeline, bounded well
 * under Fastify's own 1 MiB default `bodyLimit` (this repo's only existing
 * request-size convention, confirmed via `payment-webhook.controller.
 * integration.test.ts`).
 *
 * Bounded constants (chosen conservatively — no existing repo convention to
 * reuse, reported explicitly per task instruction):
 *   MAX_CSV_BYTES = 200_000  (~200 KB, comfortably under the 1 MiB body limit)
 *   MAX_CSV_ROWS  = 2_000    (excluding the header row)
 */
export const MAX_CSV_BYTES = 200_000;
export const MAX_CSV_ROWS = 2_000;

export const importSettlementLinesCsvSchema = z
  .object({
    csvContent: z.string().min(1).max(MAX_CSV_BYTES),
  })
  .strict();

export type ImportSettlementLinesCsvDto = z.infer<typeof importSettlementLinesCsvSchema>;
