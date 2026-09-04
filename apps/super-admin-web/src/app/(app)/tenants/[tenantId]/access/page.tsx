import Link from 'next/link';
import { serverApi, errorMessage } from '@/lib/api';
import { PageHeader, Card, Table, Badge, Field, Empty } from '@/components/ui';
import { ActionForm } from '@/components/action-form';
import { createRole, assignRoles, setScope } from './actions';

export const dynamic = 'force-dynamic';

const PHASE1_KEYS = [
  'users:view',
  'users:manage',
  'roles:manage',
  'audit:view',
  'settings:branch:manage',
  'settings:tenant:manage',
];

export default async function AccessPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ user?: string }>;
}) {
  const { tenantId } = await params;
  const { user: selectedUserId } = await searchParams;
  const api = serverApi();

  let roles: Awaited<ReturnType<typeof api.listTenantRoles>> = [];
  let users: Awaited<ReturnType<typeof api.listTenantUsers>> = [];
  let error: string | undefined;
  try {
    [roles, users] = await Promise.all([
      api.listTenantRoles(tenantId),
      api.listTenantUsers(tenantId),
    ]);
  } catch (err) {
    error = errorMessage(err);
  }

  const selected = selectedUserId ? users.find((u) => u.id === selectedUserId) : undefined;
  let resolved: Awaited<ReturnType<typeof api.getTenantUser>> | null = null;
  let preview: Awaited<ReturnType<typeof api.previewTenantUserAccess>> | null = null;
  if (selected) {
    try {
      resolved = await api.getTenantUser(tenantId, selected.id);
      // preview: what a DENY on users:view would do — demonstrates the read-only diff
      preview = await api.previewTenantUserAccess(tenantId, selected.id, {
        grants: [{ permissionKey: 'audit:view', effect: 'DENY' }],
      });
    } catch (err) {
      error = errorMessage(err);
    }
  }

  const roleIdByKey = new Map(roles.map((r) => [r.key, r.id]));
  const selectedRoleIds = new Set(selected?.roleKeys.map((k) => roleIdByKey.get(k)));

  return (
    <>
      <PageHeader
        title="Users & roles"
        subtitle={tenantId}
        actions={
          <Link href={`/tenants/${tenantId}`} className="btn">
            ← Tenant
          </Link>
        }
      />
      {error ? <p className="error">{error}</p> : null}

      <Card title="Roles">
        <Table head={['Key', 'Name', 'Type', 'Permissions']}>
          {roles.map((r) => (
            <tr key={r.id}>
              <td>
                <code>{r.key}</code>
              </td>
              <td>{r.name}</td>
              <td>
                <Badge tone={r.isSystem ? 'neutral' : 'good'}>
                  {r.isSystem ? 'system' : 'custom'}
                </Badge>
              </td>
              <td className="tag-list">
                {r.permissionKeys.map((k) => (
                  <Badge key={k}>{k}</Badge>
                ))}
              </td>
            </tr>
          ))}
        </Table>
        <div style={{ marginTop: '1rem' }}>
          <ActionForm action={createRole} submitLabel="Create role" hidden={{ tenantId }}>
            <div className="grid-forms">
              <Field label="Key" name="key" placeholder="ops_lead" required />
              <Field label="Name" name="name" placeholder="Operations Lead" required />
            </div>
            <div className="tag-list">
              {PHASE1_KEYS.map((k) => (
                <label key={k} className="row gap" style={{ fontSize: '0.82rem' }}>
                  <input type="checkbox" name={`perm:${k}`} /> {k}
                </label>
              ))}
            </div>
          </ActionForm>
        </div>
      </Card>

      <Card title="Users">
        {users.length === 0 ? (
          <Empty>No users.</Empty>
        ) : (
          <Table head={['Email', 'Type', 'Roles', '']}>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.email}</td>
                <td>{u.accountType}</td>
                <td className="tag-list">
                  {u.roleKeys.map((k) => (
                    <Badge key={k}>{k}</Badge>
                  ))}
                </td>
                <td>
                  <Link href={`/tenants/${tenantId}/access?user=${u.id}`}>manage</Link>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>

      {selected && resolved ? (
        <Card title={`Access — ${selected.email}`}>
          <p className="muted">
            {resolved.accountType} · permissions: {resolved.permissions.join(', ') || '—'} · branch
            scope:{' '}
            {Array.isArray(resolved.branchScope) ? resolved.branchScope.join(', ') || '—' : 'ALL'}
          </p>

          <ActionForm
            action={assignRoles}
            submitLabel="Save roles"
            hidden={{ tenantId, userId: selected.id }}
          >
            <div className="tag-list">
              {roles.map((r) => (
                <label key={r.id} className="row gap" style={{ fontSize: '0.82rem' }}>
                  <input
                    type="checkbox"
                    name="roleId"
                    value={r.id}
                    defaultChecked={selectedRoleIds.has(r.id)}
                  />{' '}
                  {r.key}
                </label>
              ))}
            </div>
          </ActionForm>

          <div style={{ marginTop: '1rem' }}>
            <ActionForm
              action={setScope}
              submitLabel="Save scope"
              hidden={{ tenantId, userId: selected.id }}
            >
              <label className="row gap" style={{ fontSize: '0.82rem' }}>
                <input
                  type="checkbox"
                  name="branchScopeAll"
                  defaultChecked={resolved.branchScope === 'ALL'}
                />{' '}
                all branches
              </label>
              <Field label="Branch ids (space/comma separated)" name="branchIds" />
            </ActionForm>
          </div>

          {preview ? (
            <p className="muted" style={{ marginTop: '1rem' }}>
              Preview (DENY audit:view) → removes:{' '}
              {preview.diff.permissionsRemoved.join(', ') || '—'}
            </p>
          ) : null}
        </Card>
      ) : null}
    </>
  );
}
