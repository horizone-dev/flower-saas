import { describe, expect, it } from 'vitest';
import { unclassifiedLabels, unclassifiedLines, vatBlockMessage } from './tax-guard';

const L = (key: string | null, product = 'Tulip', variant = 'Tulip'): never =>
  ({
    taxCategoryKey: key,
    productNameEnSnapshot: product,
    variantNameEnSnapshot: variant,
  }) as never;

describe('VAT fail-closed guard (F-6)', () => {
  it('flags a line with no tax category', () => {
    expect(unclassifiedLines([L(null)])).toHaveLength(1);
  });

  it('treats a blank category as missing (fail closed)', () => {
    expect(unclassifiedLines([L(''), L('   ')])).toHaveLength(2);
  });

  it('lets explicit STANDARD, ZERO_RATED, EXEMPT and REDUCED through — zero-rated / exempt are legitimate', () => {
    expect(
      unclassifiedLines([L('STANDARD'), L('ZERO_RATED'), L('EXEMPT'), L('REDUCED')]),
    ).toHaveLength(0);
  });

  it('only the unclassified lines of a mixed cart are returned', () => {
    const lines = [L('STANDARD', 'Rose', 'Rose'), L(null, 'Peony', 'Peony')];
    expect(unclassifiedLines(lines)).toEqual([lines[1]]);
  });

  it('labels are de-duplicated and show the variant only when it differs', () => {
    expect(
      unclassifiedLabels([
        L(null, 'Peony', 'Peony'),
        L(null, 'Peony', 'Peony'),
        L(null, 'Bouquet', 'Large'),
      ]),
    ).toEqual(['Peony', 'Bouquet (Large)']);
  });

  it('the message tells the cashier what to do and names the product', () => {
    const m = vatBlockMessage(['Peony']);
    expect(m).toContain('Peony');
    expect(m).toContain('VAT category');
  });
});
