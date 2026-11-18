import { t } from '@/lib/i18n';
import { getLocale } from '@/lib/locale';
import { CartView } from '@/components/cart-view';

export const dynamic = 'force-dynamic';

export default async function CartPage() {
  const locale = await getLocale();
  return (
    <>
      <h1 className="page__title">{t(locale, 'cart.title')}</h1>
      <CartView mode="cart" />
    </>
  );
}
