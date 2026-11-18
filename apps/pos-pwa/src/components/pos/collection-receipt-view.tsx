import type { CollectionReceiptModel } from '@/lib/collection';

/**
 * The printable customer COLLECTION receipt (80 mm thermal / A6 friendly). PRESENTATIONAL ONLY: it renders a {@link CollectionReceiptModel} the SERVER's
 * figures were arranged into — it computes nothing. It is a receipt for money received on account (no VAT is calculated or printed: the VAT was on the
 * invoices). The reference is the server's payment id — the server issues no separate receipt number. `window.print()` prints just this element
 * (see the `@media print` rules in pos.css).
 */
export function CollectionReceiptView({ model }: { model: CollectionReceiptModel }) {
  return (
    <article
      className="receipt"
      data-testid="collect-receipt"
      data-payment-id={model.reference}
      aria-label="Payment receipt"
    >
      <header className="receipt__head">
        {model.seller.name ? (
          <strong className="receipt__seller">{model.seller.name}</strong>
        ) : null}
        {model.branchName ? <div>{model.branchName}</div> : null}
        {model.seller.address ? <div>{model.seller.address}</div> : null}
        {model.seller.trn ? <div>TRN {model.seller.trn}</div> : null}
        <div className="receipt__title" data-testid="collect-receipt-title">
          {model.title}
          {model.copy === 'COPY' ? ' (COPY)' : ''}
        </div>
      </header>

      <dl className="receipt__meta">
        <div>
          <dt>Reference</dt>
          <dd data-testid="collect-receipt-reference">{model.reference.slice(0, 8)}</dd>
        </div>
        {model.date ? (
          <div>
            <dt>Date</dt>
            <dd data-testid="collect-receipt-date">{model.date}</dd>
          </div>
        ) : null}
        <div>
          <dt>Customer</dt>
          <dd data-testid="collect-receipt-customer">{model.customerName}</dd>
        </div>
      </dl>

      <dl className="receipt__totals">
        <div className="receipt__grand">
          <dt>
            Received ({model.method}) {model.currency}
          </dt>
          <dd data-testid="collect-receipt-amount">{model.amount}</dd>
        </div>
      </dl>

      {model.allocations.length > 0 ? (
        <section data-testid="collect-receipt-allocations">
          <div className="receipt__sub">Applied to</div>
          <dl className="receipt__pay">
            {model.allocations.map((a, i) => (
              <div key={i}>
                <dt data-testid={`collect-receipt-alloc-ref-${i}`}>{a.reference}</dt>
                <dd data-testid={`collect-receipt-alloc-amount-${i}`}>{a.amount}</dd>
              </div>
            ))}
          </dl>
        </section>
      ) : null}

      <dl className="receipt__pay">
        {model.unallocated ? (
          <div>
            <dt>Not applied to an invoice</dt>
            <dd data-testid="collect-receipt-unallocated">{model.unallocated}</dd>
          </div>
        ) : null}
        {model.balanceAfter !== null ? (
          <div>
            <dt>Balance after</dt>
            <dd data-testid="collect-receipt-balance">{model.balanceAfter}</dd>
          </div>
        ) : null}
      </dl>
    </article>
  );
}
