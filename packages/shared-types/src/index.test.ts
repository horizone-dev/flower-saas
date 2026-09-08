import { describe, it, expect } from 'vitest';
import {
  moneyDtoSchema,
  quantityDtoSchema,
  apiErrorSchema,
  readinessResponseSchema,
  CATALOG_CAPABILITY_KEYS,
  capabilityKeySchema,
  isCapabilityKey,
  CATALOG_CAPABILITY_CONFIG_SCHEMAS,
  checkCapabilityConfig,
  CAPABILITY_REQUIRED_ENTITLEMENT,
  ENTITLEMENT_MODULES,
  FULFILMENT_STRATEGIES,
  fulfilmentStrategySchema,
  isFulfilmentStrategy,
  CAPABILITY_OF_STRATEGY,
  MAX_CATEGORY_DEPTH,
  PRODUCT_STATUSES,
  CATALOG_NODE_STATUSES,
  ATTRIBUTE_VALUE_TYPES,
  attributeValueTypeSchema,
  isAttributeValueType,
  ATTRIBUTE_VALUE_COLUMN,
  ATTRIBUTE_DEFINITION_STATUSES,
  ATTRIBUTE_KEY_RE,
  ATTRIBUTE_NUMBER_RE,
  VARIANT_STATUSES,
  OPTION_GROUP_KEY_RE,
  OPTION_VALUE_RE,
  STRATEGIES_WITH_FIXED_VARIANTS,
  usesFixedVariants,
  variantOptionSignature,
  IDENTIFIER_CODE_TYPES,
  IDENTIFIER_STATUSES,
  ACTIVE_IDENTIFIER_TARGET_KINDS,
  RESERVED_IDENTIFIER_TARGET_KIND_INVENTORY_ITEM,
  IDENTIFIER_VALUE_MAX_LENGTH,
  SKU_VALUE_RE,
  QR_VALUE_RE,
  canonicalizeSku,
  isValidBarcodeValue,
} from './index.js';

describe('@flower/shared-types schemas', () => {
  it('re-exports the authoritative Money DTO schema (currency + range aware)', () => {
    expect(
      moneyDtoSchema.safeParse({ amountMinor: '10500', currency: 'KWD', exponent: 3 }).success,
    ).toBe(true);
    expect(
      moneyDtoSchema.safeParse({ amountMinor: '10.5', currency: 'AED', exponent: 2 }).success,
    ).toBe(false);
    // exponent must match the currency; 'AED' is exponent 2
    expect(
      moneyDtoSchema.safeParse({ amountMinor: '1', currency: 'AED', exponent: 5 }).success,
    ).toBe(false);
  });

  it('re-exports the Quantity DTO schema', () => {
    expect(quantityDtoSchema.safeParse({ amount: '1.5000' }).success).toBe(true);
    expect(quantityDtoSchema.safeParse({ amount: 1.5 }).success).toBe(false);
  });

  it('validates the API error envelope', () => {
    const parsed = apiErrorSchema.safeParse({
      error: { code: 'ORDER_NOT_FOUND', message: 'Not found', correlationId: '01J' },
    });
    expect(parsed.success).toBe(true);
  });

  it('validates a readiness response', () => {
    expect(
      readinessResponseSchema.safeParse({
        status: 'ok',
        checks: { db: 'ok', redis: 'ok', storage: 'ok', migrations: 'ok' },
      }).success,
    ).toBe(true);
  });
});

describe('@flower/shared-types — catalog capabilities (task 3.1)', () => {
  it('the closed registry has exactly the frozen 16 keys, deduped', () => {
    expect(CATALOG_CAPABILITY_KEYS).toHaveLength(16);
    expect(new Set(CATALOG_CAPABILITY_KEYS).size).toBe(16);
    expect([...CATALOG_CAPABILITY_KEYS].sort()).toEqual(
      [
        'branch_pricing',
        'channel.customer_web',
        'channel.pos',
        'customer_ordering',
        'delivery',
        'identifiers.barcode_qr',
        'inventory.expiry',
        'inventory.lot_batch',
        'inventory.tracked',
        'multi_uom',
        'production',
        'purchasing',
        'strategy.bom',
        'strategy.custom',
        'strategy.stocked',
        'variants',
      ].sort(),
    );
  });

  it('does NOT contain template/provenance concepts as capability keys', () => {
    for (const k of CATALOG_CAPABILITY_KEYS) {
      expect(k.startsWith('category_template')).toBe(false);
      expect(k.startsWith('attribute_template')).toBe(false);
      expect(k.startsWith('uom_template')).toBe(false);
    }
  });

  it('capabilityKeySchema + isCapabilityKey accept only registry keys', () => {
    expect(capabilityKeySchema.safeParse('multi_uom').success).toBe(true);
    expect(capabilityKeySchema.safeParse('category_template.flowers').success).toBe(false);
    expect(isCapabilityKey('strategy.bom')).toBe(true);
    expect(isCapabilityKey('nonsense')).toBe(false);
  });

  it('the config-schema registry is EMPTY in task 3.1 (spec §E)', () => {
    expect(Object.keys(CATALOG_CAPABILITY_CONFIG_SCHEMAS)).toHaveLength(0);
  });

  it('checkCapabilityConfig: null OK; a non-null config for an unregistered key is rejected', () => {
    expect(checkCapabilityConfig('multi_uom', null)).toEqual({ ok: true });
    expect(checkCapabilityConfig('multi_uom', undefined)).toEqual({ ok: true });
    const bad = checkCapabilityConfig('inventory.expiry', { policy: 'FEFO' });
    expect(bad).toMatchObject({ ok: false, code: 'CAPABILITY_CONFIG_NOT_SUPPORTED' });
  });

  it('every required-entitlement value is a real ENTITLEMENT_MODULE, and custom_composition exists', () => {
    expect(ENTITLEMENT_MODULES).toContain('custom_composition');
    const mods = new Set<string>(ENTITLEMENT_MODULES);
    for (const [cap, mod] of Object.entries(CAPABILITY_REQUIRED_ENTITLEMENT)) {
      expect(isCapabilityKey(cap)).toBe(true);
      expect(mods.has(mod as string), `${cap} -> ${mod}`).toBe(true);
    }
    expect(CAPABILITY_REQUIRED_ENTITLEMENT['strategy.custom']).toBe('custom_composition');
    expect(CAPABILITY_REQUIRED_ENTITLEMENT['strategy.stocked']).toBeUndefined();
  });
});

describe('@flower/shared-types — generic catalog core (task 3.2)', () => {
  it('the frozen fulfilment strategies are exactly STOCKED / BOM / CUSTOM', () => {
    expect([...FULFILMENT_STRATEGIES]).toEqual(['STOCKED', 'BOM', 'CUSTOM']);
    expect(fulfilmentStrategySchema.safeParse('BOM').success).toBe(true);
    expect(fulfilmentStrategySchema.safeParse('KIT').success).toBe(false);
    expect(isFulfilmentStrategy('CUSTOM')).toBe(true);
    expect(isFulfilmentStrategy('flower')).toBe(false);
  });

  it('CAPABILITY_OF_STRATEGY maps each strategy to its strategy.* capability key', () => {
    expect(CAPABILITY_OF_STRATEGY).toEqual({
      STOCKED: 'strategy.stocked',
      BOM: 'strategy.bom',
      CUSTOM: 'strategy.custom',
    });
    for (const cap of Object.values(CAPABILITY_OF_STRATEGY)) {
      expect(isCapabilityKey(cap)).toBe(true);
    }
  });

  it('category tree depth is capped at 5 (root = 1); status enums are closed', () => {
    expect(MAX_CATEGORY_DEPTH).toBe(5);
    expect([...PRODUCT_STATUSES]).toEqual(['DRAFT', 'ACTIVE', 'ARCHIVED']);
    expect([...CATALOG_NODE_STATUSES]).toEqual(['ACTIVE', 'ARCHIVED']);
    // a category / product type is never a DRAFT (owner §12)
    expect(CATALOG_NODE_STATUSES).not.toContain('DRAFT');
  });
});

describe('@flower/shared-types — typed attributes (task 3.3)', () => {
  it('the closed value-type set is exactly TEXT / NUMBER / ENUM / BOOLEAN / DATE — no MULTISELECT', () => {
    expect([...ATTRIBUTE_VALUE_TYPES]).toEqual(['TEXT', 'NUMBER', 'ENUM', 'BOOLEAN', 'DATE']);
    expect(ATTRIBUTE_VALUE_TYPES).not.toContain('MULTISELECT');
    expect(attributeValueTypeSchema.safeParse('ENUM').success).toBe(true);
    expect(attributeValueTypeSchema.safeParse('MULTISELECT').success).toBe(false);
    expect(isAttributeValueType('DATE')).toBe(true);
    expect(isAttributeValueType('json')).toBe(false);
  });

  it('each value type maps to exactly one product_attribute_value column', () => {
    expect(ATTRIBUTE_VALUE_COLUMN).toEqual({
      TEXT: 'valueText',
      NUMBER: 'valueNumber',
      BOOLEAN: 'valueBool',
      DATE: 'valueDate',
      ENUM: 'optionId',
    });
    expect(new Set(Object.values(ATTRIBUTE_VALUE_COLUMN)).size).toBe(5);
  });

  it('attribute definitions are ACTIVE ↔ ARCHIVED only (no DRAFT); key + number regexes', () => {
    expect([...ATTRIBUTE_DEFINITION_STATUSES]).toEqual(['ACTIVE', 'ARCHIVED']);
    expect(ATTRIBUTE_KEY_RE.test('PERFUME_VOLUME')).toBe(true);
    expect(ATTRIBUTE_KEY_RE.test('lower')).toBe(false);
    expect(ATTRIBUTE_KEY_RE.test('X')).toBe(false);
    expect(ATTRIBUTE_NUMBER_RE.test('100')).toBe(true);
    expect(ATTRIBUTE_NUMBER_RE.test('-12.3456')).toBe(true);
    expect(ATTRIBUTE_NUMBER_RE.test('1.23456')).toBe(false); // > 4 dp
    expect(ATTRIBUTE_NUMBER_RE.test('1e5')).toBe(false);
  });
});

describe('@flower/shared-types — variants + option groups (task 3.4)', () => {
  it('variant lifecycle is DRAFT → ACTIVE ↔ ARCHIVED; key + value token regexes', () => {
    expect([...VARIANT_STATUSES]).toEqual(['DRAFT', 'ACTIVE', 'ARCHIVED']);
    expect(OPTION_GROUP_KEY_RE.test('COLOUR')).toBe(true);
    expect(OPTION_GROUP_KEY_RE.test('SIZE_2')).toBe(true);
    expect(OPTION_GROUP_KEY_RE.test('lower')).toBe(false);
    expect(OPTION_GROUP_KEY_RE.test('X')).toBe(false);
    expect(OPTION_VALUE_RE.test('RED')).toBe(true);
    expect(OPTION_VALUE_RE.test('12-inch')).toBe(true);
    expect(OPTION_VALUE_RE.test('_bad')).toBe(false);
    expect(OPTION_VALUE_RE.test('a b')).toBe(false);
  });

  it('STOCKED / BOM use fixed variants; CUSTOM does not (no literal branch on the string)', () => {
    expect([...STRATEGIES_WITH_FIXED_VARIANTS].sort()).toEqual(['BOM', 'STOCKED']);
    expect(usesFixedVariants('STOCKED')).toBe(true);
    expect(usesFixedVariants('BOM')).toBe(true);
    expect(usesFixedVariants('CUSTOM')).toBe(false);
  });

  it('variantOptionSignature is deterministic and insertion-order-independent (owner L-7)', () => {
    expect(variantOptionSignature([])).toBe('');
    const a = variantOptionSignature([
      { optionGroupId: 'g-colour', optionValueId: 'v-red' },
      { optionGroupId: 'g-size', optionValueId: 'v-m' },
    ]);
    const b = variantOptionSignature([
      { optionGroupId: 'g-size', optionValueId: 'v-m' },
      { optionGroupId: 'g-colour', optionValueId: 'v-red' },
    ]);
    expect(a).toBe(b);
    expect(a).toBe('g-colour=v-red|g-size=v-m');
    // a different value → a different signature
    expect(
      variantOptionSignature([
        { optionGroupId: 'g-colour', optionValueId: 'v-blue' },
        { optionGroupId: 'g-size', optionValueId: 'v-m' },
      ]),
    ).not.toBe(a);
  });
});

describe('@flower/shared-types — identifiers (task 3.5)', () => {
  it('closed code-type + status + target-kind sets; INVENTORY_ITEM is reserved-only', () => {
    expect([...IDENTIFIER_CODE_TYPES]).toEqual(['SKU', 'BARCODE', 'QR']);
    expect([...IDENTIFIER_STATUSES]).toEqual(['ACTIVE', 'INACTIVE']);
    // owner decision 1 — VARIANT is the ONLY active target kind
    expect([...ACTIVE_IDENTIFIER_TARGET_KINDS]).toEqual(['VARIANT']);
    expect(RESERVED_IDENTIFIER_TARGET_KIND_INVENTORY_ITEM).toBe('INVENTORY_ITEM');
    // the reserved value is NOT in the active set
    expect(
      (ACTIVE_IDENTIFIER_TARGET_KINDS as readonly string[]).includes(
        RESERVED_IDENTIFIER_TARGET_KIND_INVENTORY_ITEM,
      ),
    ).toBe(false);
    expect(IDENTIFIER_VALUE_MAX_LENGTH).toBe(128);
  });

  it('canonicalizeSku: trim + locale-independent upper-case; folds case-only differences', () => {
    expect(canonicalizeSku('  abc-1 ')).toBe('ABC-1');
    expect(canonicalizeSku('abc-1')).toBe(canonicalizeSku('ABC-1'));
    expect(SKU_VALUE_RE.test(canonicalizeSku('rose-red.12'))).toBe(true);
    expect(SKU_VALUE_RE.test('rose red')).toBe(false); // space rejected
    expect(SKU_VALUE_RE.test('-lead')).toBe(false); // must start alnum
    expect(SKU_VALUE_RE.test('A'.repeat(65))).toBe(false); // ≤ 64
  });

  it('isValidBarcodeValue: bounded, trimmed, control-char-free, never case-folded', () => {
    expect(isValidBarcodeValue('5901234123457')).toBe(true);
    expect(isValidBarcodeValue('abc-XYZ_123')).toBe(true); // case preserved by caller
    expect(isValidBarcodeValue('')).toBe(false);
    expect(isValidBarcodeValue(' 123')).toBe(false); // leading space
    expect(isValidBarcodeValue('12\t3')).toBe(false); // control char
    expect(isValidBarcodeValue('x'.repeat(129))).toBe(false);
  });

  it('QR_VALUE_RE matches a 40-char upper-hex opaque token', () => {
    expect(QR_VALUE_RE.test('0123456789ABCDEF0123456789ABCDEF01234567')).toBe(true);
    expect(QR_VALUE_RE.test('abcdef0123456789abcdef0123456789abcdef01')).toBe(false); // lower
    expect(QR_VALUE_RE.test('0123')).toBe(false);
  });
});

describe('@flower/shared-types — UOM / pack conversion (task 3.6)', () => {
  it('re-exports the canonical UOM-code semantics from @flower/uom', async () => {
    const m = await import('./index.js');
    expect(m.canonicalUomCode('  BOX ')).toBe('box');
    expect(m.UOM_CODE_RE.test('bag-25kg')).toBe(true);
    expect(m.UOM_CODE_RE.test('box/12')).toBe(false); // no slash
    expect(m.isBuiltinUom('piece')).toBe(true);
    expect(m.isBuiltinUom('box')).toBe(false);
    expect(m.BUILTIN_UOMS.map((u) => u.code).sort()).toContain('milliliter');
  });

  it('the UOM family + conversion-scope enums are closed; there is NO GLOBAL scope', async () => {
    const m = await import('./index.js');
    expect([...m.UOM_FAMILIES].sort()).toEqual(['COUNT', 'EACH', 'LENGTH', 'MASS', 'VOLUME']);
    expect([...m.UOM_CONVERSION_SCOPE_KINDS]).toEqual(['VARIANT', 'PRODUCT']);
    expect(m.uomConversionScopeKindSchema.safeParse('GLOBAL').success).toBe(false);
  });

  it('identifierPackInputSchema requires both packUomCode and packQty, rejects extra keys', async () => {
    const m = await import('./index.js');
    expect(
      m.identifierPackInputSchema.safeParse({ packUomCode: 'box', packQty: '1' }).success,
    ).toBe(true);
    expect(m.identifierPackInputSchema.safeParse({ packUomCode: 'box' }).success).toBe(false);
    expect(
      m.identifierPackInputSchema.safeParse({ packUomCode: 'box', packQty: '1', packBaseQty: '12' })
        .success,
    ).toBe(false);
  });
});
