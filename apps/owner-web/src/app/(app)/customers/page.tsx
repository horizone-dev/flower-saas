import { serverApi } from '@/lib/api';
import { guarded, ownerOrg } from '@/lib/org';
import { Card, Empty, Field, PageHeader, Table } from '@/components/ui';
import { Flash } from '@/components/flash';
import { createCustomerAction } from '../catalog-actions';

export const dynamic = 'force-dynamic';

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const org = await ownerOrg('/customers');
  const page = await guarded(() =>
    serverApi().listCustomers(org.companyId, sp.q ? { displayName: sp.q } : undefined),
  );
  return (
    <>
      <PageHeader title="Customers" subtitle={org.companyName} />
      <Flash ok={sp.ok} error={sp.error} />
      <Card title="Add a customer">
        <form action={createCustomerAction} className="grid-forms">
          <Field label="Name" name="displayName" required />
          <Field label="Phone" name="phone" placeholder="+971500000000" />
          <Field label="Email" name="email" type="email" />
          <button className="btn btn--primary" type="submit">
            Add customer
          </button>
        </form>
      </Card>
      <Card title="Customers">
        <form method="get" className="row gap" style={{ marginBottom: '0.75rem' }}>
          <Field label="Search by name" name="q" defaultValue={sp.q ?? ''} />
          <button className="btn" type="submit">
            Search
          </button>
        </form>
        {page.data.length === 0 ? (
          <Empty>No customers.</Empty>
        ) : (
          <Table head={['Name', 'Phone', 'Email']}>
            {page.data.map((c) => (
              <tr key={c.id}>
                <td>
                  <a href={`/customers/${c.id}`} data-testid="customer-link">
                    {c.displayName}
                  </a>
                </td>
                <td>{c.phoneE164 ?? '—'}</td>
                <td>{c.emailNormalized ?? '—'}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
      <p className="muted">
        Staff accounts are managed by the platform operator for now — the API has no tenant-side
        staff routes yet.
      </p>
    </>
  );
}
