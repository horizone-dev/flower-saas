import { demoCatalog } from './demo-catalog';
import type { StorefrontCatalogPort } from './types';

export type * from './types';

/**
 * The catalog the storefront reads. It is the DEMO catalog until a shopper-facing contract exists (see docs/mvp/CUSTOMER-WEB-STOREFRONT.md): there is
 * deliberately no environment switch, no staff token and no API call here — a live adapter is a separate, reviewed change.
 */
export function getCatalog(): StorefrontCatalogPort {
  return demoCatalog;
}
