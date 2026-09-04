import Link from 'next/link';
import { serverApi, errorMessage } from '@/lib/api';
import { PageHeader, Card, Table, Badge, Field, Select, Empty, statusTone } from '@/components/ui';
import { ProvisionForm } from './provision-form';

export const dynamic = 'force-dynamic';

export default async function TenantsPage() {
  const api = serverApi();
  let tenants: Awaited<ReturnType<typeof api.listTenants>> = [];
  let plans: Awaited<ReturnType<typeof api.listPlans>> = [];
  let error: string | undefined;
  try {
    [tenants, plans] = await Promise.all([api.listTenants(), api.listPlans()]);
  } catch (err) {
    error = errorMessage(err);
  }

  const versionOptions = plans.flatMap((p) =>
    p.versions
      .filter((v) => v.status === 'PUBLISHED')
      .map((v) => ({ value: v.id, label: `${p.name} v${v.version}` })),
  );

  return (
    <>
      <PageHeader title="Tenants" subtitle={`${tenants.length} workspace(s)`} />
      {error ? <p className="error">{error}</p> : null}

      <Card title="Provision a tenant">
        {versionOptions.length === 0 ? (
          <Empty>No published plan version — create one under Plans first.</Empty>
        ) : (
          <ProvisionForm versionOptions={versionOptions}>
            <Field label="Workspace slug" name="slug" placeholder="acme-florist" required />
            <Field label="Name" name="name" placeholder="Acme Florist FZE" required />
            <Field label="Owner email" name="ownerEmail" type="email" required />
            <Select
              label="Region"
              name="region"
              options={[
                { value: 'AE', label: 'UAE' },
                { value: 'SA', label: 'KSA' },
                { value: 'QA', label: 'Qatar' },
                { value: 'KW', label: 'Kuwait' },
                { value: 'BH', label: 'Bahrain' },
                { value: 'OM', label: 'Oman' },
              ]}
            />
            <Select label="Plan version" name="planVersionId" options={versionOptions} />
          </ProvisionForm>
        )}
      </Card>

      <Card>
        {tenants.length === 0 ? (
          <Empty>No tenants yet.</Empty>
        ) : (
          <Table head={['Workspace', 'Region', 'Status', 'Created']}>
            {tenants.map((t) => (
              <tr key={t.id}>
                <td>
                  <Link href={`/tenants/${t.id}`}>{t.name}</Link>
                  <div className="muted">{t.slug}</div>
                </td>
                <td>{t.region}</td>
                <td>
                  <Badge tone={statusTone(t.status)}>{t.status}</Badge>
                </td>
                <td className="muted">{new Date(t.createdAt).toLocaleDateString()}</td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
