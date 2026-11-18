import Link from 'next/link';
import type { Locale } from '@flower/i18n';
import { t } from '@/lib/i18n';
import { formatMinor } from '@/lib/money';
import { displayName, fromPrice } from '@/lib/storefront/catalog';
import type { StoreProduct } from '@/lib/storefront';
import { Bloom } from './bloom';
import { PriceTag } from './price-tag';

export function ProductCard({ product, locale }: { product: StoreProduct; locale: Locale }) {
  const price = fromPrice(product);
  const buyable = product.variants.some((v) => v.available && v.price !== null);
  return (
    <li className="card" data-testid="product-card">
      <Link href={`/p/${product.slug}`} className="card__link">
        <div className="card__art">
          <Bloom id={product.id} />
          <div className="card__tag">
            {!buyable ? (
              <PriceTag muted>{t(locale, 'product.unavailable')}</PriceTag>
            ) : product.hidePrice ? (
              <PriceTag muted>{t(locale, 'product.priceHidden')}</PriceTag>
            ) : price ? (
              <PriceTag>
                {t(locale, 'product.from', {
                  price: `${price.currency} ${formatMinor(price.amountMinor, price.exponent)}`,
                })}
              </PriceTag>
            ) : null}
          </div>
        </div>
        <h3 className="card__name">{displayName(product, locale)}</h3>
      </Link>
    </li>
  );
}
