import Link from 'next/link';
import { revalidatePath } from 'next/cache';
import { serverApi, errorMessage } from '@/lib/api';
import { PageHeader, Card, Table, Badge, Empty } from '@/components/ui';

export const dynamic = 'force-dynamic';

async function revoke(formData: FormData): Promise<void> {
  'use server';
  const tenantId = String(formData.get('tenantId'));
  await serverApi().revokeTenantSession(tenantId, String(formData.get('sessionId')));
  revalidatePath(`/tenants/${tenantId}/sessions`);
}

export default async function SessionsPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;
  let sessions: Awaited<ReturnType<ReturnType<typeof serverApi>['listTenantSessions']>> = [];
  let error: string | undefined;
  try {
    sessions = await serverApi().listTenantSessions(tenantId);
  } catch (err) {
    error = errorMessage(err);
  }

  return (
    <>
      <PageHeader
        title="Sessions"
        subtitle={`${sessions.length} live`}
        actions={
          <Link href={`/tenants/${tenantId}`} className="btn">
            ← Tenant
          </Link>
        }
      />
      {error ? <p className="error">{error}</p> : null}
      <Card>
        {sessions.length === 0 ? (
          <Empty>No live sessions.</Empty>
        ) : (
          <Table head={['Session', 'User', 'MFA', 'Expires', '']}>
            {sessions.map((s) => (
              <tr key={s.sessionId}>
                <td>
                  <code>{s.sessionId.slice(0, 8)}</code>
                  {s.impersonated ? <Badge tone="warn">impersonated</Badge> : null}
                </td>
                <td>
                  <code>{s.userId?.slice(0, 8) ?? '—'}</code>
                </td>
                <td>{s.mfaLevel}</td>
                <td className="muted">{new Date(s.expiresAt).toLocaleString()}</td>
                <td>
                  <form action={revoke}>
                    <input type="hidden" name="tenantId" value={tenantId} />
                    <input type="hidden" name="sessionId" value={s.sessionId} />
                    <button className="btn btn--danger" type="submit">
                      Revoke
                    </button>
                  </form>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
