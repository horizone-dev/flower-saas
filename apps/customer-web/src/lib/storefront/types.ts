/**
 * The storefront's view of the catalog. These shapes mirror the EXISTING staff-side catalog contracts (CategoryRow, ProductRow, VariantRow,
 * OptionGroupWithValues, the branch effective price + availability entry) so that a real adapter, once the missing public contracts exist, is a mapping
 * and not a redesign. Nothing here is a new backend capability. Differences that matter: there is NO media field (the contract has none), and money is
 * integer minor units with a currency and exponent, never a float.
 */
export interface StoreMoney {
  amountMinor: string;
  currency: string;
  exponent: number;
}

export interface StoreCategory {
  id: string;
  slug: string;
  nameEn: string;
  nameAr: string | null;
  sortOrder: number;
}

export interface StoreOptionValue {
  id: string;
  labelEn: string;
  labelAr: string | null;
}

export interface StoreOptionGroup {
  id: string;
  nameEn: string;
  nameAr: string | null;
  values: StoreOptionValue[];
}

export interface StoreVariant {
  id: string;
  nameEn: string;
  nameAr: string | null;
  isDefault: boolean;
  /** one option value id per option group */
  optionValueIds: string[];
  /** the branch availability flag (the server's, not computed here) */
  available: boolean;
  /** the effective sell price, or null when none is resolvable */
  price: StoreMoney | null;
}

export interface StoreProduct {
  id: string;
  slug: string;
  categoryId: string;
  nameEn: string;
  nameAr: string | null;
  description: string | null;
  /** the shop hides this product's price from shoppers */
  hidePrice: boolean;
  optionGroups: StoreOptionGroup[];
  variants: StoreVariant[];
}

/**
 * What the storefront needs from a catalog. The only implementation today is the DEMO catalog: there is no shopper-facing (public or customer-realm)
 * catalog route in the backend, and a shopper has no session for the staff-authenticated ones.
 */
export interface StorefrontCatalogPort {
  readonly mode: 'demo' | 'live';
  listCategories(): Promise<StoreCategory[]>;
  listProducts(): Promise<StoreProduct[]>;
  getProduct(slug: string): Promise<StoreProduct | null>;
}
