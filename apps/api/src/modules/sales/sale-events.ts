/**
 * Task 3b.9 Checkpoint E — the frozen sale-level business-outbox event vocabulary
 * (owner ruling OD-7): exactly ONE coarse event, `orders.sale_completed`, written in
 * the SAME transaction as the sale (never by the controller after the commit), on the
 * FIRST successful execution only — an idempotency replay never reaches the handler,
 * so it can never emit another.
 *
 * Mirrors `PaymentEventType`'s own role exactly: a plain string-literal type checked
 * at the single `outbox.enqueue(… satisfies SaleEventType)` call site. It is kept
 * local to this module rather than added to `@flower/shared-types` because nothing
 * outside `apps/api` needs the type at compile time, and neither the worker's
 * dispatcher nor the realtime gateway has an event-type allow-list — they relay and
 * authorize by the envelope's tenant / company / branch scope only.
 *
 * The frozen `payments.payment_recorded` events (one per tender, written inside the
 * frozen capture primitive) are untouched and still emit naturally.
 */
export type SaleEventType = 'orders.sale_completed';

/** the bounded payload of `orders.sale_completed` — identifiers a consumer needs to
 *  refetch over REST, and nothing else: no Money, no customer data, no order lines,
 *  no payment / credential detail, no journal detail, no advance balance. */
export interface SaleCompletedPayload {
  readonly orderId: string;
  readonly invoiceId: string;
}
