import type { ReceiptModel } from '@/lib/receipt';

/**
 * The printable receipt (80 mm thermal / A6 friendly). PRESENTATIONAL ONLY: it renders a {@link ReceiptModel} the server's figures were arranged
 * into — it computes nothing. `window.print()` prints just this element (see the `@media print` rules in pos.css).
 */
export function ReceiptView({ model }: { model: ReceiptModel }) {
  return (
    <article className="receipt" data-testid="receipt" aria-label="Receipt">
      <header className="receipt__head">
        {model.seller.name ? (
          <strong className="receipt__seller">{model.seller.name}</strong>
        ) : null}
        {model.branchName ? <div>{model.branchName}</div> : null}
        {model.seller.address ? <div>{model.seller.address}</div> : null}
        {model.seller.trn ? <div>TRN {model.seller.trn}</div> : null}
        <div className="receipt__title">
          {model.title}
          {model.copy === 'REPRINT' ? ' (COPY)' : ''}
        </div>
        {model.headerIncomplete ? (
          <div className="receipt__warn" role="alert" data-testid="receipt-incomplete">
            Seller VAT details are not available on this device — do not present this as a complete
            VAT invoice.
          </div>
        ) : null}
      </header>

      <dl className="receipt__meta">
        <div>
          <dt>Invoice</dt>
          <dd data-testid="receipt-invoice-number">{model.invoiceNumber}</dd>
        </div>
        <div>
          <dt>Order</dt>
          <dd data-testid="receipt-order-number">{model.orderNumber}</dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd>{model.invoiceDate}</dd>
        </div>
        {model.customerName ? (
          <div>
            <dt>Customer</dt>
            <dd>{model.customerName}</dd>
          </div>
        ) : null}
      </dl>

      <table className="receipt__lines">
        <thead>
          <tr>
            <th>Item</th>
            <th className="num">Qty</th>
            <th className="num">Price</th>
            <th className="num">
              {model.amountColumnMeaning === 'INCLUDING_VAT' ? 'Amount (incl. VAT)' : 'Amount'}
            </th>
          </tr>
        </thead>
        <tbody>
          {model.lines.map((l, i) => (
            <tr key={i}>
              <td>
                {l.description}
                {l.discount ? <div className="muted">discount −{l.discount}</div> : null}
                {l.vat !== null && l.vatRatePercent !== null ? (
                  <div className="muted">
                    VAT {l.vatRatePercent}% · {l.vat}
                  </div>
                ) : null}
              </td>
              <td className="num">
                {l.quantity} {l.uom}
              </td>
              <td className="num">{l.unitPrice}</td>
              <td className="num">{l.amount ?? ''}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <dl className="receipt__totals">
        <div>
          <dt>Subtotal</dt>
          <dd data-testid="receipt-subtotal">{model.subtotal}</dd>
        </div>
        {model.discount ? (
          <div>
            <dt>Discount</dt>
            <dd>−{model.discount}</dd>
          </div>
        ) : null}
        <div>
          <dt>VAT</dt>
          <dd data-testid="receipt-vat">{model.vatTotal}</dd>
        </div>
        <div className="receipt__grand">
          <dt>TOTAL {model.currency}</dt>
          <dd data-testid="receipt-total">{model.total}</dd>
        </div>
      </dl>

      {model.vatSummary.length > 0 ? (
        <p className="receipt__vatsum">
          VAT summary: {model.vatSummary.map((v) => `${v.ratePercent}% = ${v.vat}`).join(' · ')}
        </p>
      ) : null}

      <dl className="receipt__pay">
        {model.payments?.map((p, i) => (
          <div key={i}>
            <dt>{p.method}</dt>
            <dd>{p.amount}</dd>
          </div>
        ))}
        {model.advances?.map((a, i) => (
          <div key={`adv-${i}`}>
            <dt>Advance applied</dt>
            <dd data-testid="receipt-advance">{a.amount}</dd>
          </div>
        ))}
        {model.balanceDue ? (
          <div>
            <dt>Balance due (on account)</dt>
            <dd data-testid="receipt-balance-due">{model.balanceDue}</dd>
          </div>
        ) : null}
        <div>
          <dt>Payment status</dt>
          <dd data-testid="receipt-status">{model.paymentStatus}</dd>
        </div>
      </dl>
    </article>
  );
}
