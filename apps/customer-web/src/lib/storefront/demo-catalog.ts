import type {
  StoreCategory,
  StoreMoney,
  StoreOptionGroup,
  StoreProduct,
  StoreVariant,
  StorefrontCatalogPort,
} from './types';

/**
 * THE DEMO CATALOG. Sample products in the exact shape of the existing catalog contracts, so the storefront screens can be built and tested while
 * the shopper-facing backend does not exist yet (see docs/mvp/CUSTOMER-WEB-STOREFRONT.md). It is clearly marked as a demo on every page, carries no
 * real shop's data, and is the ONLY catalog adapter: nothing here calls the API.
 */

const aed = (amountMinor: string): StoreMoney => ({ amountMinor, currency: 'AED', exponent: 2 });

const CAT = {
  bouquets: 'cat-bouquets',
  stems: 'cat-stems',
  plants: 'cat-plants',
  gifts: 'cat-gifts',
} as const;

export const DEMO_CATEGORIES: StoreCategory[] = [
  { id: CAT.bouquets, slug: 'bouquets', nameEn: 'Bouquets', nameAr: 'باقات', sortOrder: 1 },
  {
    id: CAT.stems,
    slug: 'single-stems',
    nameEn: 'Single stems',
    nameAr: 'ورود مفردة',
    sortOrder: 2,
  },
  { id: CAT.plants, slug: 'plants', nameEn: 'Plants', nameAr: 'نباتات', sortOrder: 3 },
  { id: CAT.gifts, slug: 'gifts', nameEn: 'Gifts', nameAr: 'هدايا', sortOrder: 4 },
];

function group(
  id: string,
  nameEn: string,
  nameAr: string,
  values: [string, string, string][],
): StoreOptionGroup {
  return {
    id,
    nameEn,
    nameAr,
    values: values.map(([vid, labelEn, labelAr]) => ({ id: vid, labelEn, labelAr })),
  };
}

function variant(
  id: string,
  nameEn: string,
  nameAr: string | null,
  optionValueIds: string[],
  price: string | null,
  extra: Partial<Pick<StoreVariant, 'isDefault' | 'available'>> = {},
): StoreVariant {
  return {
    id,
    nameEn,
    nameAr,
    isDefault: extra.isDefault ?? false,
    optionValueIds,
    available: extra.available ?? true,
    price: price === null ? null : aed(price),
  };
}

export const DEMO_PRODUCTS: StoreProduct[] = [
  {
    id: 'prd-red-roses',
    slug: 'red-roses',
    categoryId: CAT.bouquets,
    nameEn: 'Red roses',
    nameAr: 'ورد جوري أحمر',
    description: 'Long-stemmed red roses, cut to order and wrapped in kraft paper with a ribbon.',
    hidePrice: false,
    optionGroups: [
      group('grp-roses-size', 'Size', 'الحجم', [
        ['val-roses-s', '12 stems', '١٢ وردة'],
        ['val-roses-m', '24 stems', '٢٤ وردة'],
        ['val-roses-l', '36 stems', '٣٦ وردة'],
      ]),
    ],
    variants: [
      variant('var-roses-s', '12 stems', '١٢ وردة', ['val-roses-s'], '15000', { isDefault: true }),
      variant('var-roses-m', '24 stems', '٢٤ وردة', ['val-roses-m'], '26000'),
      variant('var-roses-l', '36 stems', '٣٦ وردة', ['val-roses-l'], '38000', { available: false }),
    ],
  },
  {
    id: 'prd-spring-tulips',
    slug: 'spring-tulips',
    categoryId: CAT.bouquets,
    nameEn: 'Spring tulips',
    nameAr: 'توليب الربيع',
    description: 'Soft tulips in a loose hand-tied bunch. Choose the size and the colour.',
    hidePrice: false,
    optionGroups: [
      group('grp-tulip-size', 'Size', 'الحجم', [
        ['val-tulip-s', 'Small', 'صغير'],
        ['val-tulip-l', 'Large', 'كبير'],
      ]),
      group('grp-tulip-colour', 'Colour', 'اللون', [
        ['val-tulip-pink', 'Pink', 'وردي'],
        ['val-tulip-white', 'White', 'أبيض'],
      ]),
    ],
    variants: [
      variant(
        'var-tulip-s-pink',
        'Small, pink',
        'صغير، وردي',
        ['val-tulip-s', 'val-tulip-pink'],
        '9500',
        { isDefault: true },
      ),
      variant(
        'var-tulip-s-white',
        'Small, white',
        'صغير، أبيض',
        ['val-tulip-s', 'val-tulip-white'],
        '9500',
      ),
      variant(
        'var-tulip-l-pink',
        'Large, pink',
        'كبير، وردي',
        ['val-tulip-l', 'val-tulip-pink'],
        '16500',
      ),
      // a variant the shop has not priced yet: shown, but it cannot be added
      variant(
        'var-tulip-l-white',
        'Large, white',
        'كبير، أبيض',
        ['val-tulip-l', 'val-tulip-white'],
        null,
      ),
    ],
  },
  {
    id: 'prd-blush-peonies',
    slug: 'blush-peonies',
    categoryId: CAT.bouquets,
    nameEn: 'Blush peonies',
    nameAr: 'فاوانيا وردية',
    description: 'Full, fragrant peonies in blush pink. Seasonal and cut fresh.',
    hidePrice: false,
    optionGroups: [
      group('grp-peony-size', 'Size', 'الحجم', [
        ['val-peony-m', 'Medium', 'وسط'],
        ['val-peony-l', 'Large', 'كبير'],
      ]),
    ],
    variants: [
      variant('var-peony-m', 'Medium', 'وسط', ['val-peony-m'], '21000', { isDefault: true }),
      variant('var-peony-l', 'Large', 'كبير', ['val-peony-l'], '34000'),
    ],
  },
  {
    id: 'prd-white-lilies',
    slug: 'white-lilies',
    categoryId: CAT.bouquets,
    nameEn: 'White lilies',
    nameAr: 'زنبق أبيض',
    description: 'Scented white lilies with greenery, for a table or a welcome.',
    hidePrice: false,
    optionGroups: [
      group('grp-lily-size', 'Size', 'الحجم', [
        ['val-lily-s', 'Small', 'صغير'],
        ['val-lily-m', 'Medium', 'وسط'],
      ]),
    ],
    variants: [
      variant('var-lily-s', 'Small', 'صغير', ['val-lily-s'], '12000', { isDefault: true }),
      variant('var-lily-m', 'Medium', 'وسط', ['val-lily-m'], '19000'),
    ],
  },
  {
    id: 'prd-single-red-rose',
    slug: 'single-red-rose',
    categoryId: CAT.stems,
    nameEn: 'Single red rose',
    nameAr: 'وردة جورية واحدة',
    description: 'One long-stemmed red rose, wrapped.',
    hidePrice: false,
    optionGroups: [],
    variants: [
      variant('var-single-rose', 'One stem', 'وردة واحدة', [], '1800', { isDefault: true }),
    ],
  },
  {
    id: 'prd-orchid',
    slug: 'orchid-in-pot',
    categoryId: CAT.plants,
    nameEn: 'Orchid in a pot',
    nameAr: 'أوركيد في إناء',
    description: 'A flowering phalaenopsis orchid in a ceramic pot. Easy to look after.',
    hidePrice: false,
    optionGroups: [
      group('grp-orchid-pot', 'Pot', 'الإناء', [
        ['val-orchid-white', 'White', 'أبيض'],
        ['val-orchid-charcoal', 'Charcoal', 'فحمي'],
      ]),
    ],
    variants: [
      variant('var-orchid-white', 'White pot', 'إناء أبيض', ['val-orchid-white'], '17500', {
        isDefault: true,
      }),
      variant('var-orchid-charcoal', 'Charcoal pot', 'إناء فحمي', ['val-orchid-charcoal'], '17500'),
    ],
  },
  {
    id: 'prd-chocolates',
    slug: 'chocolate-box',
    categoryId: CAT.gifts,
    nameEn: 'Chocolate box',
    nameAr: 'علبة شوكولاتة',
    description:
      'A small box of chocolates to send with flowers. The price is shown when you order.',
    hidePrice: true,
    optionGroups: [],
    variants: [variant('var-choc', 'Box of 12', 'علبة ١٢ قطعة', [], '8500', { isDefault: true })],
  },
  {
    id: 'prd-vase',
    slug: 'glass-vase',
    categoryId: CAT.gifts,
    nameEn: 'Glass vase',
    nameAr: 'مزهرية زجاجية',
    description: 'A clear glass vase, 24 cm tall.',
    hidePrice: false,
    optionGroups: [],
    variants: [variant('var-vase', 'One vase', 'مزهرية واحدة', [], '6500', { isDefault: true })],
  },
];

/** the demo adapter — in-memory, no I/O */
export const demoCatalog: StorefrontCatalogPort = {
  mode: 'demo',
  async listCategories() {
    return [...DEMO_CATEGORIES].sort((a, b) => a.sortOrder - b.sortOrder);
  },
  async listProducts() {
    return DEMO_PRODUCTS;
  },
  async getProduct(slug) {
    return DEMO_PRODUCTS.find((p) => p.slug === slug) ?? null;
  },
};
