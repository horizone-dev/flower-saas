'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PosInvoiceRow, PosOrderRow, PosOrderWithLines } from '@flower/api-client';
import { authed, describeError } from '@/lib/api';
import { buildReceipt, type ReceiptModel } from '@/lib/receipt';
import { ReceiptView } from './receipt-view';
import { useReadyContext, usePos } from './pos-context';

const MAX_PAGES = 40;

/**
 * SALES HISTORY — the branch's completed sales (orders in status CONFIRMED), newest first. The API lists orders in creation order, so the whole
 * list is read (bounded) and reversed here; very large histories need a server-side date filter (listed as a pilot item).
 */
export function SalesList() {
  const ctx = useReadyContext();
  const [rows, setRows] = useState<PosOrderRow[]>([]);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [todayOnly, setTodayOnly] = useState(true);
  const [truncated, setTruncated] = useState(false);

  const load = useCallback(async () => {
    setState('loading');
    setError(null);
    try {
      const all: PosOrderRow[] = [];
      let cursor: string | undefined;
      let more = false;
      for (let i = 0; i < MAX_PAGES; i++) {
        const page = await authed((a) =>
          a.listOrders(ctx.companyId, ctx.branchId, {
            status: 'CONFIRMED',
            ...(cursor ? { cursor } : {}),
          }),
        );
        all.push(...page.data);
        if (!page.nextCursor) {
          more = false;
          break;
        }
        cursor = page.nextCursor;
        more = true;
      }
      setRows(all.reverse());
      setTruncated(more);
      setState('ready');
    } catch (err) {
      const d = describeError(err);
      setError(`${d.code}: ${d.message}`);
      setState('error');
    }
  }, [ctx.companyId, ctx.branchId]);

  useEffect(() => {
    void load();
  }, [load]);

  const today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD in the device's local day
  const shown = useMemo(
    () =>
      todayOnly
        ? rows.filter((r) => new Date(r.createdAt).toLocaleDateString('en-CA') === today)
        : rows,
    [rows, todayOnly, today],
  );

  return (
    <div className="page">
      <div className="page__head">
        <h1>Sales</h1>
        <div className="row gap">
          <label className="row gap">
            <input
              type="checkbox"
              checked={todayOnly}
              onChange={(e) => setTodayOnly(e.target.checked)}
            />{' '}
            Today only
          </label>
          <button className="btn btn--touch" onClick={() => void load()}>
            ↻ Refresh
          </button>
        </div>
      </div>
      {state === 'loading' ? <p className="muted">Loading sales…</p> : null}
      {state === 'error' ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {truncated ? <p className="muted">Showing the most recent sales only.</p> : null}
      {state === 'ready' && shown.length === 0 ? (
        <p className="muted" data-testid="no-sales">
          No sales {todayOnly ? 'today' : 'yet'}.
        </p>
      ) : null}
      <ul className="saleslist" data-testid="sales-list">
        {shown.map((o) => (
          <li key={o.id}>
            <Link
              className="saleslist__row"
              href={`/sales/${o.id}`}
              data-testid={`sale-${o.orderNumber ?? o.id}`}
            >
              <strong>{o.orderNumber ?? o.id.slice(0, 8)}</strong>
              <span className="muted">{new Date(o.createdAt).toLocaleString()}</span>
              <span className="badge">{o.status}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** one sale: the receipt, reprintable (marked COPY). Read from the server — never from a local cache. */
export function SaleDetail({ orderId }: { orderId: string }) {
  const ctx = useReadyContext();
  const { seller } = usePos();
  const [model, setModel] = useState<ReceiptModel | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load(): Promise<void> {
      try {
        const full: PosOrderWithLines = await authed((a) =>
          a.getOrder(ctx.companyId, ctx.branchId, orderId),
        );
        const issued = full.issuedInvoice;
        if (!issued)
          throw new Error('This order has no issued invoice (it was not completed as a sale).');
        const inv: PosInvoiceRow = await authed((a) =>
          a.getInvoice(ctx.companyId, ctx.branchId, issued.invoiceId),
        );
        if (cancelled) return;
        setModel(
          buildReceipt({
            seller,
            branchName: ctx.branchName,
            orderNumber: full.order.orderNumber ?? full.order.id,
            invoice: {
              invoiceNumber: inv.invoiceNumber,
              invoiceDate: inv.invoiceDate.slice(0, 10),
              currencyCode: inv.currencyCode,
              currencyExponent: inv.currencyExponent,
              subtotalAmountMinor: inv.subtotalAmountMinor,
              documentDiscountAmountMinor: inv.documentDiscountAmountMinor,
              taxTotalAmountMinor: inv.taxTotalAmountMinor,
              totalAmountMinor: inv.totalAmountMinor,
              paymentStatus: inv.invoicePaymentStatus,
            },
            lines: full.lines,
            priceTaxMode: full.order.taxPriceMode ?? null,
            customerName: inv.customerDisplayNameSnapshot,
            payments: null, // the API has no payments read for a till yet
            copy: 'REPRINT',
          }),
        );
      } catch (err) {
        const d = describeError(err);
        if (!cancelled) setError(`${d.code}: ${d.message}`);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [ctx.companyId, ctx.branchId, ctx.branchName, orderId, seller]);

  return (
    <div className="page">
      <div className="page__head no-print">
        <h1>Sale</h1>
        <div className="row gap">
          <Link className="btn btn--touch" href="/sales">
            ← Sales
          </Link>
          {model ? (
            <button
              className="btn btn--touch btn--primary"
              onClick={() => window.print()}
              data-testid="reprint"
            >
              Reprint receipt
            </button>
          ) : null}
        </div>
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {!model && !error ? <p className="muted">Loading…</p> : null}
      {model ? <ReceiptView model={model} /> : null}
    </div>
  );
}
