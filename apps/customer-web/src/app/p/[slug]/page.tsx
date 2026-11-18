import Link from 'next/link';
import { t } from '@/lib/i18n';
import { getLocale } from '@/lib/locale';
import { getCatalog } from '@/lib/storefront';
import { displayName } from '@/lib/storefront/catalog';
import { Bloom } from '@/components/bloom';
import { ProductPicker } from '@/components/product-picker';

export const dynamic = 'force-dynamic';

export default async function ProductPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const locale = await getLocale();
  const product = await getCatalog().getProduct(slug);

  if (!product) {
    return (
      <div className="empty" data-testid="product-not-found">
        <p>{t(locale, 'product.notFound')}</p>
        <Link href="/" className="btn">
          {t(locale, 'product.back')}
        </Link>
      </div>
    );
  }

  return (
    <article className="product">
      <Link href="/" className="back">
        {t(locale, 'product.back')}
      </Link>
      <div className="product__art">
        <Bloom id={product.id} />
      </div>
      <div className="product__body">
        <h1 className="page__title" data-testid="product-name">
          {displayName(product, locale)}
        </h1>
        {/* the catalog has one (English) description with no Arabic variant: let the browser pick its direction from the text */}
        {product.description ? (
          <p className="product__desc" dir="auto">
            {product.description}
          </p>
        ) : null}
        <ProductPicker product={product} />
      </div>
    </article>
  );
}
