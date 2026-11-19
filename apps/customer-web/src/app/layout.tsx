import type { Metadata, Viewport } from 'next';
import { direction } from '@/lib/i18n';
import { getLocale } from '@/lib/locale';
import { CartProvider } from '@/components/cart-provider';
import { Header } from '@/components/header';
import { LocaleProvider } from '@/components/locale-provider';
import './globals.css';

export const metadata: Metadata = {
  title: 'Flower shop',
  description: 'Fresh flowers, wrapped to order.',
};

export const viewport: Viewport = {
  themeColor: '#12302A',
  width: 'device-width',
  initialScale: 1,
};

export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const locale = await getLocale();
  return (
    <html lang={locale} dir={direction(locale)}>
      <body>
        <LocaleProvider locale={locale}>
          <CartProvider>
            <Header />
            <main className="page">{children}</main>
          </CartProvider>
        </LocaleProvider>
      </body>
    </html>
  );
}
