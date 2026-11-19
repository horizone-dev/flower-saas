import Link from 'next/link';
import { t } from '@/lib/i18n';
import { getLocale } from '@/lib/locale';
import { CartView } from '@/components/cart-view';

export const dynamic = 'force-dynamic';

/**
 * Review your order. There is NO order, booking, payment or reservation contract a shopper can reach, so this page reviews the cart and says plainly
 * that ordering online is not open. The "Place order" control exists so the future step has a home, and it is disabled: nothing is sent anywhere.
 */
export default async function CheckoutPage() {
  const locale = await getLocale();
  return (
    <>
      <h1 className="page__title">{t(locale, 'checkout.title')}</h1>
      <CartView mode="review" />
      <section className="closed" role="status" data-testid="ordering-closed">
        <h2>{t(locale, 'checkout.closedTitle')}</h2>
        <p>{t(locale, 'checkout.closedBody')}</p>
        <div className="cart-actions">
          <button type="button" className="btn btn--primary" disabled data-testid="place-order">
            {t(locale, 'checkout.place')}
          </button>
          <Link href="/cart" className="btn">
            {t(locale, 'checkout.back')}
          </Link>
        </div>
      </section>
    </>
  );
}
