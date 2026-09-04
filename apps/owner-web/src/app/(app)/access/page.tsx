import { serverApi, errorMessage } from '@/lib/api';
import { PageHeader, Card, Badge, Empty } from '@/components/ui';

export const dynamic = 'force-dynamic';

function groupByDomain(keys: string[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const k of [...keys].sort()) {
    const domain = k.split(':')[0] ?? 'other';
    (out[domain] ??= []).push(k);
  }
  return out;
}

function scopeText(scope: 'ALL' | string[]): string {
  return scope === 'ALL' ? 'ALL' : scope.length ? scope.join(', ') : 'none';
}

export default async function MyAccessPage() {
  let me: Awaited<ReturnType<ReturnType<typeof serverApi>['me']>> | null = null;
  let access: Awaited<ReturnType<ReturnType<typeof serverApi>['meAccess']>> | null = null;
  let error: string | undefined;
  try {
    const api = serverApi();
    [me, access] = await Promise.all([api.me(), api.meAccess()]);
  } catch (err) {
    error = errorMessage(err);
  }

  if (error || !access) {
    return (
      <>
        <PageHeader title="My access" />
        <p className="error">{error ?? 'Could not load your access.'}</p>
      </>
    );
  }

  const groups = groupByDomain(access.permissions);

  return (
    <>
      <PageHeader
        title="My access"
        subtitle={`${access.accountType ?? ''}${me?.tenantId ? ` · tenant ${me.tenantId.slice(0, 8)}` : ''}`}
      />

      <Card title="Scope & plan">
        <p>
          Plan: <strong>{access.planKey ?? '—'}</strong>
        </p>
        <p>
          Company scope:{' '}
          <Badge tone={access.companyScope === 'ALL' ? 'good' : 'neutral'}>
            {scopeText(access.companyScope)}
          </Badge>
        </p>
        <p>
          Branch scope:{' '}
          <Badge tone={access.branchScope === 'ALL' ? 'good' : 'neutral'}>
            {scopeText(access.branchScope)}
          </Badge>
        </p>
        <p className="tag-list" style={{ marginTop: '0.5rem' }}>
          Entitled modules:{' '}
          {access.entitledModules.length ? (
            access.entitledModules.map((m) => <Badge key={m}>{m}</Badge>)
          ) : (
            <span className="muted">none</span>
          )}
        </p>
      </Card>

      <Card title="Effective permissions">
        {access.permissions.length === 0 ? (
          <Empty>No permissions.</Empty>
        ) : (
          Object.entries(groups).map(([domain, keys]) => (
            <div key={domain} style={{ marginBottom: '0.75rem' }}>
              <div
                className="muted"
                style={{ textTransform: 'uppercase', letterSpacing: '0.04em' }}
              >
                {domain}
              </div>
              <div className="tag-list">
                {keys.map((k) => (
                  <Badge key={k}>{k}</Badge>
                ))}
              </div>
            </div>
          ))
        )}
      </Card>

      {Object.keys(access.perBranchOverlay).length > 0 ? (
        <Card title="Per-branch overrides">
          {Object.entries(access.perBranchOverlay).map(([branchId, keys]) => (
            <div key={branchId} style={{ marginBottom: '0.5rem' }}>
              <code>{branchId.slice(0, 8)}</code>
              <div className="tag-list">
                {keys.map((k) => (
                  <Badge key={k}>{k}</Badge>
                ))}
              </div>
            </div>
          ))}
        </Card>
      ) : null}
    </>
  );
}
