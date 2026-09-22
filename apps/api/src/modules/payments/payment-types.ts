/**
 * Task 3b.5 Checkpoint A — pure type contract for the frozen Payments domain
 * (docs/phase-3 3b.5 pre-flight, owner-approved contract). NO Prisma, NO DB,
 * NO HTTP. These interfaces describe the eventual persisted shape; Checkpoint
 * B turns them into the actual Prisma schema — nothing here is a schema.
 *
 * Frozen model (owner contract-freeze rounds 1-4):
 *   - `Payment` = a CONFIRMED RECEIPT ONLY. It has no status field — its mere
 *     existence means money was captured. It carries no `invoiceId` — the
 *     Payment→Invoice relationship is owned exclusively by `PaymentAllocation`.
 *   - `PaymentAttempt` = the mechanical/provider lifecycle. Created first,
 *     always — for every tender, synchronous or async.
 *   - `PaymentAllocation` = the ONLY authoritative Payment→Invoice link.
 *   - The FK direction between Payment and PaymentAttempt is ONE-WAY:
 *     `Payment.sourceAttemptId -> PaymentAttempt.id`. `PaymentAttempt` never
 *     carries a back-reference (no `resultingPaymentId`) — this prevents a
 *     cyclic insert/update ordering.
 */

/** A plain correlation tag shared by every component of one Multi Payment
 *  operation. NOT a domain entity/aggregate — it has no status, no lifecycle,
 *  and confers no allocation authority of its own. Minted by the caller
 *  (DB/application orchestration, later checkpoint) — this module defines
 *  only the type, never how the value is generated. */
export type PaymentGroupId = string;

/** Confirmed receipt of money. Conceptually immutable — every field is set
 *  once, at creation, and never mutated afterward. */
export interface PaymentEntity {
  readonly id: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly branchId: string;
  readonly paymentGroupId: PaymentGroupId | null;
  /** UNIQUE NOT NULL — the exact attempt whose CAPTURE produced this row.
   *  One-way FK; `PaymentAttempt` has no reverse pointer. */
  readonly sourceAttemptId: string;
  readonly method: string;
  /** set only when `method` is provider-backed for this Payment's attempt */
  readonly providerKey: string | null;
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly createdByUserId: string | null;
  readonly actingUserId: string | null;
  readonly createdAt: Date;
}

/** The mechanical/provider lifecycle record. Exists before any Payment does;
 *  its `state` is the only mutable field pre-capture. */
export interface PaymentAttemptEntity {
  readonly id: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly branchId: string;
  readonly orderId: string;
  readonly targetInvoiceId: string;
  readonly paymentGroupId: PaymentGroupId | null;
  readonly method: string;
  readonly providerKey: string | null;
  readonly providerCredentialId: string | null;
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  state: string;
  /** the authoritative capture-staleness gate (see order-binding.ts) */
  readonly orderCommercialSnapshotFingerprintAtCreation: string;
  readonly orderVersionAtCreation: number;
  readonly providerReference: string | null;
  readonly idempotencyKey: string;
  readonly createdByUserId: string | null;
  readonly actingUserId: string | null;
  readonly createdAt: Date;
  updatedAt: Date;
}

/** The ONLY authoritative Payment->Invoice relationship. Append-only. */
export interface PaymentAllocationEntity {
  readonly id: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly branchId: string;
  /** UNIQUE — exactly one Allocation per Payment in 3b.5 (single-invoice
   *  scope). A future 3b.6+ fan-out relaxes this without changing Payment's
   *  shape. */
  readonly paymentId: string;
  readonly invoiceId: string;
  readonly amountMinor: bigint;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly createdAt: Date;
}

/** Append-only PaymentAttempt state-transition log, mirroring
 *  ARCHITECTURE.md §42-43's `payment_event`. */
export interface PaymentAttemptEventEntity {
  readonly id: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly branchId: string;
  readonly paymentAttemptId: string;
  readonly fromState: string;
  readonly toState: string;
  readonly occurredAt: Date;
  readonly source: 'SYSTEM' | 'WEBHOOK' | 'USER';
  readonly rawEventRef: string | null;
}

/** The webhook inbox row — provider inbound-event idempotency, separate from
 *  `PaymentAttemptEventEntity`. `tenantId`/`companyId`/`branchId` are
 *  populated only AFTER signature verification derives the trusted scope
 *  (see provider-event.ts / the Checkpoint F webhook flow) — never trusted
 *  from the webhook body itself. */
export interface ProviderPaymentEventEntity {
  readonly id: string;
  readonly tenantId: string;
  readonly companyId: string;
  readonly branchId: string;
  readonly providerCredentialId: string;
  readonly providerEventId: string;
  readonly eventType: string;
  readonly receivedAt: Date;
  readonly payloadHash: string;
  status: string;
  readonly sanitizedMetadata: Readonly<Record<string, string | number | boolean | null>>;
}

/** The opaque webhook routing primitive. Platform-only/BYPASSRLS-style
 *  access (mirrors `ProviderCredential`/`SecretsRepository`'s existing
 *  precedent) — never queried through a normal tenant-scoped repository. */
export interface PaymentWebhookEndpointEntity {
  readonly id: string;
  /** UNIQUE — 1:1 with the owning ProviderCredential */
  readonly providerCredentialId: string;
  readonly createdAt: Date;
}
