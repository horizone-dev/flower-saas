/**
 * Country-specific fiscal / e-invoicing adapter port (ADR-0012, Z-8). The core
 * never depends on one vendor or one jurisdiction's document model — actual
 * adapters (e.g. KSA ZATCA / Fatoora) are gated behind the existing
 * KSA-onboarding compliance gate and are **not implemented in task 2.7** —
 * this is the interface only, plus a no-op stub that records intent without
 * calling out to anything. `packages/db`'s `Company.fiscalConfig` may carry a
 * non-secret reference to which provider a company uses; the provider itself
 * never sees or needs a raw secret (those stay Platform-Super-Admin-only per
 * CLAUDE.md rule 26 — unrelated to this port, which only ever calls out through
 * the tenant's non-secret operational config).
 */
export interface EInvoicingIntent {
  readonly companyId: string;
  readonly countryCode: string;
  /** the source business event this fiscal document represents, e.g.
   *  `ORDER_SETTLEMENT:{orderId}` — mirrors the GL's `source_kind:source_id`
   *  idempotency convention (ARCHITECTURE §F.1), never re-derived ad hoc. */
  readonly sourceRef: string;
}

export interface EInvoicingResult {
  readonly accepted: boolean;
  /** a provider-assigned document reference, when `accepted` — null for the
   *  no-op stub, which never actually issues anything. */
  readonly documentRef: string | null;
}

export interface EInvoicingProvider {
  /** Record intent to issue a fiscal document for `intent`. Idempotent on
   *  `intent.sourceRef` — calling twice for the same source must not create two
   *  documents (the actual adapter's job; the no-op stub has no state to
   *  duplicate). */
  submit(intent: EInvoicingIntent): Promise<EInvoicingResult>;
}

export const E_INVOICING_PROVIDER = Symbol('E_INVOICING_PROVIDER');

/** The only implementation that ships in task 2.7 — never calls out anywhere,
 *  never issues a real document. A real adapter (ZATCA or otherwise) is future,
 *  gated work (Z-8), not built here. */
export class NoopEInvoicingProvider implements EInvoicingProvider {
  async submit(intent: EInvoicingIntent): Promise<EInvoicingResult> {
    void intent;
    return { accepted: false, documentRef: null };
  }
}
