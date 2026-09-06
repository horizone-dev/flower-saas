/**
 * Phase 3 task 3.1 — Business-Type preset templates + their normalized capability
 * defaults. The frozen source of truth is
 * `docs/phase-3/PHASE-3.1-CAPABILITY-SPEC.md` §B / §C. Seeded by `seed.ts`.
 *
 *   - 35 curated presets (Appendix A) — Jewellery/Accessories and
 *     Mobile/Mobile-Accessories are EXCLUDED.
 *   - `CUSTOM` is a NORMAL row like every other (spec §2 / §I.3). The only thing
 *     that differs is the contents of its capability list — no code branches on
 *     the key.
 *   - Every template's capability list is EXPLICIT and complete (baseline +
 *     per-preset extras already resolved). Each becomes one
 *     `business_type_template_capability` row with `enabled = true`, `config = null`.
 *     A capability a preset does not grant simply has no row (absence = not
 *     granted — the apply algorithm snapshots exactly the present rows).
 */
import { CATALOG_CAPABILITY_KEYS, type CapabilityKey } from '@flower/shared-types';

/** Ordinary-retail baseline (spec §C.1) — applied to every preset except CUSTOM. */
export const BUSINESS_TYPE_BASELINE: readonly CapabilityKey[] = [
  'strategy.stocked',
  'variants',
  'multi_uom',
  'identifiers.barcode_qr',
  'branch_pricing',
  'channel.pos',
  'inventory.tracked',
  'purchasing',
];

/** The `+` extras a preset adds on top of the baseline (spec §C.3). CUSTOM is the
 *  one exception — it lists its complete 3-key minimal set (spec §C.2). */
interface PresetDef {
  key: string;
  nameEn: string;
  nameAr: string;
  /** for a normal preset: extras added on top of the baseline.
   *  for CUSTOM: `absolute` replaces the baseline entirely. */
  extra?: readonly CapabilityKey[];
  absolute?: readonly CapabilityKey[];
}

const PRESETS: readonly PresetDef[] = [
  {
    key: 'FLOWER_FLORIST',
    nameEn: 'Flower Shop / Florist',
    nameAr: 'محل زهور',
    extra: [
      'strategy.bom',
      'strategy.custom',
      'inventory.lot_batch',
      'inventory.expiry',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'GIFT_HAMPER',
    nameEn: 'Gift Hampers & Baskets',
    nameAr: 'سلال وهدايا',
    extra: [
      'strategy.bom',
      'strategy.custom',
      'inventory.lot_batch',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'BAKERY_CAKE',
    nameEn: 'Bakery & Cake Shop',
    nameAr: 'مخبز ومحل كيك',
    extra: [
      'strategy.bom',
      'strategy.custom',
      'production',
      'inventory.lot_batch',
      'inventory.expiry',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'CHOCOLATE_CONFECTIONERY',
    nameEn: 'Chocolate & Confectionery',
    nameAr: 'شوكولاتة وحلويات',
    extra: [
      'strategy.bom',
      'strategy.custom',
      'inventory.lot_batch',
      'inventory.expiry',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'PERFUME_ATTAR',
    nameEn: 'Perfume & Attar',
    nameAr: 'عطور ودهن عود',
    extra: [
      'strategy.bom',
      'production',
      'inventory.lot_batch',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'CANDLE_HOME_FRAGRANCE',
    nameEn: 'Candles & Home Fragrance',
    nameAr: 'شموع ومعطرات منزل',
    extra: ['strategy.bom', 'production', 'delivery', 'channel.customer_web', 'customer_ordering'],
  },
  {
    key: 'COSMETICS_BEAUTY',
    nameEn: 'Cosmetics & Beauty',
    nameAr: 'مستحضرات تجميل',
    extra: [
      'inventory.lot_batch',
      'inventory.expiry',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'HANDMADE_PRODUCTS',
    nameEn: 'Handmade Products',
    nameAr: 'منتجات يدوية',
    extra: [
      'strategy.bom',
      'strategy.custom',
      'production',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'DATES_DRY_FRUITS_NUTS',
    nameEn: 'Dates, Dry Fruits & Nuts',
    nameAr: 'تمور ومكسرات',
    extra: [
      'strategy.bom',
      'strategy.custom',
      'inventory.lot_batch',
      'inventory.expiry',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'COFFEE_TEA',
    nameEn: 'Coffee & Tea',
    nameAr: 'قهوة وشاي',
    extra: [
      'strategy.bom',
      'production',
      'inventory.lot_batch',
      'inventory.expiry',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'SPICES_FOOD_PACKING',
    nameEn: 'Spices & Food Packing',
    nameAr: 'بهارات وتعبئة أغذية',
    extra: [
      'strategy.bom',
      'production',
      'inventory.lot_batch',
      'inventory.expiry',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'PLANT_NURSERY',
    nameEn: 'Plant Nursery',
    nameAr: 'مشتل نباتات',
    extra: [
      'strategy.custom',
      'inventory.lot_batch',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'BALLOON_PARTY_EVENT',
    nameEn: 'Balloons, Party & Events',
    nameAr: 'بالونات وحفلات ومناسبات',
    extra: [
      'strategy.bom',
      'strategy.custom',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'PERSONALIZED_GIFTS',
    nameEn: 'Personalized Gifts',
    nameAr: 'هدايا مخصصة',
    extra: [
      'strategy.custom',
      'production',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'CORPORATE_GIFTING',
    nameEn: 'Corporate Gifting',
    nameAr: 'هدايا الشركات',
    extra: [
      'strategy.bom',
      'strategy.custom',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'GROCERY_MINIMART',
    nameEn: 'Grocery / Mini-mart',
    nameAr: 'بقالة',
    extra: [
      'inventory.lot_batch',
      'inventory.expiry',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'SUPERMARKET',
    nameEn: 'Supermarket',
    nameAr: 'سوبر ماركت',
    extra: [
      'inventory.lot_batch',
      'inventory.expiry',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'WHOLESALE_DISTRIBUTION',
    nameEn: 'Wholesale & Distribution',
    nameAr: 'تجارة الجملة والتوزيع',
    extra: ['inventory.lot_batch', 'delivery'],
  },
  {
    key: 'GENERAL_TRADING',
    nameEn: 'General Trading',
    nameAr: 'تجارة عامة',
    extra: ['delivery', 'channel.customer_web', 'customer_ordering'],
  },
  {
    key: 'STATIONERY_BOOKS',
    nameEn: 'Stationery & Books',
    nameAr: 'قرطاسية وكتب',
    extra: ['delivery', 'channel.customer_web', 'customer_ordering'],
  },
  {
    key: 'TOYS_BABY',
    nameEn: 'Toys & Baby',
    nameAr: 'ألعاب ومستلزمات أطفال',
    extra: [
      'inventory.lot_batch',
      'inventory.expiry',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'PET_STORE',
    nameEn: 'Pet Store',
    nameAr: 'متجر حيوانات أليفة',
    extra: [
      'inventory.lot_batch',
      'inventory.expiry',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'CLOTHING_BOUTIQUE',
    nameEn: 'Clothing & Boutique',
    nameAr: 'ملابس وبوتيك',
    extra: ['delivery', 'channel.customer_web', 'customer_ordering'],
  },
  {
    key: 'FOOTWEAR',
    nameEn: 'Footwear',
    nameAr: 'أحذية',
    extra: ['delivery', 'channel.customer_web', 'customer_ordering'],
  },
  {
    key: 'COMPUTER_ELECTRONICS',
    nameEn: 'Computers & Electronics',
    nameAr: 'حاسبات وإلكترونيات',
    extra: ['delivery', 'channel.customer_web', 'customer_ordering'],
  },
  {
    key: 'HARDWARE_TOOLS',
    nameEn: 'Hardware & Tools',
    nameAr: 'أدوات وعُدد',
    extra: ['delivery', 'channel.customer_web', 'customer_ordering'],
  },
  {
    key: 'ELECTRICAL_PLUMBING',
    nameEn: 'Electrical & Plumbing',
    nameAr: 'كهرباء وسباكة',
    extra: ['delivery'],
  },
  {
    key: 'BUILDING_MATERIALS',
    nameEn: 'Building Materials',
    nameAr: 'مواد بناء',
    extra: ['delivery'],
  },
  {
    key: 'AUTO_PARTS',
    nameEn: 'Auto Parts',
    nameAr: 'قطع غيار سيارات',
    extra: ['delivery', 'channel.customer_web', 'customer_ordering'],
  },
  {
    key: 'HOME_DECOR',
    nameEn: 'Home Décor',
    nameAr: 'ديكور منزلي',
    extra: ['delivery', 'channel.customer_web', 'customer_ordering'],
  },
  {
    key: 'KITCHENWARE',
    nameEn: 'Kitchenware',
    nameAr: 'أدوات مطبخ',
    extra: ['delivery', 'channel.customer_web', 'customer_ordering'],
  },
  {
    key: 'PACKAGING_DISPOSABLES',
    nameEn: 'Packaging & Disposables',
    nameAr: 'تغليف ومستهلكات',
    extra: ['delivery'],
  },
  {
    key: 'CLEANING_SUPPLIES',
    nameEn: 'Cleaning Supplies',
    nameAr: 'مواد تنظيف',
    extra: [
      'strategy.bom',
      'production',
      'inventory.expiry',
      'delivery',
      'channel.customer_web',
      'customer_ordering',
    ],
  },
  {
    key: 'MULTI_CATEGORY_RETAIL',
    nameEn: 'Multi-category Retail',
    nameAr: 'تجزئة متعددة الأقسام',
    // owner §5 — deliberately NOT strategy.bom / strategy.custom
    extra: [
      'delivery',
      'channel.customer_web',
      'customer_ordering',
      'inventory.lot_batch',
      'inventory.expiry',
    ],
  },
  {
    key: 'CUSTOM',
    nameEn: 'Custom / other',
    nameAr: 'مخصص / أخرى',
    absolute: ['strategy.stocked', 'branch_pricing', 'channel.pos'],
  },
];

export interface BusinessTypeTemplateSeed {
  key: string;
  nameEn: string;
  nameAr: string;
  /** the complete, resolved set of ENABLED capability keys for this preset */
  capabilities: readonly CapabilityKey[];
}

/** Current curated version of every seeded template. Bump this (and re-seed) when
 *  any preset's capability default changes (spec §F.1.1). */
export const BUSINESS_TYPE_TEMPLATE_VERSION = 1;

function resolve(def: PresetDef): readonly CapabilityKey[] {
  if (def.absolute) return dedupe(def.absolute);
  return dedupe([...BUSINESS_TYPE_BASELINE, ...(def.extra ?? [])]);
}

function dedupe(keys: readonly CapabilityKey[]): CapabilityKey[] {
  return [...new Set(keys)];
}

export const BUSINESS_TYPE_TEMPLATES: readonly BusinessTypeTemplateSeed[] = PRESETS.map((def) => ({
  key: def.key,
  nameEn: def.nameEn,
  nameAr: def.nameAr,
  capabilities: resolve(def),
}));

// ── invariants (also asserted by catalog-capabilities.test.ts) ───────────────
const KNOWN = new Set<string>(CATALOG_CAPABILITY_KEYS);
for (const t of BUSINESS_TYPE_TEMPLATES) {
  for (const c of t.capabilities) {
    if (!KNOWN.has(c)) {
      throw new Error(`catalog-capabilities: "${t.key}" references unknown capability "${c}"`);
    }
  }
}
if (new Set(BUSINESS_TYPE_TEMPLATES.map((t) => t.key)).size !== BUSINESS_TYPE_TEMPLATES.length) {
  throw new Error('catalog-capabilities: duplicate template key');
}
