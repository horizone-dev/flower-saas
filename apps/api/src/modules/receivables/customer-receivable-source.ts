/**
 * Task 3b.6 Checkpoint A — pure `CustomerReceivable` source-type shape
 * validation. NO DB, NO Prisma types — a plain discriminated union and a
 * structural validator only; Checkpoint B is responsible for realizing this
 * as an actual table/CHECK constraint.
 *
 * Frozen model (3b.6 architecture-freeze, this session):
 *   sourceType='INVOICE' — the customer-account AR anchor for a
 *     customer-linked Invoice. `invoiceId` present; principal is NEVER
 *     independently authored here (always read from the immutable
 *     `Invoice.totalAmountMinor` by the caller); `creditAuthorized` records
 *     whether this specific receivable's exposure was intentionally granted
 *     (`ON_CREDIT`) or not (`PAY_NOW`, possibly later short-paid).
 *   sourceType='OPENING' — a receivable with no Invoice at all; principal
 *     IS authored here (`originalAmountMinor`/`currencyCode`/
 *     `currencyExponent`), and a `branchId` is required (3b.6
 *     architecture-freeze: opening balances are branch-scoped, no
 *     ambiguous/null branch is ever permitted).
 */

export interface CustomerReceivableInvoiceSource {
  readonly sourceType: 'INVOICE';
  readonly invoiceId: string;
  readonly creditAuthorized: boolean;
}

export interface CustomerReceivableOpeningSource {
  readonly sourceType: 'OPENING';
  readonly originalAmountMinor: bigint;
  readonly currencyCode: string;
  readonly currencyExponent: number;
  readonly branchId: string;
}

export type CustomerReceivableSource =
  CustomerReceivableInvoiceSource | CustomerReceivableOpeningSource;

/**
 * Throws a plain `RangeError` for any shape that does not match its own
 * `sourceType`'s frozen requirements — e.g. an `INVOICE` source carrying an
 * `originalAmountMinor` (principal duplication), or an `OPENING` source
 * missing `branchId` (an ambiguous, unattributed opening balance).
 */
export function assertCustomerReceivableSourceShape(source: CustomerReceivableSource): void {
  if (source.sourceType === 'INVOICE') {
    if (!source.invoiceId) {
      throw new RangeError('CustomerReceivable(INVOICE) requires a non-empty invoiceId');
    }
    if ('originalAmountMinor' in source) {
      throw new RangeError(
        'CustomerReceivable(INVOICE) must never independently author a principal amount — ' +
          'it is always derived from Invoice.totalAmountMinor',
      );
    }
    return;
  }
  if (source.sourceType === 'OPENING') {
    if ('invoiceId' in source) {
      throw new RangeError('CustomerReceivable(OPENING) must never carry an invoiceId');
    }
    if (source.originalAmountMinor < 0n) {
      throw new RangeError(
        'CustomerReceivable(OPENING) requires a non-negative originalAmountMinor',
      );
    }
    if (!source.currencyCode) {
      throw new RangeError('CustomerReceivable(OPENING) requires a currencyCode');
    }
    if (!Number.isInteger(source.currencyExponent) || source.currencyExponent < 0) {
      throw new RangeError(
        'CustomerReceivable(OPENING) requires a non-negative integer currencyExponent',
      );
    }
    if (!source.branchId) {
      throw new RangeError(
        'CustomerReceivable(OPENING) requires a branchId — opening balances are branch-scoped, ' +
          'never ambiguous/null (3b.6 architecture-freeze)',
      );
    }
    return;
  }
  const exhaustive: never = source;
  throw new RangeError(`unrecognized CustomerReceivable sourceType: ${String(exhaustive)}`);
}
