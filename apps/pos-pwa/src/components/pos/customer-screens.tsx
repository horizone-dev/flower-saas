'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  PosCustomerAccountSummary,
  PosCustomerAdvanceRow,
  PosCustomerReceivableRow,
  PosCustomerRow,
  PosCustomerStatementLine,
  PosCustomerUnappliedReceiptRow,
} from '@flower/api-client';
import { authed, describeError } from '@/lib/api';
import {
  buildCollectionReceipt,
  newCollectAttempt,
  paymentLines,
  receivableStatus,
  signedMinor,
  statementLabel,
  type CollectionReceiptModel,
} from '@/lib/collection';
import {
  loadCollections,
  sessionKeyValueStore,
  type CollectionSnapshot,
} from '@/lib/collection-store';
import { customerQuery } from '@/lib/customer-search';
import { formatMinor } from '@/lib/money-display';
import { CollectDialog } from './collect-dialog';
import { CollectionReceiptView } from './collection-receipt-view';
import { usePos, useReadyContext } from './pos-context';

const PAGE = 100;

/** read a paged server list to the end, bounded; `truncated` says the bound was hit */
async function readAll<T>(
  page: (cursor: string | undefined) => Promise<{ data: T[]; nextCursor: string | null }>,
  maxPages: number,
): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < maxPages; i += 1) {
    const p = await page(cursor);
    rows.push(...p.data);
    if (!p.nextCursor) return { rows, truncated: false };
    cursor = p.nextCursor;
  }
  return { rows, truncated: true };
}

/** CUSTOMER LOOKUP — search by name, phone or e-mail; opening a customer shows their account at THIS branch. */
export function CustomerSearch() {
  const ctx = useReadyContext();
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<PosCustomerRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const t = setTimeout(async () => {
      setBusy(true);
      setError(null);
      try {
        const page = await authed((a) => a.listCustomers(ctx.companyId, customerQuery(q)));
        if (!cancelled) setRows(page.data);
      } catch (err) {
        const d = describeError(err);
        if (!cancelled) setError(`${d.code}: ${d.message}`);
      } finally {
        if (!cancelled) setBusy(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [q, ctx.companyId]);

  return (
    <div className="page">
      <div className="page__head">
        <h1>Customers</h1>
      </div>
      <label className="field">
        <span>Find a customer — name, phone or e-mail</span>
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          data-testid="cust-search"
          autoFocus
        />
      </label>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : null}
      {busy ? <p className="muted">Searching…</p> : null}
      <ul className="picklist" data-testid="cust-results">
        {rows.map((c) => (
          <li key={c.id}>
            <Link
              href={`/customers/${c.id}`}
              className="btn btn--touch"
              data-testid={`cust-row-${c.displayName}`}
            >
              <strong>{c.displayName}</strong>
              <span className="muted"> {c.phoneE164 ?? c.emailNormalized ?? ''}</span>
            </Link>
          </li>
        ))}
        {rows.length === 0 && !busy ? <li className="muted">No customers found.</li> : null}
      </ul>
    </div>
  );
}

interface AccountData {
  customer: PosCustomerRow;
  summary: PosCustomerAccountSummary;
  receivables: PosCustomerReceivableRow[];
  receivablesTruncated: boolean;
  advances: PosCustomerAdvanceRow[];
  unapplied: PosCustomerUnappliedReceiptRow[];
  statement: PosCustomerStatementLine[];
  statementTruncated: boolean;
  /** sections that could not be read (the rest still shows; nothing is invented) */
  notes: string[];
}

/** A CUSTOMER'S ACCOUNT at this branch: what they owe, invoice by invoice, the statement, advances — and, if permitted, collect a payment. */
export function CustomerAccount({ customerId }: { customerId: string }) {
  const ctx = useReadyContext();
  const { seller } = usePos();
  const [data, setData] = useState<AccountData | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [error, setError] = useState<string | null>(null);
  const [collecting, setCollecting] = useState(false);
  const [reprint, setReprint] = useState<CollectionReceiptModel | null>(null);
  const [saved, setSaved] = useState<CollectionSnapshot[]>([]);
  const attemptRef = useRef(newCollectAttempt());

  const load = useCallback(async () => {
    setState((s) => (s === 'ready' ? s : 'loading'));
    setError(null);
    const { companyId, branchId } = ctx;
    try {
      // the customer and the summary are required; the other sections degrade on their own
      const [customer, summary] = await Promise.all([
        authed((a) => a.getCustomer(companyId, customerId)),
        authed((a) => a.getCustomerAccountSummary(companyId, branchId, customerId)),
      ]);
      const notes: string[] = [];
      const section = async <T,>(name: string, f: () => Promise<T>, empty: T): Promise<T> => {
        try {
          return await f();
        } catch (err) {
          notes.push(`${name} could not be read (${describeError(err).code}).`);
          return empty;
        }
      };
      const [recv, adv, unapplied, stmt] = await Promise.all([
        section(
          'Open invoices',
          () =>
            readAll(
              (cursor) =>
                authed((a) =>
                  a.listCustomerReceivables(companyId, branchId, customerId, {
                    limit: PAGE,
                    ...(cursor ? { cursor } : {}),
                  }),
                ),
              20,
            ),
          { rows: [] as PosCustomerReceivableRow[], truncated: false },
        ),
        section(
          'Advances',
          () =>
            authed((a) => a.listCustomerAdvances(companyId, branchId, customerId, { limit: 50 })),
          { data: [] as PosCustomerAdvanceRow[], nextCursor: null },
        ),
        section(
          'Unapplied receipts',
          () =>
            authed((a) =>
              a.listCustomerUnappliedReceipts(companyId, branchId, customerId, { limit: 50 }),
            ),
          { data: [] as PosCustomerUnappliedReceiptRow[], nextCursor: null },
        ),
        section(
          'Statement',
          () =>
            readAll(
              (cursor) =>
                authed((a) =>
                  a.getCustomerStatement(companyId, branchId, customerId, {
                    limit: PAGE,
                    ...(cursor ? { cursor } : {}),
                  }),
                ),
              5,
            ),
          { rows: [] as PosCustomerStatementLine[], truncated: false },
        ),
      ]);
      setData({
        customer,
        summary,
        receivables: recv.rows,
        receivablesTruncated: recv.truncated,
        advances: adv.data,
        unapplied: unapplied.data,
        statement: stmt.rows,
        statementTruncated: stmt.truncated,
        notes,
      });
      setSaved(loadCollections(sessionKeyValueStore(), customerId));
      setState('ready');
    } catch (err) {
      const d = describeError(err);
      setError(
        d.status === 403 || d.status === 404
          ? 'You cannot open this customer’s account at this branch.'
          : `${d.code}: ${d.message}`,
      );
      setState('error');
    }
  }, [ctx, customerId]);

  useEffect(() => {
    void load();
  }, [load]);

  const exp = data?.summary.currencyExponent ?? 2;
  const fmt = (m: string | bigint): string => formatMinor(m, exp);
  const payments = useMemo(() => (data ? paymentLines(data.statement).reverse() : []), [data]);
  const statementNewestFirst = useMemo(() => (data ? [...data.statement].reverse() : []), [data]);

  if (state === 'loading') return <p className="muted content">Loading the customer’s account…</p>;
  if (state === 'error' || !data)
    return (
      <div className="page">
        <p className="error" role="alert" data-testid="acct-error">
          {error}
        </p>
        <Link href="/customers" className="btn btn--touch">
          Back to customers
        </Link>
      </div>
    );

  const s = data.summary;
  const outstanding = BigInt(s.branchFinancials.receivableOutstandingMinor);
  const advanceAvail = BigInt(s.branchFinancials.advanceAvailableMinor);
  const unappliedTotal = BigInt(s.branchFinancials.unappliedReceiptMinor);

  return (
    <>
      <div className="page no-print" data-testid="acct-page">
        <div className="page__head">
          <div>
            <h1 data-testid="acct-name">{data.customer.displayName}</h1>
            <span className="muted">
              {data.customer.phoneE164 ?? data.customer.emailNormalized ?? ''} · {ctx.branchName}
            </span>
          </div>
          <div className="row gap">
            <Link href="/customers" className="btn btn--touch">
              Customers
            </Link>
            {ctx.canCollect && outstanding > 0n ? (
              <button
                className="btn btn--touch btn--primary"
                onClick={() => setCollecting(true)}
                data-testid="acct-collect"
              >
                Collect payment
              </button>
            ) : null}
          </div>
        </div>

        {data.notes.map((n) => (
          <p key={n} className="muted" role="status">
            {n}
          </p>
        ))}

        <dl className="totals" data-testid="acct-tiles">
          <div className="totals__grand">
            <dt>Owes now {s.currencyCode}</dt>
            <dd data-testid="acct-owes">{fmt(outstanding)}</dd>
          </div>
          <div>
            <dt>Open invoices</dt>
            <dd data-testid="acct-open-count">{s.branchFinancials.openReceivableCount}</dd>
          </div>
          <div>
            <dt>Advances available</dt>
            <dd data-testid="acct-advances">{fmt(advanceAvail)}</dd>
          </div>
          {unappliedTotal > 0n ? (
            <div>
              <dt>Received, not applied</dt>
              <dd data-testid="acct-unapplied">{fmt(unappliedTotal)}</dd>
            </div>
          ) : null}
          <div>
            <dt>Credit</dt>
            <dd data-testid="acct-credit">
              {!s.credit.creditEnabled
                ? 'not enabled'
                : s.credit.availableCreditMinor === null
                  ? 'no limit set'
                  : `${fmt(s.credit.availableCreditMinor)} available of ${fmt(s.credit.creditLimitMinor ?? '0')}`}
            </dd>
          </div>
        </dl>
        <p className="muted">
          Balances are for this branch ({ctx.branchName}); the credit limit applies across the whole
          company.
        </p>

        <section aria-label="Open invoices">
          <h2>Open invoices</h2>
          {data.receivables.length === 0 ? (
            <p className="muted" data-testid="acct-no-invoices">
              No open invoices.
            </p>
          ) : (
            <table className="grid" data-testid="acct-invoices">
              <thead>
                <tr>
                  <th>Invoice</th>
                  <th>Date</th>
                  <th>Total</th>
                  <th>Paid</th>
                  <th>Owes</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {data.receivables.map((r) => (
                  <tr
                    key={r.customerReceivableId}
                    data-testid={`acct-inv-${r.invoiceNumber ?? r.customerReceivableId}`}
                  >
                    <td>
                      {r.invoiceNumber ??
                        (r.sourceType === 'OPENING' ? 'Opening balance' : 'Other charge')}
                    </td>
                    <td>{r.sourceDate}</td>
                    <td>{fmt(r.originalAmountMinor)}</td>
                    <td>
                      {fmt(r.paidByPaymentMinor)}
                      {BigInt(r.paidByAdvanceMinor) > 0n
                        ? ` + advance ${fmt(r.paidByAdvanceMinor)}`
                        : ''}
                    </td>
                    <td data-testid="acct-inv-owes">{fmt(r.outstandingMinor)}</td>
                    <td data-testid="acct-inv-status">{receivableStatus(r)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.receivablesTruncated ? (
            <p className="muted">Showing the first {data.receivables.length} open invoices.</p>
          ) : null}
        </section>

        <section aria-label="Payment history">
          <h2>Payments applied</h2>
          {payments.length === 0 ? (
            <p className="muted">No payments yet.</p>
          ) : (
            <ul className="plain" data-testid="acct-payments">
              {payments.map((l) => (
                <li key={l.customerAccountEntryId} className="row gap">
                  <span>{l.financialDate}</span>
                  <span>{statementLabel(l.entryKind)}</span>
                  <strong>{fmt(l.receivableEffectMinor.replace('-', ''))}</strong>
                </li>
              ))}
            </ul>
          )}
        </section>

        {data.advances.some((a) => BigInt(a.availableAmountMinor) > 0n) ? (
          <section aria-label="Advances">
            <h2>Advances</h2>
            <ul className="plain" data-testid="acct-advance-list">
              {data.advances
                .filter((a) => BigInt(a.availableAmountMinor) > 0n)
                .map((a) => (
                  <li key={a.customerAdvanceId} className="row gap">
                    <span>{a.createdAt.slice(0, 10)}</span>
                    <span>Available</span>
                    <strong>{fmt(a.availableAmountMinor)}</strong>
                  </li>
                ))}
            </ul>
            <p className="muted">
              Using an advance is done at the sale screen by a manager; it needs that permission.
            </p>
          </section>
        ) : null}

        {data.unapplied.length > 0 ? (
          <section aria-label="Unapplied receipts">
            <h2>Received, not applied to an invoice</h2>
            <ul className="plain" data-testid="acct-unapplied-list">
              {data.unapplied.map((u) => (
                <li key={u.paymentId} className="row gap">
                  <span>{u.createdAt.slice(0, 10)}</span>
                  <span>{u.method}</span>
                  <strong>{fmt(u.unappliedAmountMinor)}</strong>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {saved.length > 0 ? (
          <section aria-label="Receipts from this session">
            <h2>Receipts printed in this session</h2>
            <ul className="plain" data-testid="acct-reprints">
              {saved.map((c, i) => (
                <li key={c.result.paymentId} className="row gap">
                  <span>{c.result.paymentId.slice(0, 8)}</span>
                  <strong>
                    {formatMinor(c.result.amountMinor, c.result.currencyExponent)}{' '}
                    {c.result.currencyCode}
                  </strong>
                  <button
                    className="btn"
                    onClick={() =>
                      setReprint(
                        buildCollectionReceipt({
                          ...c,
                          seller,
                          branchName: ctx.branchName,
                          copy: 'COPY',
                        }),
                      )
                    }
                    data-testid={`reprint-${i}`}
                  >
                    Print again
                  </button>
                </li>
              ))}
            </ul>
            <p className="muted">
              Older receipts cannot be printed again here: the system keeps them in the statement
              below.
            </p>
          </section>
        ) : null}

        <section aria-label="Statement">
          <h2>Statement</h2>
          {statementNewestFirst.length === 0 ? (
            <p className="muted">Nothing on the statement yet.</p>
          ) : (
            <table className="grid" data-testid="acct-statement">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Entry</th>
                  <th>Invoices</th>
                  <th>Advances</th>
                  <th>Unapplied</th>
                </tr>
              </thead>
              <tbody>
                {statementNewestFirst.map((l) => (
                  <tr key={l.customerAccountEntryId}>
                    <td>{l.financialDate}</td>
                    <td>{statementLabel(l.entryKind)}</td>
                    <td>{signedMinor(l.receivableEffectMinor, exp)}</td>
                    <td>{signedMinor(l.advanceEffectMinor, exp)}</td>
                    <td>{signedMinor(l.unappliedReceiptEffectMinor, exp)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.statementTruncated ? (
            <p className="muted">Showing the first {data.statement.length} entries.</p>
          ) : null}
        </section>
      </div>

      {collecting ? (
        <CollectDialog
          companyId={ctx.companyId}
          branchId={ctx.branchId}
          branchName={ctx.branchName}
          seller={seller}
          customer={{ id: customerId, displayName: data.customer.displayName }}
          currencyCode={s.currencyCode}
          exponent={exp}
          outstandingMinor={outstanding}
          receivables={data.receivables}
          attemptRef={attemptRef}
          onCollected={() => void load()}
          onClose={() => setCollecting(false)}
        />
      ) : null}

      {reprint ? (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Payment receipt copy">
          <div className="modal__panel modal__panel--receipt">
            <CollectionReceiptView model={reprint} />
            <div className="row gap no-print">
              <button
                className="btn btn--touch btn--primary"
                onClick={() => window.print()}
                data-testid="reprint-print"
              >
                Print
              </button>
              <button
                className="btn btn--touch"
                onClick={() => setReprint(null)}
                data-testid="reprint-close"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}
