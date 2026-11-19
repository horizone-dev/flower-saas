import { ApiError, errorMessage, serverApi } from '@/lib/api';
import { formatMinor } from '@/lib/catalog-forms';
import { guarded, ownerOrg, rethrowRedirect } from '@/lib/org';
import { civilToday, monthToDate, parseCivilPeriod, percentOfTotal } from '@/lib/reports';
import { Card, Empty, ErrorText, Field, PageHeader, Table } from '@/components/ui';
import type { SalesReport } from '@flower/api-client';

export const dynamic = 'force-dynamic';

/**
 * Sales report — INVOICED sales for a civil period, straight from the API's frozen Sales Financial Report. Read-only: nothing here computes a
 * tax or total. It is NOT stock and NOT profit (no cost of goods exists yet), and it does not show returns: see the note on the page.
 */
export default async function ReportsPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; branch?: string }>;
}) {
  const sp = await searchParams;
  const org = await ownerOrg('/reports');
  // a display default only (the shop's own calendar date); the period itself is chosen by the owner and decided by the server
  const today = civilToday(org.branches[0]?.timezone);
  const def = monthToDate(today);
  const period = parseCivilPeriod(sp.from ?? def.from, sp.to ?? def.to);
  const branchId = org.branches.some((b) => b.id === sp.branch) ? sp.branch : undefined;

  let report: SalesReport | null = null;
  let error: string | null = period.ok ? null : period.error;
  if (period.ok) {
    try {
      report = await guarded(
        () =>
          serverApi().getSalesReport(org.companyId, {
            from: period.from,
            to: period.to,
            ...(branchId ? { branchId } : {}),
          }),
        '/reports',
      );
    } catch (err) {
      rethrowRedirect(err);
      error =
        err instanceof ApiError && err.status === 403
          ? 'Your account is not allowed to read the sales report (it needs order, return and receivable view access, and all-branch access for the company-wide view).'
          : errorMessage(err);
    }
  }
  const ex = report?.currencyExponent ?? org.exponent;
  const cur = report?.currencyCode ?? org.currency;
  const money = (m: string): string => `${formatMinor(m, ex)} ${cur}`;
  const branchName = (id: string): string => org.branches.find((b) => b.id === id)?.name ?? id;

  return (
    <>
      <PageHeader title="Sales report" subtitle={`${org.companyName} · invoiced sales`} />
      <Card title="Period">
        <form method="get" className="row gap">
          <Field label="From" name="from" defaultValue={sp.from ?? def.from} />
          <Field label="To" name="to" defaultValue={sp.to ?? def.to} />
          <label className="field">
            <span>Branch</span>
            <select name="branch" defaultValue={branchId ?? ''}>
              <option value="">All branches</option>
              {org.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn--primary" type="submit" data-testid="run-report">
            Show report
          </button>
        </form>
        <p className="muted">
          Dates are civil dates in the company’s accounting time zone, e.g. 2026-11-01.
        </p>
      </Card>

      {error ? (
        <Card>
          <ErrorText message={error} />
        </Card>
      ) : null}

      {report ? (
        <>
          <Card title={`Invoiced sales · ${report.from} to ${report.to}`}>
            <dl className="totals" data-testid="sales-report">
              <div>
                <dt>Invoices</dt>
                <dd data-testid="rep-count">{report.invoices.invoiceCount}</dd>
              </div>
              <div>
                <dt>Subtotal</dt>
                <dd data-testid="rep-subtotal">{money(report.invoices.invoicedSubtotalMinor)}</dd>
              </div>
              <div>
                <dt>Line discounts</dt>
                <dd>{money(report.invoices.lineDiscountMinor)}</dd>
              </div>
              <div>
                <dt>Document discounts</dt>
                <dd>{money(report.invoices.documentDiscountMinor)}</dd>
              </div>
              <div>
                <dt>Sales excluding VAT</dt>
                <dd data-testid="rep-net">{money(report.invoices.salesNetExTaxMinor)}</dd>
              </div>
              <div>
                <dt>VAT collected</dt>
                <dd data-testid="rep-vat">{money(report.invoices.outputTaxMinor)}</dd>
              </div>
              <div className="totals__grand">
                <dt>Total invoiced</dt>
                <dd data-testid="rep-total">{money(report.invoices.invoicedTotalMinor)}</dd>
              </div>
            </dl>
            <p className="muted" data-testid="rep-reconciled">
              {report.reconciliation.reconciled
                ? 'Reconciled with the accounting ledger.'
                : 'NOT reconciled with the accounting ledger — do not rely on these figures; contact support.'}
            </p>
          </Card>

          {report.byBranch && report.byBranch.length > 0 ? (
            <Card title="By branch">
              <Table head={['Branch', 'Invoices', 'Total invoiced', 'Share']}>
                {report.byBranch.map((b) => (
                  <tr key={b.branchId}>
                    <td>{branchName(b.branchId)}</td>
                    <td>{b.invoices.invoiceCount}</td>
                    <td>{money(b.invoices.invoicedTotalMinor)}</td>
                    <td>
                      {percentOfTotal(
                        b.invoices.invoicedTotalMinor,
                        report.invoices.invoicedTotalMinor,
                      )}
                      %
                    </td>
                  </tr>
                ))}
              </Table>
            </Card>
          ) : null}

          <Card title="Invoices by current payment status">
            {report.currentPaymentStatusBreakdown.statuses.length === 0 ? (
              <Empty>No invoices in this period.</Empty>
            ) : (
              <Table head={['Status', 'Invoices', 'Total']}>
                {report.currentPaymentStatusBreakdown.statuses.map((s) => (
                  <tr key={s.status}>
                    <td>{s.status}</td>
                    <td>{s.count}</td>
                    <td>{money(s.invoiceTotalMinor)}</td>
                  </tr>
                ))}
              </Table>
            )}
            <p className="muted">{report.currentPaymentStatusBreakdown.note}</p>
          </Card>
        </>
      ) : null}

      <p className="muted" data-testid="rep-caveat">
        This is invoiced sales by accounting date. It is not stock, not cost of goods and not profit
        (no cost is recorded yet), and it does not show returns.
      </p>
    </>
  );
}
