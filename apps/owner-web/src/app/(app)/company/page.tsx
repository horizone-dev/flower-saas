import { serverApi } from '@/lib/api';
import { guarded } from '@/lib/org';
import { Card, PageHeader } from '@/components/ui';
import { selectCompanyAction } from './actions';

export const dynamic = 'force-dynamic';

/** pick the company you are working in (only needed when the workspace has more than one) */
export default async function CompanyPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const sp = await searchParams;
  const companies = await guarded(() => serverApi().listOrgCompanies(), '/company');
  return (
    <>
      <PageHeader
        title="Choose a company"
        subtitle="Products, prices and customers belong to one company. Pick the one you are working in."
      />
      <Card>
        {companies.map((c) => (
          <form
            key={c.id}
            action={selectCompanyAction}
            className="row gap"
            style={{ marginBottom: '0.5rem' }}
          >
            <input type="hidden" name="companyId" value={c.id} />
            <input type="hidden" name="next" value={sp.next ?? '/products'} />
            <span>
              <strong>{c.legalNameEn}</strong>
              {c.trn ? <span className="muted"> · TRN {c.trn}</span> : null}
            </span>
            <button className="btn btn--primary" type="submit" data-testid={`use-company-${c.id}`}>
              Use this company
            </button>
          </form>
        ))}
      </Card>
    </>
  );
}
