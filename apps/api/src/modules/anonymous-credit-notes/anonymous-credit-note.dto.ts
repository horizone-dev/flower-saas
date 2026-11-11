import { z } from 'zod';
import {
  FAILURE_REASON_CODES,
  REASON_CODES,
  REFUND_METHODS,
} from './anonymous-credit-note-plan.js';

/**
 * Request DTOs. Every schema is STRICT. None accepts a tenant, company, branch, invoice, customer, user or amount-of-credit: the scope
 * comes from the route and the session, the credit amounts are DERIVED by the server from the frozen sale snapshot, and a refund amount
 * is a decimal STRING of minor units (never a float). Free text (`note`) additionally passes the global F3 card-number guard.
 */
const MINOR = z.string().regex(/^[1-9]\d{0,17}$/); // a positive integer of minor units, up to 18 digits
const QUANTITY = z.string().regex(/^\d{1,14}(\.\d{1,4})?$/);
const REFERENCE = z.string().trim().min(1).max(60);

const refundLineSchema = z
  .object({
    method: z.enum(REFUND_METHODS),
    amountMinor: MINOR,
    reference: REFERENCE.optional(),
  })
  .strict();

export const issueAnonymousCreditNoteSchema = z
  .object({
    reasonCode: z.enum(REASON_CODES),
    note: z.string().trim().min(1).max(255).optional(),
    lines: z
      .array(z.object({ orderLineId: z.string().uuid(), quantity: QUANTITY }).strict())
      .min(1)
      .max(200),
    refunds: z.array(refundLineSchema).min(1).max(8),
  })
  .strict();
export type IssueAnonymousCreditNoteDto = z.infer<typeof issueAnonymousCreditNoteSchema>;

export const addRefundSchema = refundLineSchema;
export type AddRefundDto = z.infer<typeof addRefundSchema>;

/** attest that the tender execution really happened; `reference` is an optional receipt / terminal slip number (never card data) */
export const executeRefundSchema = z.object({ reference: REFERENCE.optional() }).strict();
export type ExecuteRefundDto = z.infer<typeof executeRefundSchema>;

export const failRefundSchema = z.object({ reasonCode: z.enum(FAILURE_REASON_CODES) }).strict();
export type FailRefundDto = z.infer<typeof failRefundSchema>;
