import Link from 'next/link';
import { notFound } from 'next/navigation';
import { serverApi, errorMessage } from '@/lib/api';
import { getImpersonation } from '@/lib/impersonation';
import { PageHeader, Card, Table, Badge, Field, Select, Empty, statusTone } from '@/components/ui';
import { ActionForm } from '@/components/action-form';
import { tenantLifecycle } from '../actions';
import {
  overrideLimit,
  overrideEntitlement,
  toggleCatalogCapability,
  createProviderCredential,
  revokeProviderCredential,
  startImpersonation,
  stopImpersonation,
} from './actions';

export const dynamic = 'force-dynamic';

export default async function TenantDetail({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  const api = serverApi();

  let tenant: Awaited<ReturnType<typeof api.getTenant>>;
  try {
    tenant = await api.getTenant(tenantId);
  } catch {
    notFound();
  }

  let config: Awaited<ReturnType<typeof api.getTenantConfig>> | null = null;
  let creds: Awaited<ReturnType<typeof api.listProviderCredentials>> = [];
  let caps: Awaited<ReturnType<typeof api.getTenantCatalogCapabilities>> | null = null;
  let loadError: string | undefined;
  try {
    [config, creds] = await Promise.all([
      api.getTenantConfig(tenantId),
      api.listProviderCredentials(tenantId),
    ]);
  } catch (err) {
    loadError = errorMessage(err);
  }
  // separate — a capability-read failure (e.g. missing permission) must not hide
  // the entitlements / limits / credentials sections.
  try {
    caps = await api.getTenantCatalogCapabilities(tenantId);
  } catch {
    caps = null;
  }

  const impersonation = await getImpersonation();
  const impersonatingThis = impersonation?.tenantId === tenantId;

  return (
    <>
      <PageHeader
        title={tenant.name}
        subtitle={`${tenant.slug} · ${tenant.region}`}
        actions={
          <>
            <Badge tone={statusTone(tenant.status)}>{tenant.status}</Badge>
            <Link href={`/tenants/${tenantId}/access`} className="btn">
              Users & roles
            </Link>
            <Link href={`/tenants/${tenantId}/sessions`} className="btn">
              Sessions
            </Link>
          </>
        }
      />

      {impersonatingThis ? (
        <div className="banner row gap">
          <span>Impersonating this tenant (read-only, time-boxed).</span>
          <form action={stopImpersonation}>
            <input type="hidden" name="tenantId" value={tenantId} />
            <button className="btn" type="submit">
              Stop
            </button>
          </form>
        </div>
      ) : null}

      {loadError ? <p className="error">{loadError}</p> : null}

      <Card title="Lifecycle">
        <div className="row gap">
          {(['suspend', 'resume', 'terminate'] as const).map((action) => (
            <form action={tenantLifecycle} key={action}>
              <input type="hidden" name="tenantId" value={tenantId} />
              <input type="hidden" name="action" value={action} />
              <input type="hidden" name="reason" value={`${action} via super admin`} />
              <button
                className={`btn${action === 'terminate' ? ' btn--danger' : ''}`}
                type="submit"
              >
                {action}
              </button>
            </form>
          ))}
        </div>
        <p className="muted" style={{ marginTop: '0.5rem' }}>
          Companies {tenant.counts.companies} · Branches {tenant.counts.branches} · Users{' '}
          {tenant.counts.users} · POS {tenant.counts.posTerminals}
        </p>
      </Card>

      <Card title="Impersonation (OD7 — read-only)">
        {impersonatingThis ? (
          <Empty>An impersonation session is active — see the banner above.</Empty>
        ) : (
          <ActionForm
            action={startImpersonation}
            submitLabel="Start impersonation"
            pendingLabel="Starting…"
            hidden={{ tenantId }}
          >
            <Field
              label="Reason (audited)"
              name="reason"
              placeholder="Investigating support ticket #123"
              required
            />
          </ActionForm>
        )}
      </Card>

      {config ? (
        <>
          <Card title="Entitlements">
            <Table head={['Module', 'Enabled', '']}>
              {config.entitlements.map((e) => (
                <tr key={e.moduleKey}>
                  <td>
                    <code>{e.moduleKey}</code>
                  </td>
                  <td>
                    <Badge tone={e.enabled ? 'good' : 'neutral'}>{e.enabled ? 'on' : 'off'}</Badge>
                  </td>
                  <td>
                    <form action={overrideEntitlement} className="row gap">
                      <input type="hidden" name="tenantId" value={tenantId} />
                      <input type="hidden" name="moduleKey" value={e.moduleKey} />
                      <input type="hidden" name="enabled" value={e.enabled ? 'false' : 'true'} />
                      <button className="btn" type="submit">
                        {e.enabled ? 'Disable' : 'Enable'}
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </Table>
          </Card>

          <Card title="Limits">
            <Table head={['Key', 'Value', 'Override', 'Set']}>
              {config.limits.map((l) => (
                <tr key={l.limitKey}>
                  <td>
                    <code>{l.limitKey}</code>
                  </td>
                  <td>{l.value}</td>
                  <td>{l.isOverride ? <Badge tone="warn">override</Badge> : null}</td>
                  <td>
                    <form action={overrideLimit} className="row gap">
                      <input type="hidden" name="tenantId" value={tenantId} />
                      <input type="hidden" name="limitKey" value={l.limitKey} />
                      <input
                        name="value"
                        type="number"
                        defaultValue={l.value}
                        style={{ width: '5rem' }}
                      />
                      <input
                        name="reason"
                        placeholder="reason"
                        required
                        style={{ width: '10rem' }}
                      />
                      <button className="btn" type="submit">
                        Save
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        </>
      ) : null}

      {caps ? (
        <Card title="Catalog / Business Capabilities">
          <p className="muted" style={{ marginBottom: '0.5rem' }}>
            Business Type <code>{caps.businessTypeKey ?? '—'}</code>
            {caps.businessTypeAppliedVersion != null
              ? ` · applied template v${caps.businessTypeAppliedVersion}`
              : ''}{' '}
            · capability set v{caps.aggregateVersion}
          </p>
          <Table head={['Capability', 'State', 'Source', '']}>
            {caps.capabilities.map((c) => (
              <tr key={c.capabilityKey}>
                <td>
                  <code>{c.capabilityKey}</code>
                  {c.inert ? (
                    <div className="muted">
                      inert — requires <code>{c.requiredEntitlement}</code>
                    </div>
                  ) : null}
                </td>
                <td>
                  <Badge tone={c.enabled ? 'good' : 'neutral'}>{c.enabled ? 'on' : 'off'}</Badge>
                </td>
                <td>
                  {c.sourceKind ? (
                    <Badge tone={c.sourceKind === 'MANUAL' ? 'warn' : 'neutral'}>
                      {c.sourceKind.toLowerCase()}
                    </Badge>
                  ) : null}
                </td>
                <td>
                  <form action={toggleCatalogCapability} className="row gap">
                    <input type="hidden" name="tenantId" value={tenantId} />
                    <input type="hidden" name="capabilityKey" value={c.capabilityKey} />
                    <input type="hidden" name="enabled" value={c.enabled ? 'false' : 'true'} />
                    <input
                      type="hidden"
                      name="expectedVersion"
                      value={String(caps.aggregateVersion)}
                    />
                    <button className="btn" type="submit">
                      {c.enabled ? 'Disable' : 'Enable'}
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </Table>
        </Card>
      ) : null}

      <Card title="Provider credentials (secrets vault)">
        {creds.length === 0 ? (
          <Empty>No credentials stored.</Empty>
        ) : (
          <Table head={['Provider', 'Mode', 'Secret', 'Version', 'Status', '']}>
            {creds.map((c) => (
              <tr key={c.id}>
                <td>
                  <code>{c.provider}</code>
                </td>
                <td>{c.mode}</td>
                <td>
                  <code>{c.secretMask}</code>
                </td>
                <td>v{c.version}</td>
                <td>
                  <Badge tone={statusTone(c.status)}>{c.status}</Badge>
                </td>
                <td>
                  {c.status === 'ACTIVE' ? (
                    <form action={revokeProviderCredential}>
                      <input type="hidden" name="tenantId" value={tenantId} />
                      <input type="hidden" name="id" value={c.id} />
                      <button className="btn btn--danger" type="submit">
                        Revoke
                      </button>
                    </form>
                  ) : null}
                </td>
              </tr>
            ))}
          </Table>
        )}
        <div style={{ marginTop: '1rem' }}>
          <ActionForm
            action={createProviderCredential}
            submitLabel="Store credential"
            pendingLabel="Encrypting…"
            hidden={{ tenantId }}
          >
            <div className="grid-forms">
              <Field label="Provider" name="provider" placeholder="stripe" required />
              <Select
                label="Mode"
                name="mode"
                options={[
                  { value: 'TEST', label: 'TEST' },
                  { value: 'LIVE', label: 'LIVE' },
                ]}
              />
              <Field label="Secret (write-only)" name="secret" type="password" required />
            </div>
          </ActionForm>
        </div>
      </Card>
    </>
  );
}
