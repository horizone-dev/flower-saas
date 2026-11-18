import { DEFAULT_LOCALE, isSupportedLocale, textDirection, type Locale } from '@flower/i18n';

/** the storefront's own strings, English and Arabic. The key sets are kept identical by a test; a placeholder is written {name}. */
const en = {
  'shop.name': 'Demo flower shop',
  'demo.banner': 'Demo catalog: sample products, not a live shop.',
  'nav.shop': 'Shop',
  'nav.cart': 'Cart',
  'nav.cartWithCount': 'Cart, {count} items',
  'lang.switchTo': 'العربية',
  'shop.heading': 'Fresh flowers, wrapped to order',
  'shop.categories': 'Categories',
  'shop.all': 'All',
  'shop.search.label': 'Search flowers',
  'shop.search.placeholder': 'Roses, tulips, gifts',
  'shop.search.submit': 'Search',
  'shop.empty': 'Nothing matches. Clear the search or pick another category.',
  'shop.clear': 'Clear search',
  'shop.resultCount': '{count} products',
  'product.from': 'from {price}',
  'product.priceHidden': 'Price shown when you order',
  'product.notPriced': 'Price not set yet',
  'product.unavailable': 'Not available right now',
  'product.optionUnavailable': 'Not available',
  'product.quantity': 'Quantity',
  'product.add': 'Add to cart',
  'product.added': 'Added to your cart',
  'product.viewCart': 'View cart',
  'product.back': 'Back to the shop',
  'product.notFound': 'We could not find that product.',
  'product.chooseAll': 'Choose an option in every group to add this to your cart.',
  'cart.title': 'Your cart',
  'cart.empty': 'Your cart is empty. Browse the shop and add something you like.',
  'cart.itemCount': '{count} items',
  'cart.remove': 'Remove',
  'cart.decrease': 'Fewer',
  'cart.increase': 'More',
  'cart.line': '{name}, {variant}',
  'cart.subtotal': 'Estimated subtotal',
  'cart.subtotalNote': 'An estimate before VAT and delivery. The shop confirms the final price.',
  'cart.hiddenNote': '{count} items with a price shown at order are not included.',
  'cart.noEstimate': 'No estimate: the items have no price to add up.',
  'cart.review': 'Review order',
  'cart.keepShopping': 'Keep shopping',
  'cart.clear': 'Empty the cart',
  'checkout.title': 'Review your order',
  'checkout.closedTitle': 'Online ordering is not open yet',
  'checkout.closedBody':
    'You can build a cart and see an estimate, but this shop cannot take orders, bookings or payments online yet. Nothing has been sent, reserved or charged.',
  'checkout.place': 'Place order',
  'checkout.back': 'Back to cart',
};

const ar: typeof en = {
  'shop.name': 'متجر الورد التجريبي',
  'demo.banner': 'كتالوج تجريبي: منتجات للعرض فقط وليس متجرًا فعليًا.',
  'nav.shop': 'المتجر',
  'nav.cart': 'السلة',
  'nav.cartWithCount': 'السلة، {count} عناصر',
  'lang.switchTo': 'English',
  'shop.heading': 'ورد طازج، يُغلَّف حسب الطلب',
  'shop.categories': 'الأقسام',
  'shop.all': 'الكل',
  'shop.search.label': 'ابحث عن الورد',
  'shop.search.placeholder': 'ورد جوري، توليب، هدايا',
  'shop.search.submit': 'بحث',
  'shop.empty': 'لا توجد نتائج. امسح البحث أو اختر قسمًا آخر.',
  'shop.clear': 'مسح البحث',
  'shop.resultCount': '{count} منتجات',
  'product.from': 'ابتداءً من {price}',
  'product.priceHidden': 'يظهر السعر عند الطلب',
  'product.notPriced': 'لم يُحدَّد السعر بعد',
  'product.unavailable': 'غير متوفر حاليًا',
  'product.optionUnavailable': 'غير متوفر',
  'product.quantity': 'الكمية',
  'product.add': 'أضف إلى السلة',
  'product.added': 'تمت الإضافة إلى سلتك',
  'product.viewCart': 'عرض السلة',
  'product.back': 'العودة إلى المتجر',
  'product.notFound': 'لم نعثر على هذا المنتج.',
  'product.chooseAll': 'اختر خيارًا من كل مجموعة لإضافة المنتج إلى السلة.',
  'cart.title': 'سلتك',
  'cart.empty': 'سلتك فارغة. تصفّح المتجر وأضف ما يعجبك.',
  'cart.itemCount': '{count} عناصر',
  'cart.remove': 'إزالة',
  'cart.decrease': 'أقل',
  'cart.increase': 'أكثر',
  'cart.line': '{name}، {variant}',
  'cart.subtotal': 'المجموع التقديري',
  'cart.subtotalNote': 'تقدير قبل ضريبة القيمة المضافة والتوصيل. يؤكد المتجر السعر النهائي.',
  'cart.hiddenNote': '{count} عناصر يظهر سعرها عند الطلب غير محسوبة.',
  'cart.noEstimate': 'لا يوجد تقدير: العناصر ليس لها سعر لجمعه.',
  'cart.review': 'مراجعة الطلب',
  'cart.keepShopping': 'متابعة التسوق',
  'cart.clear': 'إفراغ السلة',
  'checkout.title': 'مراجعة طلبك',
  'checkout.closedTitle': 'الطلب عبر الإنترنت غير متاح بعد',
  'checkout.closedBody':
    'يمكنك تجهيز السلة ومعرفة التقدير، لكن هذا المتجر لا يستطيع استلام الطلبات أو الحجوزات أو المدفوعات عبر الإنترنت حاليًا. لم يُرسَل أو يُحجز أو يُخصم أي شيء.',
  'checkout.place': 'إرسال الطلب',
  'checkout.back': 'العودة إلى السلة',
};

export type MessageKey = keyof typeof en;
export const MESSAGES: Record<Locale, Record<MessageKey, string>> = { en, ar };

/** the cookie that remembers the shopper's language (set by the language switch; read on the server so the first paint is already right-to-left for Arabic) */
export const LOCALE_COOKIE = 'lang';

/** the locale for a cookie value: anything but a supported locale is English */
export function localeOf(value: string | undefined): Locale {
  return value && isSupportedLocale(value) ? value : DEFAULT_LOCALE;
}

export function direction(locale: Locale): 'rtl' | 'ltr' {
  return textDirection(locale);
}

export function t(
  locale: Locale,
  key: MessageKey,
  params: Record<string, string | number> = {},
): string {
  const message = MESSAGES[locale][key];
  if (message === undefined) return key;
  return message.replace(/\{(\w+)\}/g, (whole, name: string) =>
    name in params ? String(params[name]) : whole,
  );
}
