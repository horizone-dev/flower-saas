import { serverApi, errorMessage } from '@/lib/api';
import { PageHeader, Card, Table, Badge, Field, Empty } from '@/components/ui';
import { ActionForm } from '@/components/action-form';
import { createPlan, setLimit } from './actions';

export const dynamic = 'force-dynamic';

export default async function PlansPage() {
  let plans: Awaited<ReturnType<ReturnType<typeof serverApi>['listPlans']>> = [];
  let error: string | undefined;
  try {
    plans = await serverApi().listPlans();
  } catch (err) {
    error = errorMessage(err);
  }

  return (
    <>
      <PageHeader title="Plans" subtitle={`${plans.length} plan(s)`} />
      {error ? <p className="error">{error}</p> : null}

      <Card title="New plan">
        <ActionForm action={createPlan} submitLabel="Create + publish v1" pendingLabel="Creating…">
          <div className="grid-forms">
            <Field label="Key" name="key" placeholder="starter" required />
            <Field label="Name" name="name" placeholder="Starter" required />
          </div>
          <p className="muted">Seeds a published v1 with baseline Starter limits.</p>
        </ActionForm>
      </Card>

      {plans.length === 0 ? (
        <Empty>No plans.</Empty>
      ) : (
        plans.map((p) => (
          <Card key={p.id} title={`${p.name} (${p.key})`}>
            <Table head={['Version', 'Status', 'Adjust a limit']}>
              {p.versions.map((v) => (
                <tr key={v.id}>
                  <td>v{v.version}</td>
                  <td>
                    <Badge tone={v.status === 'PUBLISHED' ? 'good' : 'warn'}>{v.status}</Badge>
                  </td>
                  <td>
                    <form action={setLimit} className="row gap">
                      <input type="hidden" name="planVersionId" value={v.id} />
                      <input
                        name="limitKey"
                        defaultValue="max_branches"
                        style={{ width: '9rem' }}
                      />
                      <input
                        name="value"
                        type="number"
                        defaultValue={3}
                        style={{ width: '5rem' }}
                      />
                      <button className="btn" type="submit">
                        Set
                      </button>
                    </form>
                  </td>
                </tr>
              ))}
            </Table>
          </Card>
        ))
      )}
    </>
  );
}
