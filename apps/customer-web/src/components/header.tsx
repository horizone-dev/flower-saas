'use client';

import Link from 'next/link';
import { useCart } from './cart-provider';
import { useLocale } from './locale-provider';
import { setLocaleAction } from '@/app/actions';

/** shop name, language switch and the cart link with its count */
export function Header() {
  const { locale, t } = useLocale();
  const { count, ready } = useCart();
  const other = locale === 'ar' ? 'en' : 'ar';
  return (
    <header className="site-header">
      <div className="site-header__bar">
        <Link href="/" className="site-header__name" data-testid="shop-name">
          {t('shop.name')}
        </Link>
        <nav className="site-header__nav" aria-label={t('nav.shop')}>
          <form action={setLocaleAction}>
            <input type="hidden" name="locale" value={other} />
            <button type="submit" className="link-button" lang={other} data-testid="lang-switch">
              {t('lang.switchTo')}
            </button>
          </form>
          <Link
            href="/cart"
            className="cart-link"
            aria-label={ready ? t('nav.cartWithCount', { count }) : t('nav.cart')}
            data-testid="cart-link"
          >
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" focusable="false">
              <path
                d="M5 8h14l-1.2 11.2a2 2 0 0 1-2 1.8H8.2a2 2 0 0 1-2-1.8L5 8Zm4 0V7a3 3 0 0 1 6 0v1"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <span
              className="cart-link__count"
              data-testid="cart-count"
              hidden={!ready || count === 0}
            >
              {count}
            </span>
          </Link>
        </nav>
      </div>
      <p className="demo-banner" role="note" data-testid="demo-banner">
        {t('demo.banner')}
      </p>
    </header>
  );
}
