import Link from 'next/link';
import { serverApi } from '@/lib/api';
import {
  availabilityByVariant,
  formatMinor,
  readinessOf,
  vatActivationBlocker,
} from '@/lib/catalog-forms';
import { guarded, ownerOrg } from '@/lib/org';
import { Badge, Card, Field, PageHeader } from '@/components/ui';
import { Flash } from '@/components/flash';
import {
  availabilityAction,
  productStatusAction,
  setPriceAction,
  taxCategoryAction,
  updateProductAction,
  variantStatusAction,
  variantUomAction,
} from '../../catalog-actions';

export const dynamic = 'force-dynamic';

/** the platform-seeded VAT categories (task 2.7); the API rejects an unknown key */
const TAX_CATEGORIES = ['STANDARD', 'ZERO_RATED', 'EXEMPT'];

export default async function ProductPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ ok?: string; error?: string }>;
}) {
  const { id } = await params;
  const sp = await searchParams;
  const api = serverApi();
  const org = await ownerOrg(`/products/${id}`);
  const today = new Date().toISOString().slice(0, 10); // display aid for the VAT status only

  const data = await guarded(async () => {
    const [product, variants, uoms] = await Promise.all([
      api.getProduct(id),
      api.listVariants(id),
      api.listUoms(),
    ]);
    const perVariant = await Promise.all(
      variants.map(async (v) => {
        const [conv, prices, tax] = await Promise.all([
          api.getVariantConversions(v.id),
          api.getCompanyPrices(org.companyId, v.id),
          api.resolveVariantTax(org.companyId, v.id, today),
        ]);
        const availability = await Promise.all(
          org.branches.map(async (b) => ({
            branch: b,
            rows: availabilityByVariant(await api.getBranchAvailability(b.id, v.id)),
          })),
        );
        return { v, conv, prices, tax, availability };
      }),
    );
    return { product, uoms, perVariant };
  });
  const { product, uoms, perVariant } = data;

  const steps = readinessOf(
    product.status,
    perVariant.map((x) => ({
      id: x.v.id,
      status: x.v.status,
      baseUomCode: x.conv.baseUomCode,
      hasPrice: x.prices.prices.length > 0,
      taxCategoryKey: x.tax.taxCategoryKey,
    })),
  );
  // a category is set but the company's country has no in-force rate for it (the missing-category case is a readiness step above)
  const vatMissing = perVariant.some(
    (x) => x.tax.taxCategoryKey !== null && x.tax.rateBps === null,
  );
  const productTaxKey = perVariant[0]?.tax.taxCategoryKey ?? '';

  return (
    <>
      <PageHeader
        title={product.nameEn}
        subtitle={`Product · version ${product.version}`}
        actions={
          <>
            <Badge tone={product.status === 'ACTIVE' ? 'good' : 'warn'}>{product.status}</Badge>
            <Link className="btn" href="/products">
              All products
            </Link>
          </>
        }
      />
      <Flash ok={sp.ok} error={sp.error} />

      {steps.length > 0 || vatMissing ? (
        <Card title="Before this can be sold">
          <ol data-testid="readiness">
            {steps.map((s) => (
              <li key={s}>{s}</li>
            ))}
            {vatMissing ? (
              <li>
                The chosen VAT category has no VAT rate in effect for this company’s country — ask
                support before selling.
              </li>
            ) : null}
          </ol>
        </Card>
      ) : (
        <p className="banner" data-testid="ready">
          This product is ready to sell.
        </p>
      )}

      <Card title="Details">
        <form action={updateProductAction} className="grid-forms">
          <input type="hidden" name="id" value={product.id} />
          <input type="hidden" name="version" value={product.version} />
          <Field label="Name" name="nameEn" defaultValue={product.nameEn} required />
          <Field label="Description" name="description" defaultValue={product.description ?? ''} />
          <button className="btn" type="submit">
            Save details
          </button>
        </form>
        <div className="row gap" style={{ marginTop: '0.75rem' }}>
          {product.status !== 'ACTIVE' ? (
            <form action={productStatusAction}>
              <input type="hidden" name="id" value={product.id} />
              <input type="hidden" name="version" value={product.version} />
              <input type="hidden" name="to" value="ACTIVE" />
              <button className="btn btn--primary" type="submit" data-testid="activate-product">
                Activate product
              </button>
            </form>
          ) : null}
          {product.status !== 'ARCHIVED' ? (
            <form action={productStatusAction}>
              <input type="hidden" name="id" value={product.id} />
              <input type="hidden" name="version" value={product.version} />
              <input type="hidden" name="to" value="ARCHIVED" />
              <button className="btn btn--danger" type="submit">
                Archive
              </button>
            </form>
          ) : null}
        </div>
      </Card>

      <Card title="VAT category">
        <form action={taxCategoryAction} className="row gap" data-testid="tax-form">
          <input type="hidden" name="productId" value={product.id} />
          <input type="hidden" name="version" value={product.version} />
          <label className="field">
            <span>Category</span>
            <select name="taxCategoryKey" defaultValue={productTaxKey}>
              <option value="">Not set</option>
              {TAX_CATEGORIES.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
            </select>
          </label>
          <button className="btn" type="submit">
            Save VAT category
          </button>
        </form>
        <p className="muted">
          The VAT rate comes from the company’s country; here you only choose the category.
        </p>
      </Card>

      {perVariant.map(({ v, conv, prices, tax, availability }) => (
        <Card key={v.id} title={`Variant: ${v.nameEn}`}>
          <p>
            Status: <Badge tone={v.status === 'ACTIVE' ? 'good' : 'warn'}>{v.status}</Badge> · Unit:{' '}
            <strong>{conv.baseUomCode ?? 'not set'}</strong> · VAT:{' '}
            <strong>
              {tax.rateBps === null
                ? 'not configured'
                : `${tax.rateBps / 100}% (${tax.taxCategoryKey})`}
            </strong>
          </p>

          <form action={variantUomAction} className="row gap">
            <input type="hidden" name="productId" value={product.id} />
            <input type="hidden" name="variantId" value={v.id} />
            <input type="hidden" name="version" value={v.version} />
            <label className="field">
              <span>Unit of measure</span>
              <select name="baseUomCode" defaultValue={conv.baseUomCode ?? 'piece'}>
                {uoms.map((u) => (
                  <option key={u.code} value={u.code}>
                    {u.nameEn} ({u.code})
                  </option>
                ))}
              </select>
            </label>
            <button className="btn" type="submit">
              Set unit
            </button>
          </form>

          <form action={setPriceAction} className="row gap" data-testid={`price-form-${v.nameEn}`}>
            <input type="hidden" name="productId" value={product.id} />
            <input type="hidden" name="variantId" value={v.id} />
            <input type="hidden" name="version" value={prices.version} />
            <input type="hidden" name="uomCode" value={conv.baseUomCode ?? 'piece'} />
            <Field
              label={`Selling price per ${conv.baseUomCode ?? 'unit'} (${org.currency})`}
              name="price"
              defaultValue={
                prices.prices[0]
                  ? formatMinor(prices.prices[0].sell.amountMinor, org.exponent).replace(/,/g, '')
                  : ''
              }
              placeholder="7.50"
              required
            />
            <button className="btn" type="submit" disabled={!conv.baseUomCode}>
              Save price
            </button>
          </form>
          {!conv.baseUomCode ? <p className="muted">Set the unit before pricing.</p> : null}

          {v.status !== 'ACTIVE' ? (
            <form action={variantStatusAction}>
              <input type="hidden" name="productId" value={product.id} />
              <input type="hidden" name="variantId" value={v.id} />
              <input type="hidden" name="version" value={v.version} />
              <button
                className="btn"
                type="submit"
                data-testid="activate-variant"
                disabled={vatActivationBlocker(tax.taxCategoryKey) !== null}
              >
                Activate variant
              </button>
              {vatActivationBlocker(tax.taxCategoryKey) ? (
                <p className="muted" data-testid="activate-blocked">
                  {vatActivationBlocker(tax.taxCategoryKey)}
                </p>
              ) : null}
            </form>
          ) : null}

          <h3 style={{ marginTop: '1rem' }}>Availability by branch</h3>
          <p className="muted">
            An on/off flag per branch. Quantities in stock are not tracked yet.
          </p>
          {availability.map(({ branch, rows }) => {
            const a = rows.get(v.id);
            const available = a?.available ?? true;
            return (
              <form key={branch.id} action={availabilityAction} className="row gap">
                <input type="hidden" name="branchId" value={branch.id} />
                <input type="hidden" name="variantId" value={v.id} />
                <input type="hidden" name="available" value={available ? 'false' : 'true'} />
                <input type="hidden" name="back" value={`/products/${product.id}`} />
                <span>{branch.name}</span>
                <Badge tone={available ? 'good' : 'bad'}>
                  {available ? 'Available' : 'Unavailable'}
                </Badge>
                <button className="btn" type="submit" data-testid={`toggle-${branch.name}`}>
                  {available ? 'Mark unavailable' : 'Mark available'}
                </button>
              </form>
            );
          })}
        </Card>
      ))}
    </>
  );
}
