import Link from 'next/link';
import { serverApi } from '@/lib/api';
import { availabilityByVariant } from '@/lib/catalog-forms';
import { guarded, ownerOrg } from '@/lib/org';
import { Badge, Card, Empty, PageHeader, Table } from '@/components/ui';
import { Flash } from '@/components/flash';
import { availabilityAction } from '../catalog-actions';

export const dynamic = 'force-dynamic';

/**
 * Branch stock visibility. The platform has NO stock-quantity ledger yet (Phase 5; the MVP quantity ledger is a draft awaiting approval), so this
 * page shows what really exists: the per-branch AVAILABILITY flag of every sellable variant, and lets the owner switch it. It never shows or
 * invents a quantity.
 */
export default async function StockPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string; ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const org = await ownerOrg('/stock');
  const branch = org.branches.find((b) => b.id === sp.branch) ?? org.branches[0];
  const api = serverApi();

  const rows = branch
    ? await guarded(async () => {
        const products = (await api.listProducts({ status: 'ACTIVE', limit: 100 })).data;
        const avail = availabilityByVariant(await api.getBranchAvailability(branch.id));
        const out = await Promise.all(
          products.map(async (p) => ({ p, variants: await api.listVariants(p.id) })),
        );
        return out.flatMap(({ p, variants }) =>
          variants
            .filter((v) => v.status === 'ACTIVE')
            .map((v) => ({
              productId: p.id,
              product: p.nameEn,
              variantId: v.id,
              variant: v.nameEn,
              available: avail.get(v.id)?.available ?? true,
            })),
        );
      })
    : [];

  return (
    <>
      <PageHeader
        title="Branch stock"
        subtitle="Which products each branch can sell. Quantities in stock are not tracked yet."
      />
      <Flash ok={sp.ok} error={sp.error} />
      <p className="banner" data-testid="stock-notice">
        Stock quantities and automatic deduction are not available yet — this screen controls the
        on/off availability flag only.
      </p>
      <div className="row gap" style={{ marginBottom: '0.75rem' }}>
        {org.branches.map((b) => (
          <Link
            key={b.id}
            className={`btn${b.id === branch?.id ? ' btn--primary' : ''}`}
            href={`/stock?branch=${b.id}`}
          >
            {b.name}
          </Link>
        ))}
      </div>
      <Card title={branch ? `Availability — ${branch.name}` : 'No branches'}>
        {rows.length === 0 ? (
          <Empty>No active products yet.</Empty>
        ) : (
          <Table head={['Product', 'Variant', 'Status', '']}>
            {rows.map((r) => (
              <tr key={r.variantId} data-testid={`stock-row-${r.product}`}>
                <td>{r.product}</td>
                <td>{r.variant}</td>
                <td>
                  <Badge tone={r.available ? 'good' : 'bad'}>
                    {r.available ? 'Available' : 'Unavailable'}
                  </Badge>
                </td>
                <td>
                  <form action={availabilityAction}>
                    <input type="hidden" name="branchId" value={branch?.id} />
                    <input type="hidden" name="variantId" value={r.variantId} />
                    <input type="hidden" name="available" value={r.available ? 'false' : 'true'} />
                    <input type="hidden" name="back" value={`/stock?branch=${branch?.id}`} />
                    <button className="btn" type="submit">
                      {r.available ? 'Mark unavailable' : 'Mark available'}
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
