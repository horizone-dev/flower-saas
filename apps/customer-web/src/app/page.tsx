import Link from 'next/link';
import { t } from '@/lib/i18n';
import { getLocale } from '@/lib/locale';
import { getCatalog } from '@/lib/storefront';
import { displayName, filterProducts } from '@/lib/storefront/catalog';
import { ProductCard } from '@/components/product-card';

export const dynamic = 'force-dynamic';

/** browse: categories, search, and the product grid (the catalog's names, prices and availability exactly as given) */
export default async function ShopPage({
  searchParams,
}: {
  searchParams: Promise<{ category?: string; q?: string }>;
}) {
  const sp = await searchParams;
  const locale = await getLocale();
  const catalog = getCatalog();
  const [categories, products] = await Promise.all([
    catalog.listCategories(),
    catalog.listProducts(),
  ]);
  const shown = filterProducts(products, categories, { category: sp.category, q: sp.q });
  const filtered = Boolean(sp.category || sp.q?.trim());

  const href = (category?: string): string => {
    const p = new URLSearchParams();
    if (category) p.set('category', category);
    if (sp.q?.trim()) p.set('q', sp.q.trim());
    const s = p.toString();
    return s ? `/?${s}` : '/';
  };

  return (
    <>
      <h1 className="page__title">{t(locale, 'shop.heading')}</h1>

      <form method="get" action="/" className="search" role="search">
        {sp.category ? <input type="hidden" name="category" value={sp.category} /> : null}
        <label className="search__label" htmlFor="q">
          {t(locale, 'shop.search.label')}
        </label>
        <div className="search__row">
          <input
            id="q"
            name="q"
            type="search"
            defaultValue={sp.q ?? ''}
            placeholder={t(locale, 'shop.search.placeholder')}
            data-testid="search-input"
          />
          <button type="submit" className="btn">
            {t(locale, 'shop.search.submit')}
          </button>
        </div>
      </form>

      <nav className="rail" aria-label={t(locale, 'shop.categories')}>
        <Link
          href={href()}
          className={`rail__item${sp.category ? '' : ' rail__item--on'}`}
          aria-current={sp.category ? undefined : 'page'}
        >
          {t(locale, 'shop.all')}
        </Link>
        {categories.map((c) => (
          <Link
            key={c.id}
            href={href(c.slug)}
            className={`rail__item${sp.category === c.slug ? ' rail__item--on' : ''}`}
            aria-current={sp.category === c.slug ? 'page' : undefined}
            data-testid={`cat-${c.slug}`}
          >
            {displayName(c, locale)}
          </Link>
        ))}
      </nav>

      <p className="muted" role="status" data-testid="result-count">
        {t(locale, 'shop.resultCount', { count: shown.length })}
      </p>

      {shown.length === 0 ? (
        <div className="empty" data-testid="shop-empty">
          <p>{t(locale, 'shop.empty')}</p>
          {filtered ? (
            <Link href="/" className="btn">
              {t(locale, 'shop.clear')}
            </Link>
          ) : null}
        </div>
      ) : (
        <ul className="grid" data-testid="product-grid">
          {shown.map((p) => (
            <ProductCard key={p.id} product={p} locale={locale} />
          ))}
        </ul>
      )}
    </>
  );
}
