/**
 * VAT fail-closed guard (finding F-6). A sale line the server priced with NO tax category carries `taxCategoryKey === null`, and the frozen
 * sale path then records 0 tax for it — a missing classification silently becoming "0% VAT". The till refuses to take payment for such a
 * line until the owner classifies the product.
 *
 * This is a DEFENCE-IN-DEPTH display rule over facts the SERVER returned (the order lines). It decides nothing about tax: a legitimately
 * zero-rated or exempt product carries an explicit category (`ZERO_RATED` / `EXEMPT`) and passes. The authoritative refusal belongs to the
 * API (see docs/decisions/proposed-migrations/DRAFT-F6-*.patch) — until it is approved, a direct API call can still bypass this.
 */

export interface VatLine {
  taxCategoryKey: string | null;
  productNameEnSnapshot: string;
  variantNameEnSnapshot: string;
}

/** the lines that have no explicit tax category (empty/blank is treated as missing — fail closed) */
export function unclassifiedLines<T extends VatLine>(lines: readonly T[]): T[] {
  return lines.filter((l) => l.taxCategoryKey === null || l.taxCategoryKey.trim() === '');
}

/** a stable, de-duplicated, cashier-readable list of what must be fixed */
export function unclassifiedLabels(lines: readonly VatLine[]): string[] {
  const out: string[] = [];
  for (const l of unclassifiedLines(lines)) {
    const label =
      l.variantNameEnSnapshot && l.variantNameEnSnapshot !== l.productNameEnSnapshot
        ? `${l.productNameEnSnapshot} (${l.variantNameEnSnapshot})`
        : l.productNameEnSnapshot;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

export function vatBlockMessage(labels: readonly string[]): string {
  return `Cannot take payment: no VAT category is set for ${labels.join(', ')}. Ask the owner to set the VAT category (Standard, Zero-rated or Exempt) in Owner Web, then try again.`;
}
