'use server';

import { randomUUID } from 'node:crypto';
import { redirect } from 'next/navigation';
import { ApiError, errorMessage, serverApi } from '@/lib/api';
import { parseMoneyInput, slugify, vatActivationBlocker } from '@/lib/catalog-forms';
import { ownerOrg, rethrowRedirect } from '@/lib/org';

/**
 * Owner Web catalog / stock / customer WRITES. Every action calls the real guarded API route (the API decides permission, scope, versions,
 * pricing and tax); nothing here validates a business rule beyond turning form text into the wire format. The outcome goes back to the page
 * as `?ok=` / `?error=` (the API's own error code is shown).
 */
const key = (): string => `ow-${randomUUID()}`;
const str = (f: FormData, n: string): string => String(f.get(n) ?? '').trim();
const num = (f: FormData, n: string): number => Number(str(f, n));

async function run(back: string, fn: () => Promise<string | void>): Promise<never> {
  let ok: string | undefined;
  let error: string | undefined;
  try {
    ok = (await fn()) ?? 'Saved';
  } catch (err) {
    rethrowRedirect(err);
    if (err instanceof ApiError && err.status === 401) redirect('/login');
    if (err instanceof ApiError && err.code === 'STEP_UP_REQUIRED')
      redirect(`/step-up?next=${encodeURIComponent(back)}`);
    error = errorMessage(err);
  }
  const sep = back.includes('?') ? '&' : '?';
  redirect(`${back}${sep}${error ? 'error' : 'ok'}=${encodeURIComponent(error ?? ok ?? 'Saved')}`);
}

export async function createProductAction(form: FormData): Promise<void> {
  let createdId: string | undefined;
  let error: string | undefined;
  try {
    const api = serverApi();
    const name = str(form, 'nameEn');
    if (!name) throw new Error('Enter a product name.');
    let categoryId = str(form, 'categoryId');
    const newCategory = str(form, 'newCategory');
    if (newCategory) {
      const c = await api.createCategory(
        { nameEn: newCategory, slug: `${slugify(newCategory)}-${randomUUID().slice(0, 6)}` },
        key(),
      );
      categoryId = c.id;
    }
    if (!categoryId) throw new Error('Choose a category or type a new one.');
    const p = await api.createProduct(
      {
        categoryId,
        nameEn: name,
        slug: `${slugify(name)}-${randomUUID().slice(0, 6)}`,
        fulfilmentStrategy: 'STOCKED',
      },
      key(),
    );
    createdId = p.id;
  } catch (err) {
    rethrowRedirect(err);
    if (err instanceof ApiError && err.status === 401) redirect('/login');
    error = errorMessage(err);
  }
  if (error) redirect(`/products?error=${encodeURIComponent(error)}`);
  redirect(
    `/products/${createdId}?ok=${encodeURIComponent('Product created as a draft. Complete the steps below to sell it.')}`,
  );
}

export async function updateProductAction(form: FormData): Promise<void> {
  const id = str(form, 'id');
  await run(`/products/${id}`, async () => {
    await serverApi().updateProduct(
      id,
      { nameEn: str(form, 'nameEn'), description: str(form, 'description') || null },
      num(form, 'version'),
    );
    return 'Product details saved.';
  });
}

export async function productStatusAction(form: FormData): Promise<void> {
  const id = str(form, 'id');
  const to = str(form, 'to');
  await run(`/products/${id}`, async () => {
    const api = serverApi();
    if (to === 'ACTIVE') await api.activateProduct(id, num(form, 'version'), key());
    else await api.archiveProduct(id, num(form, 'version'), key());
    return to === 'ACTIVE' ? 'Product is now active.' : 'Product archived.';
  });
}

export async function variantUomAction(form: FormData): Promise<void> {
  const productId = str(form, 'productId');
  await run(`/products/${productId}`, async () => {
    await serverApi().setVariantBaseUom(
      str(form, 'variantId'),
      str(form, 'baseUomCode'),
      num(form, 'version'),
    );
    return 'Unit of measure set.';
  });
}

export async function variantStatusAction(form: FormData): Promise<void> {
  const productId = str(form, 'productId');
  await run(`/products/${productId}`, async () => {
    const api = serverApi();
    const variantId = str(form, 'variantId');
    // F-6: re-check the EFFECTIVE category on the server (a stale page or a forged form must not activate an unclassified variant)
    const org = await ownerOrg(`/products/${productId}`);
    const tax = await api.resolveVariantTax(
      org.companyId,
      variantId,
      new Date().toISOString().slice(0, 10),
    );
    const blocked = vatActivationBlocker(tax.taxCategoryKey);
    if (blocked) throw new Error(blocked);
    await api.activateVariant(variantId, num(form, 'version'), key());
    return 'Variant is now active.';
  });
}

export async function setPriceAction(form: FormData): Promise<void> {
  const productId = str(form, 'productId');
  await run(`/products/${productId}`, async () => {
    const org = await ownerOrg();
    const minor = parseMoneyInput(str(form, 'price'), org.exponent);
    if (minor === null)
      throw new Error(
        `Enter the price as a number with at most ${org.exponent} decimals, e.g. 7.50.`,
      );
    await serverApi().replaceCompanyPrices(
      org.companyId,
      str(form, 'variantId'),
      [
        {
          uomCode: str(form, 'uomCode'),
          sell: { amountMinor: minor, currency: org.currency, exponent: org.exponent },
        },
      ],
      num(form, 'version'),
    );
    return `Selling price set (${org.currency}).`;
  });
}

export async function taxCategoryAction(form: FormData): Promise<void> {
  const productId = str(form, 'productId');
  await run(`/products/${productId}`, async () => {
    const k = str(form, 'taxCategoryKey');
    await serverApi().setProductTaxCategory(productId, k === '' ? null : k, num(form, 'version'));
    return k === '' ? 'VAT category cleared.' : `VAT category set to ${k}.`;
  });
}

export async function availabilityAction(form: FormData): Promise<void> {
  const back = str(form, 'back') || '/stock';
  await run(back, async () => {
    const available = str(form, 'available') === 'true';
    await serverApi().setBranchAvailability(
      str(form, 'branchId'),
      [{ variantId: str(form, 'variantId'), available }],
      key(),
    );
    return available ? 'Marked available at this branch.' : 'Marked unavailable at this branch.';
  });
}

export async function createCustomerAction(form: FormData): Promise<void> {
  await run('/customers', async () => {
    const org = await ownerOrg();
    const displayName = str(form, 'displayName');
    if (!displayName) throw new Error('Enter the customer name.');
    const phone = str(form, 'phone');
    const email = str(form, 'email');
    await serverApi().createCustomer(
      org.companyId,
      { displayName, ...(phone ? { phone } : {}), ...(email ? { email } : {}) },
      key(),
    );
    return `Customer ${displayName} added.`;
  });
}
