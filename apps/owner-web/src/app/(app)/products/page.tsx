import Link from 'next/link';
import { serverApi } from '@/lib/api';
import { guarded } from '@/lib/org';
import { Badge, Card, Empty, Field, PageHeader, Select, Table } from '@/components/ui';
import { Flash } from '@/components/flash';
import { createProductAction } from '../catalog-actions';

export const dynamic = 'force-dynamic';

export default async function ProductsPage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; status?: string; ok?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const api = serverApi();
  const status =
    sp.status === 'DRAFT' || sp.status === 'ACTIVE' || sp.status === 'ARCHIVED'
      ? sp.status
      : undefined;
  const [page, categories] = await guarded(() =>
    Promise.all([
      api.listProducts({ limit: 100, ...(sp.q ? { q: sp.q } : {}), ...(status ? { status } : {}) }),
      api.listCategories({ status: 'ACTIVE' }),
    ]),
  );
  const categoryName = new Map(categories.map((c) => [c.id, c.nameEn]));

  return (
    <>
      <PageHeader title="Products" subtitle="Create, price and activate the products you sell." />
      <Flash ok={sp.ok} error={sp.error} />

      <Card title="Add a product">
        <form action={createProductAction} className="grid-forms" data-testid="create-product">
          <Field label="Product name" name="nameEn" placeholder="Red rose (60 cm)" required />
          <Select
            label="Category"
            name="categoryId"
            options={[
              { value: '', label: categories.length ? 'Choose…' : 'No categories yet' },
              ...categories.map((c) => ({ value: c.id, label: c.nameEn })),
            ]}
          />
          <Field label="…or a new category" name="newCategory" placeholder="Roses" />
          <button className="btn btn--primary" type="submit">
            Create product
          </button>
        </form>
      </Card>

      <Card title={`Catalog (${page.data.length}${page.hasNextPage ? '+' : ''})`}>
        <form method="get" className="row gap" style={{ marginBottom: '0.75rem' }}>
          <Field label="Search" name="q" defaultValue={sp.q ?? ''} />
          <Select
            label="Status"
            name="status"
            defaultValue={status ?? ''}
            options={[
              { value: '', label: 'All' },
              { value: 'DRAFT', label: 'Draft' },
              { value: 'ACTIVE', label: 'Active' },
              { value: 'ARCHIVED', label: 'Archived' },
            ]}
          />
          <button className="btn" type="submit">
            Filter
          </button>
        </form>
        {page.data.length === 0 ? (
          <Empty>No products yet.</Empty>
        ) : (
          <Table head={['Product', 'Category', 'Status']}>
            {page.data.map((p) => (
              <tr key={p.id} data-testid={`product-row-${p.nameEn}`}>
                <td>
                  <Link href={`/products/${p.id}`}>{p.nameEn}</Link>
                </td>
                <td>{categoryName.get(p.categoryId) ?? '—'}</td>
                <td>
                  <Badge
                    tone={
                      p.status === 'ACTIVE' ? 'good' : p.status === 'DRAFT' ? 'warn' : 'neutral'
                    }
                  >
                    {p.status}
                  </Badge>
                </td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
