import Link from 'next/link';
import { ApiError, errorMessage, serverApi } from '@/lib/api';
import { formatMinor } from '@/lib/catalog-forms';
import { RECEIVABLE_AGE_NOTE, owingCustomers } from '@/lib/customer-credit';
import { guarded, ownerOrg, rethrowRedirect } from '@/lib/org';
import { Badge, Card, Empty, ErrorText, PageHeader, Table } from '@/components/ui';
import type { ReceivablesReport } from '@flower/api-client';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Who owes us — the server's frozen CURRENT receivables report, for the whole company or one branch. Read-only: every figure (owed, paid, advance
 * used, reconciliation with the ledger) is the server's. The report is keyed by customer id, so the names are read from the customer route; there is
 * no due date or payment term anywhere in the contract, so nothing here is called "overdue".
 */
export default async function ReceivablesPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string; cursor?: string }>;
}) {
  const sp = await searchParams;
  const org = await ownerOrg('/receivables');
  const branchId = org.branches.some((b) => b.id === sp.branch) ? sp.branch : undefined;
  const cursor = sp.cursor && UUID.test(sp.cursor) ? sp.cursor : undefined;
  const api = serverApi();

  let report: ReceivablesReport | null = null;
  let error: string | null = null;
  try {
    report = await guarded(
      () =>
        api.getReceivablesReport(org.companyId, {
          limit: 50,
          ...(branchId ? { branchId } : {}),
          ...(cursor ? { cursor } : {}),
        }),
      '/receivables',
    );
  } catch (err) {
    rethrowRedirect(err);
    error =
      err instanceof ApiError && err.status === 403
        ? 'Your account is not allowed to read receivables here (it needs receivables access, and all-branch access for the company-wide view — pick a branch instead).'
        : err instanceof ApiError && err.code === 'REPORT_RESULT_TOO_LARGE'
          ? 'There are too many open receivables to report at once. Choose a single branch.'
          : errorMessage(err);
  }

  const ex = report?.currencyExponent ?? org.exponent;
  const cur = report?.currencyCode ?? org.currency;
  const money = (m: string): string => `${formatMinor(m, ex)} ${cur}`;
  const branchName = (id: string): string => org.branches.find((b) => b.id === id)?.name ?? id;

  // names for this page only — one read per customer on the page (a page is at most 50)
  const names = new Map<string, string>();
  const owing = report ? owingCustomers(report.customers.rows) : [];
  await Promise.all(
    owing.map(async (r) => {
      try {
        names.set(r.customerId, (await api.getCustomer(org.companyId, r.customerId)).displayName);
      } catch {
        /* the row still shows, by its id */
      }
    }),
  );

  const scope = branchId ? `branch: ${branchName(branchId)}` : 'all branches';

  return (
    <>
      <PageHeader title="Who owes us" subtitle={`${org.companyName} · ${scope}`} />
      <Card title="Scope">
        <form method="get" className="row gap">
          <label className="field">
            <span>Branch</span>
            <select name="branch" defaultValue={branchId ?? ''} data-testid="rec-branch">
              <option value="">All branches (company)</option>
              {org.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </label>
          <button className="btn btn--primary" type="submit" data-testid="rec-show">
            Show
          </button>
        </form>
      </Card>

      {error ? (
        <Card>
          <ErrorText message={error} />
        </Card>
      ) : null}

      {report ? (
        <>
          <Card title="Total owed">
            <dl className="totals" data-testid="rec-totals">
              <div className="totals__grand">
                <dt>Owed now</dt>
                <dd data-testid="rec-outstanding">{money(report.outstandingMinor)}</dd>
              </div>
              <div>
                <dt>Open receivables</dt>
                <dd data-testid="rec-count">{report.receivableCount}</dd>
              </div>
              <div>
                <dt>Invoiced on credit</dt>
                <dd>{money(report.originalMinor)}</dd>
              </div>
              <div>
                <dt>Paid by payments</dt>
                <dd>{money(report.paidByPaymentMinor)}</dd>
              </div>
              <div>
                <dt>Settled by advances</dt>
                <dd>{money(report.paidByAdvanceMinor)}</dd>
              </div>
            </dl>
            <p className="muted" data-testid="rec-reconciled">
              {report.reconciliation.reconciled
                ? 'Reconciled with the accounting ledger.'
                : 'NOT reconciled with the accounting ledger — do not rely on these figures; contact support.'}{' '}
              As of {report.asOf.slice(0, 16).replace('T', ' ')} UTC.
            </p>
          </Card>

          {report.byBranch && report.byBranch.length > 0 ? (
            <Card title="By branch">
              <Table head={['Branch', 'Open receivables', 'Owed now']}>
                {report.byBranch.map((b) => (
                  <tr key={b.branchId} data-testid="rec-branch-row">
                    <td>
                      <Link href={`/receivables?branch=${b.branchId}`}>
                        {branchName(b.branchId)}
                      </Link>
                    </td>
                    <td>{b.receivableCount}</td>
                    <td>{money(b.outstandingMinor)}</td>
                  </tr>
                ))}
              </Table>
            </Card>
          ) : null}

          <Card title="Customers who owe">
            {owing.length === 0 ? (
              <Empty>No customer on this page owes anything.</Empty>
            ) : (
              <Table
                head={['Customer', 'Open receivables', 'Invoiced', 'Paid', 'Advance used', 'Owes']}
              >
                {owing.map((r) => (
                  <tr key={r.customerId} data-testid="rec-customer-row">
                    <td>
                      <Link href={`/customers/${r.customerId}`} data-testid="rec-customer-link">
                        {names.get(r.customerId) ?? r.customerId}
                      </Link>
                    </td>
                    <td>{r.receivableCount}</td>
                    <td>{formatMinor(r.originalMinor, ex)}</td>
                    <td>{formatMinor(r.paidByPaymentMinor, ex)}</td>
                    <td>{formatMinor(r.paidByAdvanceMinor, ex)}</td>
                    <td>
                      <Badge tone="warn">{formatMinor(r.outstandingMinor, ex)}</Badge> {cur}
                    </td>
                  </tr>
                ))}
              </Table>
            )}
            {report.customers.nextCursor ? (
              <p>
                <Link
                  className="btn"
                  href={`/receivables?${branchId ? `branch=${branchId}&` : ''}cursor=${encodeURIComponent(report.customers.nextCursor)}`}
                  data-testid="rec-next"
                >
                  Next customers
                </Link>
              </p>
            ) : null}
            <p className="muted">
              Customers are listed in the order the system pages them, then arranged largest balance
              first within each page; customers with nothing owed are left out. The totals above
              cover the whole scope, not just this page.
            </p>
          </Card>
        </>
      ) : null}

      <p className="muted" data-testid="rec-caveat">
        {RECEIVABLE_AGE_NOTE} Collecting a payment is done at the till; open a customer to see their
        invoices, statement and payments.
      </p>
    </>
  );
}
