'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { MAX_LINE_QUANTITY } from '@/lib/cart';
import { formatMinor } from '@/lib/money';
import { defaultVariant, displayName, findVariant } from '@/lib/storefront/catalog';
import type { StoreProduct } from '@/lib/storefront';
import { useCart } from './cart-provider';
import { useLocale } from './locale-provider';
import { PriceTag } from './price-tag';

/** the option groups, the quantity and the add button for one product. Availability and price are shown exactly as the catalog gives them. */
export function ProductPicker({ product }: { product: StoreProduct }) {
  const { locale, t } = useLocale();
  const { add } = useCart();
  const initial = useMemo(() => {
    const d = defaultVariant(product);
    return Object.fromEntries(
      product.optionGroups.flatMap((g) => {
        const v = g.values.find((val) => d.optionValueIds.includes(val.id));
        return v ? [[g.id, v.id] as const] : [];
      }),
    );
  }, [product]);
  const [choice, setChoice] = useState<Record<string, string>>(initial);
  const [quantity, setQuantity] = useState(1);
  const [added, setAdded] = useState(false);

  const variant = findVariant(product, choice);
  const sellable = variant !== null && variant.available && variant.price !== null;

  function addToCart(): void {
    if (!variant || !sellable || !variant.price) return;
    add(
      {
        variantId: variant.id,
        productId: product.id,
        productSlug: product.slug,
        productNameEn: product.nameEn,
        productNameAr: product.nameAr,
        variantNameEn: variant.nameEn,
        variantNameAr: variant.nameAr,
        // a shop that hides the price keeps it out of the cart too
        unitPriceMinor: product.hidePrice ? null : variant.price.amountMinor,
        currency: variant.price.currency,
        exponent: variant.price.exponent,
      },
      quantity,
    );
    setAdded(true);
  }

  return (
    <div className="picker">
      {product.optionGroups.map((g) => (
        <fieldset key={g.id} className="picker__group">
          <legend>{displayName(g, locale)}</legend>
          <div className="chips">
            {g.values.map((val) => {
              const anyAvailable = product.variants.some(
                (v) => v.optionValueIds.includes(val.id) && v.available,
              );
              const on = choice[g.id] === val.id;
              return (
                <label
                  key={val.id}
                  className={`chip${on ? ' chip--on' : ''}${anyAvailable ? '' : ' chip--off'}`}
                >
                  <input
                    type="radio"
                    name={g.id}
                    value={val.id}
                    checked={on}
                    onChange={() => {
                      setChoice((c) => ({ ...c, [g.id]: val.id }));
                      setAdded(false);
                    }}
                    data-testid={`opt-${val.id}`}
                  />
                  <span>{locale === 'ar' && val.labelAr ? val.labelAr : val.labelEn}</span>
                  {!anyAvailable ? <small>{t('product.optionUnavailable')}</small> : null}
                </label>
              );
            })}
          </div>
        </fieldset>
      ))}

      <div className="picker__price" aria-live="polite" data-testid="variant-status">
        {variant === null ? (
          <p className="muted">{t('product.chooseAll')}</p>
        ) : !variant.available ? (
          <PriceTag muted>{t('product.unavailable')}</PriceTag>
        ) : variant.price === null ? (
          <PriceTag muted>{t('product.notPriced')}</PriceTag>
        ) : product.hidePrice ? (
          <PriceTag muted>{t('product.priceHidden')}</PriceTag>
        ) : (
          <PriceTag testId="variant-price">
            {`${variant.price.currency} ${formatMinor(variant.price.amountMinor, variant.price.exponent)}`}
          </PriceTag>
        )}
      </div>

      <div className="buybar">
        <div className="stepper" role="group" aria-label={t('product.quantity')}>
          <button
            type="button"
            onClick={() => setQuantity((q) => Math.max(1, q - 1))}
            aria-label={t('cart.decrease')}
            disabled={quantity <= 1}
          >
            −
          </button>
          <output aria-live="off" data-testid="qty">
            {quantity}
          </output>
          <button
            type="button"
            onClick={() => setQuantity((q) => Math.min(MAX_LINE_QUANTITY, q + 1))}
            aria-label={t('cart.increase')}
            disabled={quantity >= MAX_LINE_QUANTITY}
          >
            +
          </button>
        </div>
        <button
          type="button"
          className="btn btn--primary buybar__add"
          disabled={!sellable}
          onClick={addToCart}
          data-testid="add-to-cart"
        >
          {t('product.add')}
        </button>
      </div>
      <p className="picker__added" role="status" data-testid="added-status">
        {added ? (
          <>
            {t('product.added')} ·{' '}
            <Link href="/cart" data-testid="view-cart">
              {t('product.viewCart')}
            </Link>
          </>
        ) : null}
      </p>
    </div>
  );
}
