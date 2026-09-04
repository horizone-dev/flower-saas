import { serverApi, errorMessage } from '@/lib/api';
import { PageHeader, Card, Table, Badge, Empty } from '@/components/ui';

export const dynamic = 'force-dynamic';

export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ tenantId?: string; action?: string; actorId?: string; before?: string }>;
}) {
  const sp = await searchParams;
  let page: Awaited<ReturnType<ReturnType<typeof serverApi>['queryAudit']>> = {
    rows: [],
    nextBefore: null,
  };
  let error: string | undefined;
  try {
    page = await serverApi().queryAudit({
      ...(sp.tenantId ? { tenantId: sp.tenantId } : {}),
      ...(sp.action ? { action: sp.action } : {}),
      ...(sp.actorId ? { actorId: sp.actorId } : {}),
      ...(sp.before ? { before: sp.before } : {}),
      limit: 50,
    });
  } catch (err) {
    error = errorMessage(err);
  }

  const qp = (extra: Record<string, string>) =>
    '?' + new URLSearchParams({ ...sp, ...extra }).toString();

  return (
    <>
      <PageHeader title="Audit" subtitle="platform + tenant events" />
      {error ? <p className="error">{error}</p> : null}

      <Card>
        <form method="get" className="grid-forms">
          <label className="field">
            <span>Tenant id</span>
            <input name="tenantId" defaultValue={sp.tenantId ?? ''} />
          </label>
          <label className="field">
            <span>Action prefix</span>
            <input name="action" defaultValue={sp.action ?? ''} placeholder="tenant." />
          </label>
          <label className="field">
            <span>Actor id</span>
            <input name="actorId" defaultValue={sp.actorId ?? ''} />
          </label>
          <button className="btn" type="submit">
            Filter
          </button>
        </form>
      </Card>

      <Card>
        {page.rows.length === 0 ? (
          <Empty>No matching events.</Empty>
        ) : (
          <Table head={['When', 'Action', 'Resource', 'Actor', 'Tenant']}>
            {page.rows.map((r) => (
              <tr key={r.id}>
                <td className="muted">{new Date(r.at).toLocaleString()}</td>
                <td>
                  <code>{r.action}</code>
                  {r.impersonatorPlatformUserId ? <Badge tone="warn">impersonated</Badge> : null}
                </td>
                <td className="muted">
                  {r.resourceType}
                  {r.resourceId ? ` ${r.resourceId.slice(0, 8)}` : ''}
                </td>
                <td>
                  <Badge>{r.actorAccountType}</Badge>{' '}
                  <code>
                    {(r.actorPlatformUserId ?? r.actorUserId ?? '').slice(0, 8) || 'system'}
                  </code>
                </td>
                <td>
                  <code>{r.tenantId?.slice(0, 8) ?? '—'}</code>
                </td>
              </tr>
            ))}
          </Table>
        )}
        {page.nextBefore ? (
          <a
            className="btn"
            href={qp({ before: page.nextBefore })}
            style={{ marginTop: '0.75rem' }}
          >
            Older →
          </a>
        ) : null}
      </Card>
    </>
  );
}
