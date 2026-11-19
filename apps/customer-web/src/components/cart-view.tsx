'use client';

import Link from 'next/link';
import { estimateSubtotal } from '@/lib/cart';
import { formatMinor } from '@/lib/money';
import { useCart } from './cart-provider';
import { useLocale } from './locale-provider';
import { Bloom } from './bloom';

/**
 * The cart, as a list and an INDICATIVE subtotal. `mode="review"` is the read-only review page: the same lines, no editing, and the honest statement
 * that this shop cannot take an order online yet. Nothing here talks to a server.
 */
export function CartView({ mode }: { mode: 'cart' | 'review' }) {
  const { locale, t } = useLocale();
  const { cart, ready, count, setQty, remove, clear } = useCart();
  const estimate = estimateSubtotal(cart);

  if (!ready)
    return (
      <p className="muted" aria-busy="true">
        …
      </p>
    );
  if (cart.length === 0) {
    return (
      <div className="empty" data-testid="cart-empty">
        <p>{t('cart.empty')}</p>
        <Link href="/" className="btn btn--primary">
          {t('cart.keepShopping')}
        </Link>
      </div>
    );
  }

  return (
    <div>
      <p className="muted" data-testid="cart-items-count">
        {t('cart.itemCount', { count })}
      </p>
      <ul className="lines">
        {cart.map((l) => {
          const name = locale === 'ar' && l.productNameAr ? l.productNameAr : l.productNameEn;
          const variant = locale === 'ar' && l.variantNameAr ? l.variantNameAr : l.variantNameEn;
          return (
            <li key={l.variantId} className="line" data-testid="cart-line">
              <div className="line__art">
                <Bloom id={l.productId} />
              </div>
              <div className="line__body">
                <Link href={`/p/${l.productSlug}`} className="line__name">
                  {t('cart.line', { name, variant })}
                </Link>
                <p className="line__price" data-testid="line-price">
                  {l.unitPriceMinor === null
                    ? t('product.priceHidden')
                    : `${l.currency} ${formatMinor(l.unitPriceMinor, l.exponent)}`}
                </p>
                {mode === 'cart' ? (
                  <div className="line__controls">
                    <div className="stepper" role="group" aria-label={t('product.quantity')}>
                      <button
                        type="button"
                        onClick={() => setQty(l.variantId, l.quantity - 1)}
                        aria-label={t('cart.decrease')}
                      >
                        −
                      </button>
                      <output data-testid="line-qty">{l.quantity}</output>
                      <button
                        type="button"
                        onClick={() => setQty(l.variantId, l.quantity + 1)}
                        aria-label={t('cart.increase')}
                      >
                        +
                      </button>
                    </div>
                    <button
                      type="button"
                      className="link-button"
                      onClick={() => remove(l.variantId)}
                      data-testid="line-remove"
                    >
                      {t('cart.remove')}
                    </button>
                  </div>
                ) : (
                  <p className="muted">× {l.quantity}</p>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <section className="subtotal" aria-label={t('cart.subtotal')}>
        {estimate ? (
          <>
            <p className="subtotal__row">
              <span>{t('cart.subtotal')}</span>
              <strong data-testid="subtotal">
                {estimate.currency} {formatMinor(estimate.amountMinor, estimate.exponent)}
              </strong>
            </p>
            <p className="muted">{t('cart.subtotalNote')}</p>
            {estimate.hiddenPriceLines > 0 ? (
              <p className="muted" data-testid="hidden-note">
                {t('cart.hiddenNote', { count: estimate.hiddenPriceLines })}
              </p>
            ) : null}
          </>
        ) : (
          <p className="muted" data-testid="no-estimate">
            {t('cart.noEstimate')}
          </p>
        )}
      </section>

      {mode === 'cart' ? (
        <div className="cart-actions">
          <Link href="/checkout" className="btn btn--primary" data-testid="review-order">
            {t('cart.review')}
          </Link>
          <Link href="/" className="btn">
            {t('cart.keepShopping')}
          </Link>
          <button type="button" className="link-button" onClick={clear} data-testid="clear-cart">
            {t('cart.clear')}
          </button>
        </div>
      ) : null}
    </div>
  );
}
