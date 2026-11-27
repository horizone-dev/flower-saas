/**
 * Pure helpers for the Owner Web catalog screens. NO business rule lives here: pricing, tax, stock and permissions are decided by the API.
 * These only turn form text into the API's wire format (integer minor units as strings) and arrange what the API returned.
 */

/** a slug base from a product name (the caller appends a short unique suffix; the API enforces uniqueness) */
export function slugify(name: string): string {
  const s = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  return s === '' ? 'item' : s;
}

/** KWD / BHD / OMR are 3-decimal; everything else in the GCC is 2 (the API validates the currency + exponent against the company anyway) */
export function exponentForCurrency(currency: string | null | undefined): number {
  return currency === 'KWD' || currency === 'BHD' || currency === 'OMR' ? 3 : 2;
}

/** "7.50" → "750" (integer minor units as a string). No floating point; null for anything ambiguous or with too many decimals. */
export function parseMoneyInput(text: string, exponent: number): string | null {
  const raw = text.trim();
  // thousands separators only in strict groups of three ("1,250.25"); "1,2" is ambiguous (a decimal comma) and is refused
  if (!/^(\d+|\d{1,3}(,\d{3})+)(\.\d+)?$/.test(raw)) return null;
  const t = raw.replace(/,/g, '');
  const [whole = '', frac = ''] = t.split('.');
  if (frac.length > exponent) return null;
  const minor = BigInt(whole + frac.padEnd(exponent, '0'));
  return minor.toString();
}

/** "750" → "7.50" (display only) */
export function formatMinor(minor: string, exponent: number): string {
  const neg = minor.startsWith('-');
  const digits = (neg ? minor.slice(1) : minor).padStart(exponent + 1, '0');
  const whole = digits.slice(0, digits.length - exponent).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const frac = exponent > 0 ? `.${digits.slice(digits.length - exponent)}` : '';
  return `${neg ? '-' : ''}${whole}${frac}`;
}

export interface ReadinessVariant {
  id: string;
  status: string;
  baseUomCode: string | null;
  hasPrice: boolean;
  /** the EFFECTIVE tax category (variant override, else product default); null = none — which the sale path would charge as 0 VAT (F-6) */
  taxCategoryKey: string | null;
}

const missingCategory = (k: string | null): boolean => k === null || k.trim() === '';

/** F-6: why a variant must not be activated, or null. A missing classification must never silently mean "no VAT"; zero-rated / exempt are explicit categories and pass. */
export function vatActivationBlocker(taxCategoryKey: string | null): string | null {
  return missingCategory(taxCategoryKey)
    ? 'Set a VAT category (Standard, Zero-rated or Exempt) before activating: without one the sale would charge no VAT.'
    : null;
}

/** the steps still missing before this product can be sold, in the order the owner must do them (a guide only — the API enforces each rule) */
export function readinessOf(
  productStatus: string,
  variants: readonly ReadinessVariant[],
): string[] {
  if (variants.length === 0) return ['Add a variant'];
  const steps: string[] = [];
  if (variants.some((v) => v.baseUomCode === null)) steps.push('Set the unit of measure');
  if (variants.some((v) => !v.hasPrice)) steps.push('Set a selling price');
  if (variants.some((v) => missingCategory(v.taxCategoryKey)))
    steps.push('Set the VAT category (Standard, Zero-rated or Exempt)');
  // the product is activated first, then its variants (the order the catalog API accepts)
  if (productStatus !== 'ACTIVE') steps.push('Activate the product');
  if (variants.some((v) => v.status !== 'ACTIVE')) steps.push('Activate the variant');
  return steps;
}

/** branch availability rows by variant (a variant with no explicit row is available — read `explicit` to tell them apart) */
export function availabilityByVariant(
  rows: readonly { variantId: string; available: boolean; explicit: boolean }[],
): Map<string, { available: boolean; explicit: boolean }> {
  return new Map(rows.map((r) => [r.variantId, { available: r.available, explicit: r.explicit }]));
}
