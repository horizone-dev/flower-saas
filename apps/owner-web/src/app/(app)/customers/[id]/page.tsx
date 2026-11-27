import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ApiError, errorMessage, serverApi } from '@/lib/api';
import { formatMinor } from '@/lib/catalog-forms';
import {
  RECEIVABLE_AGE_NOTE,
  creditStateLabel,
  creditUtilisation,
  isPaymentEntry,
  receivableAgeLabel,
  receivableStatus,
  statementLabel,
} from '@/lib/customer-credit';
import { guarded, ownerOrg } from '@/lib/org';
import { Badge, Card, Empty, ErrorText, PageHeader, Table } from '@/components/ui';
import { Flash } from '@/components/flash';
import { saveCustomerCreditAction } from '../actions';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Api = ReturnType<typeof serverApi>;
type Summary = Awaited<ReturnType<Api['getCustomerAccountSummary']>>;
type Receivables = Awaited<ReturnType<Api['listCustomerReceivables']>>;
type Advances = Awaited<ReturnType<Api['listCustomerAdvances']>>;
type Unapplied = Awaited<ReturnType<Api['listCustomerUnappliedReceipts']>>;
type Statement = Awaited<ReturnType<Api['getCustomerStatement']>>;

interface BranchAccount {
  id: string;
  name: string;
  summary: Summary | null;
  receivables: Receivables | null;
  advances: Advances | null;
  unapplied: Unapplied | null;
  error: string | null;
}

function branchError(err: unknown): string {
  return err instanceof ApiError && (err.status === 403 || err.status === 404)
    ? 'Your account cannot read this branch’s receivables (it needs receivables access for that branch).'
    : errorMessage(err);
}

/**
 * One customer: the credit settings (the real guarded PATCH, version-guarded and step-up gated) and the account behind them — every figure
 * below is read from the server's own account routes. Nothing here computes a balance, an exposure or an allocation.
 */
export default async function CustomerCreditPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string; branch?: string; cursor?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  if (!UUID.test(id)) notFound();
  const here = `/customers/${id}`;
  const org = await ownerOrg(here);
  const api = serverApi();

  const [customer, account, access] = await guarded(
    () =>
      Promise.all([
        api.getCustomer(org.companyId, id),
        api.getCustomerCreditAccount(org.companyId, id),
        api.meAccess(),
      ]),
    here,
  ).catch((err: unknown) => {
    if (err instanceof ApiError && err.status === 404) notFound();
    throw err;
  });
  const canManage = access.permissions.includes('customers:credit:manage');

  const branches: BranchAccount[] = await Promise.all(
    org.branches.map(async (b): Promise<BranchAccount> => {
      const [s, r, a, u] = await Promise.allSettled([
        api.getCustomerAccountSummary(org.companyId, b.id, id),
        api.listCustomerReceivables(org.companyId, b.id, id, { limit: 50 }),
        api.listCustomerAdvances(org.companyId, b.id, id, { limit: 50 }),
        api.listCustomerUnappliedReceipts(org.companyId, b.id, id, { limit: 50 }),
      ]);
      const failed = [s, r, a, u].find((x) => x.status === 'rejected');
      return {
        id: b.id,
        name: b.name,
        summary: s.status === 'fulfilled' ? s.value : null,
        receivables: r.status === 'fulfilled' ? r.value : null,
        advances: a.status === 'fulfilled' ? a.value : null,
        unapplied: u.status === 'fulfilled' ? u.value : null,
        error: failed && failed.status === 'rejected' ? branchError(failed.reason) : null,
      };
    }),
  );

  // the credit block is COMPANY-scoped on every branch's summary — the first branch that answered is enough
  const credit = branches.find((b) => b.summary)?.summary?.credit ?? null;
  const cur =
    account.creditLimitCurrencyCode ??
    branches.find((b) => b.summary)?.summary?.currencyCode ??
    org.currency;
  const ex =
    account.creditLimitCurrencyExponent ??
    branches.find((b) => b.summary)?.summary?.currencyExponent ??
    org.exponent;
  const money = (m: string | null): string => (m === null ? '—' : `${formatMinor(m, ex)} ${cur}`);

  const util = credit
    ? creditUtilisation({
        enabled: credit.creditEnabled,
        limitMinor: credit.creditLimitMinor,
        exposureMinor: credit.creditExposureMinor,
      })
    : null;

  // the statement is per branch: the chosen one, else the first branch that owes something, else the first
  const owing = branches.find(
    (b) => b.summary && b.summary.branchFinancials.receivableOutstandingMinor !== '0',
  );
  const chosen = branches.find((b) => b.id === sp.branch) ?? owing ?? branches[0];
  let statement: Statement | null = null;
  let statementError: string | null = null;
  if (chosen) {
    try {
      statement = await api.getCustomerStatement(org.companyId, chosen.id, id, {
        limit: 25,
        ...(sp.cursor ? { cursor: sp.cursor } : {}),
      });
    } catch (err) {
      statementError = branchError(err);
    }
  }

  return (
    <>
      <PageHeader
        title={customer.displayName}
        subtitle={`${org.companyName} · ${customer.phoneE164 ?? 'no phone'} · ${customer.emailNormalized ?? 'no email'}`}
        actions={
          <Link className="btn" href="/customers">
            All customers
          </Link>
        }
      />
      <Flash ok={sp.ok} error={sp.error} />

      <Card title="Credit">
        <p data-testid="credit-state">
          <Badge tone={account.creditEnabled ? 'good' : 'neutral'}>
            {creditStateLabel({
              enabled: account.creditEnabled,
              limitMinor: account.creditLimitMinor,
            })}
          </Badge>
        </p>
        <dl className="totals" data-testid="credit-figures">
          <div>
            <dt>Credit limit</dt>
            <dd data-testid="credit-limit">
              {account.creditLimitMinor === null ? 'No limit set' : money(account.creditLimitMinor)}
            </dd>
          </div>
          <div>
            <dt>Owes now (all branches)</dt>
            <dd data-testid="credit-exposure">
              {credit ? money(credit.creditExposureMinor) : 'unavailable'}
            </dd>
          </div>
          <div>
            <dt>Available credit</dt>
            <dd data-testid="credit-available">
              {credit
                ? !credit.creditEnabled
                  ? 'Credit is off'
                  : credit.availableCreditMinor === null
                    ? 'No ceiling'
                    : money(credit.availableCreditMinor)
                : 'unavailable'}
            </dd>
          </div>
          <div>
            <dt>Limit used</dt>
            <dd data-testid="credit-utilisation">
              {util === null
                ? 'unavailable'
                : util.percent === null
                  ? util.state === 'OFF'
                    ? 'Credit is off'
                    : 'No ceiling'
                  : `${util.percent}%${util.state === 'AT_OR_OVER' ? ' — at or over the limit' : ''}`}
            </dd>
          </div>
        </dl>
        {credit === null ? (
          <p className="muted">
            The balance and available credit come from the receivables routes, which your account
            cannot read here (it needs receivables access).
          </p>
        ) : null}

        <form action={saveCustomerCreditAction} className="stack" data-testid="credit-form">
          <input type="hidden" name="customerId" value={id} />
          <input type="hidden" name="version" value={account.version} />
          <label className="row gap">
            <input
              type="checkbox"
              name="creditEnabled"
              defaultChecked={account.creditEnabled}
              disabled={!canManage}
              data-testid="credit-enabled"
            />
            <span>Allow this customer to buy on credit</span>
          </label>
          <label className="field">
            <span>Credit limit ({cur})</span>
            <input
              name="creditLimit"
              inputMode="decimal"
              placeholder={
                account.creditLimitMinor === null
                  ? 'blank = no limit'
                  : `now ${formatMinor(account.creditLimitMinor, ex)} — blank keeps it`
              }
              disabled={!canManage}
              data-testid="credit-limit-input"
            />
          </label>
          <p className="muted">
            A new limit replaces the current one; a limit cannot be removed once set. Leave it blank
            to keep the current setting (or no limit). Saving needs a fresh code from your
            authenticator app.
          </p>
          {canManage ? (
            <div className="row gap">
              <button className="btn btn--primary" type="submit" data-testid="credit-save">
                Save credit settings
              </button>
            </div>
          ) : (
            <p className="error" data-testid="credit-no-permission">
              Your account can view this customer but does not have permission to change credit
              settings.
            </p>
          )}
        </form>
      </Card>

      <Card title="Balance by branch">
        {branches.length === 0 ? (
          <Empty>This company has no branches.</Empty>
        ) : (
          <Table
            head={['Branch', 'Owes', 'Open invoices', 'Advances available', 'Unapplied receipts']}
          >
            {branches.map((b) => {
              const c = b.summary?.currencyCode ?? cur;
              const e = b.summary?.currencyExponent ?? ex;
              const f = b.summary?.branchFinancials;
              return (
                <tr key={b.id} data-testid="branch-row">
                  <td>{b.name}</td>
                  {f ? (
                    <>
                      <td data-testid="branch-owes">{`${formatMinor(f.receivableOutstandingMinor, e)} ${c}`}</td>
                      <td>{f.openReceivableCount}</td>
                      <td>{`${formatMinor(f.advanceAvailableMinor, e)} ${c}`}</td>
                      <td>{`${formatMinor(f.unappliedReceiptMinor, e)} ${c}`}</td>
                    </>
                  ) : (
                    <td colSpan={4}>
                      <ErrorText message={b.error ?? 'Not available'} />
                    </td>
                  )}
                </tr>
              );
            })}
          </Table>
        )}
      </Card>

      <Card title="Open invoices">
        {branches.every((b) => !b.receivables || b.receivables.data.length === 0) ? (
          <Empty>No open or part-paid invoices.</Empty>
        ) : (
          <Table
            head={[
              'Branch',
              'Invoice',
              'Date',
              'Age',
              'Original',
              'Paid',
              'Advance used',
              'Owes',
              'Status',
            ]}
          >
            {branches.flatMap((b) =>
              (b.receivables?.data ?? []).map((r) => (
                <tr key={r.customerReceivableId} data-testid="open-invoice-row">
                  <td>{b.name}</td>
                  <td>{r.invoiceNumber ?? (r.openingNote ? 'Opening balance' : 'On account')}</td>
                  <td>{r.sourceDate}</td>
                  <td>{receivableAgeLabel(r.ageDays)}</td>
                  <td>{formatMinor(r.originalAmountMinor, r.currencyExponent)}</td>
                  <td>{formatMinor(r.paidByPaymentMinor, r.currencyExponent)}</td>
                  <td>{formatMinor(r.paidByAdvanceMinor, r.currencyExponent)}</td>
                  <td>
                    <strong>{formatMinor(r.outstandingMinor, r.currencyExponent)}</strong>{' '}
                    {r.currencyCode}
                  </td>
                  <td>
                    <Badge tone={receivableStatus(r) === 'UNPAID' ? 'bad' : 'warn'}>
                      {receivableStatus(r)}
                    </Badge>
                  </td>
                </tr>
              )),
            )}
          </Table>
        )}
        {branches.some((b) => b.receivables?.nextCursor) ? (
          <p className="muted">
            More open invoices exist at a branch than are listed here (the first 50 per branch).
          </p>
        ) : null}
        <p className="muted" data-testid="age-note">
          {RECEIVABLE_AGE_NOTE}
        </p>
      </Card>

      <Card title="Advances and unapplied receipts">
        {branches.every(
          (b) => (b.advances?.data.length ?? 0) === 0 && (b.unapplied?.data.length ?? 0) === 0,
        ) ? (
          <Empty>No advances or unapplied receipts.</Empty>
        ) : (
          <Table head={['Branch', 'Kind', 'Received', 'Used', 'Available now']}>
            {branches.flatMap((b) => [
              ...(b.advances?.data ?? []).map((a) => (
                <tr key={a.customerAdvanceId} data-testid="advance-row">
                  <td>{b.name}</td>
                  <td>Advance</td>
                  <td>{formatMinor(a.originalAmountMinor, a.currencyExponent)}</td>
                  <td>{formatMinor(a.appliedAmountMinor, a.currencyExponent)}</td>
                  <td>{`${formatMinor(a.availableAmountMinor, a.currencyExponent)} ${a.currencyCode}`}</td>
                </tr>
              )),
              ...(b.unapplied?.data ?? []).map((u) => (
                <tr key={u.paymentId} data-testid="unapplied-row">
                  <td>{b.name}</td>
                  <td>Unapplied receipt ({u.method.toLowerCase().replace(/_/g, ' ')})</td>
                  <td>{formatMinor(u.originalAmountMinor, u.currencyExponent)}</td>
                  <td>{formatMinor(u.consumedAmountMinor, u.currencyExponent)}</td>
                  <td>{`${formatMinor(u.unappliedAmountMinor, u.currencyExponent)} ${u.currencyCode}`}</td>
                </tr>
              )),
            ])}
          </Table>
        )}
      </Card>

      <Card title={`Statement and payment history${chosen ? ` · ${chosen.name}` : ''}`}>
        {branches.length > 1 ? (
          <form method="get" className="row gap" style={{ marginBottom: '0.75rem' }}>
            <label className="field">
              <span>Branch</span>
              <select name="branch" defaultValue={chosen?.id}>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </label>
            <button className="btn" type="submit">
              Show
            </button>
          </form>
        ) : null}
        {statementError ? <ErrorText message={statementError} /> : null}
        {statement ? (
          statement.data.length === 0 ? (
            <Empty>No account activity at this branch.</Empty>
          ) : (
            <Table head={['Date', 'Entry', 'Receivable', 'Advance', 'Unapplied']}>
              {statement.data.map((l) => (
                <tr key={l.customerAccountEntryId} data-testid="statement-row">
                  <td>{l.financialDate}</td>
                  <td>
                    {statementLabel(l.entryKind)}
                    {isPaymentEntry(l.entryKind) ? ' ✓' : ''}
                  </td>
                  <td>{formatMinor(l.receivableEffectMinor, ex)}</td>
                  <td>{formatMinor(l.advanceEffectMinor, ex)}</td>
                  <td>{formatMinor(l.unappliedReceiptEffectMinor, ex)}</td>
                </tr>
              ))}
            </Table>
          )
        ) : null}
        {statement?.nextCursor && chosen ? (
          <p>
            <Link
              className="btn"
              href={`${here}?branch=${chosen.id}&cursor=${encodeURIComponent(statement.nextCursor)}`}
            >
              Older entries
            </Link>
          </p>
        ) : null}
        <p className="muted">
          Receivable effects are what the customer owes (positive = more owed); a ✓ marks money
          received and applied to an invoice. Collecting a payment is done at the till.
        </p>
      </Card>
    </>
  );
}
