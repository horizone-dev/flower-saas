import { describe, expect, it } from 'vitest';
import { assertSanitizedMetadataShape } from './sanitized-metadata.js';

/**
 * Task 3b.5 Checkpoint G §G23 — adversarial key-shape + size-bound proofs
 * for the `sanitizedMetadata` guard. Business processing never reads this
 * field at all (proven structurally — `WebhookEventProcessorRepository`
 * never imports it); this guard exists ONLY to bound what an adapter may
 * attach as informational context, never to make arbitrary provider JSON
 * "safe" for storage.
 */
describe('assertSanitizedMetadataShape (task 3b.5 Checkpoint G §G23)', () => {
  it('accepts a bounded, plain, sensitive-key-free object', () => {
    expect(() =>
      assertSanitizedMetadataShape({ chargeStatus: 'succeeded', attempts: 1 }),
    ).not.toThrow();
  });

  it('rejects non-object / array / null values', () => {
    expect(() => assertSanitizedMetadataShape(null)).toThrow(RangeError);
    expect(() => assertSanitizedMetadataShape('x')).toThrow(RangeError);
    expect(() => assertSanitizedMetadataShape(42)).toThrow(RangeError);
    expect(() => assertSanitizedMetadataShape([1, 2, 3])).toThrow(RangeError);
  });

  it('enforces the 4KB bound', () => {
    const big = { blob: 'x'.repeat(5000) };
    expect(() => assertSanitizedMetadataShape(big)).toThrow(/4096-byte bound/);
    const small = { blob: 'x'.repeat(100) };
    expect(() => assertSanitizedMetadataShape(small)).not.toThrow();
  });

  // owner §G23 — every listed key shape, including case/format variations.
  const forbiddenKeys = [
    'pan',
    'PAN',
    'cardNumber',
    'card_number',
    'card-number',
    'CardNumber',
    'cvv',
    'CVV',
    'cvc',
    'CVC',
    'apiKey',
    'api_key',
    'api-key',
    'API_KEY',
    'secret',
    'clientSecret',
    'authorization',
    'Authorization',
    'signature',
    'webhookSignature',
  ];
  for (const key of forbiddenKeys) {
    it(`rejects a sensitive-shaped key: "${key}"`, () => {
      expect(() => assertSanitizedMetadataShape({ [key]: 'x' })).toThrow(RangeError);
    });
  }

  it('a benign key that merely CONTAINS an unrelated substring is not falsely rejected', () => {
    // "cardBrand"/"last4" are legitimate, non-sensitive operator context —
    // this guard targets specific sensitive SHAPES, not the word "card"
    // wholesale.
    expect(() => assertSanitizedMetadataShape({ cardBrand: 'visa', last4: '4242' })).not.toThrow();
  });

  // ══════════════ Checkpoint G proof pass §4 — nested sensitive-key safety
  // (CASE B: nested objects/arrays ARE accepted by the top-level shape
  // check — only `null`/non-object/a TOP-LEVEL array is rejected — so
  // filtering MUST be recursive, or a nested `cardNumber` would silently
  // survive into durable storage). ═══════════════════════════════════════
  describe('nested sensitive-key filtering is recursive', () => {
    it('rejects a sensitive key nested one level deep', () => {
      expect(() =>
        assertSanitizedMetadataShape({ card: { cardNumber: '4242424242424242', cvv: '123' } }),
      ).toThrow(RangeError);
    });

    it('rejects a sensitive key nested inside an array of objects', () => {
      expect(() =>
        assertSanitizedMetadataShape({
          attempts: [{ status: 'ok' }, { status: 'retry', secret: 'sk_live_x' }],
        }),
      ).toThrow(RangeError);
    });

    it('rejects a sensitive key several levels deep', () => {
      expect(() =>
        assertSanitizedMetadataShape({
          provider: { raw: { headers: { authorization: 'Bearer x' } } },
        }),
      ).toThrow(RangeError);
    });

    it('accepts a deeply nested object with no sensitive-shaped key anywhere', () => {
      expect(() =>
        assertSanitizedMetadataShape({
          card: { brand: 'visa', last4: '4242' },
          attempts: [{ status: 'ok' }, { status: 'retry', reason: 'network' }],
        }),
      ).not.toThrow();
    });

    it('the 4KB bound is still enforced even when the payload is deeply nested', () => {
      const big = { card: { note: 'x'.repeat(5000) } };
      expect(() => assertSanitizedMetadataShape(big)).toThrow(/4096-byte bound/);
    });
  });
});
