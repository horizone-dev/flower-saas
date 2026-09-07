import { describe, it, expect } from 'vitest';
import {
  assertAtMostOneScope,
  assertValidAttributeKey,
  resolveAttributeValue,
  type AttributeValueInput,
} from './attribute.helpers.js';

const thrown = (fn: () => unknown): { code?: string; status?: number } | undefined => {
  try {
    fn();
    return undefined;
  } catch (e) {
    return e as { code?: string; status?: number };
  }
};

const inp = (over: Partial<AttributeValueInput>): AttributeValueInput => ({
  attributeDefinitionId: '00000000-0000-7000-8000-0000000000ad',
  ...over,
});

describe('attribute.helpers', () => {
  it('assertValidAttributeKey: SCREAMING_SNAKE only', () => {
    assertValidAttributeKey('PERFUME_VOLUME');
    expect(thrown(() => assertValidAttributeKey('lower'))?.code).toBe('INVALID_ATTRIBUTE_KEY');
    expect(thrown(() => assertValidAttributeKey('X'))?.code).toBe('INVALID_ATTRIBUTE_KEY');
    expect(thrown(() => assertValidAttributeKey('HAS SPACE'))?.code).toBe('INVALID_ATTRIBUTE_KEY');
  });

  it('assertAtMostOneScope: both set -> 422; one or none -> ok', () => {
    assertAtMostOneScope(null, null);
    assertAtMostOneScope('cat', null);
    assertAtMostOneScope(null, 'pt');
    const e = thrown(() => assertAtMostOneScope('cat', 'pt'));
    expect(e?.code).toBe('INVALID_ATTRIBUTE_SCOPE');
    expect(e?.status).toBe(422);
  });

  it('resolveAttributeValue: each value type accepts only its own column', () => {
    expect(resolveAttributeValue('TEXT', inp({ valueText: 'Rose' }))).toEqual({
      column: 'valueText',
      valueText: 'Rose',
    });
    expect(resolveAttributeValue('NUMBER', inp({ valueNumber: '100.5000' }))).toEqual({
      column: 'valueNumber',
      valueNumber: '100.5000',
    });
    expect(resolveAttributeValue('BOOLEAN', inp({ valueBool: true }))).toEqual({
      column: 'valueBool',
      valueBool: true,
    });
    expect(resolveAttributeValue('DATE', inp({ valueDate: '2026-09-07' }))).toEqual({
      column: 'valueDate',
      valueDate: '2026-09-07',
    });
    expect(
      resolveAttributeValue('ENUM', inp({ optionId: '00000000-0000-7000-8000-0000000000e1' })),
    ).toEqual({ column: 'optionId', optionId: '00000000-0000-7000-8000-0000000000e1' });
  });

  it('resolveAttributeValue: type mismatch -> ATTRIBUTE_VALUE_TYPE_MISMATCH', () => {
    expect(thrown(() => resolveAttributeValue('NUMBER', inp({ valueText: 'x' })))?.code).toBe(
      'ATTRIBUTE_VALUE_TYPE_MISMATCH',
    );
    expect(thrown(() => resolveAttributeValue('ENUM', inp({ valueText: 'RED' })))?.code).toBe(
      'ATTRIBUTE_VALUE_TYPE_MISMATCH',
    );
  });

  it('resolveAttributeValue: zero or two value fields -> ATTRIBUTE_VALUE_INVALID', () => {
    expect(thrown(() => resolveAttributeValue('TEXT', inp({})))?.code).toBe(
      'ATTRIBUTE_VALUE_INVALID',
    );
    expect(
      thrown(() => resolveAttributeValue('TEXT', inp({ valueText: 'x', valueBool: true })))?.code,
    ).toBe('ATTRIBUTE_VALUE_INVALID');
  });

  it('resolveAttributeValue: NUMBER must fit numeric(18,4) exactly (no JS float)', () => {
    expect(
      thrown(() => resolveAttributeValue('NUMBER', inp({ valueNumber: '1.234567' })))?.code,
    ).toBe('ATTRIBUTE_VALUE_INVALID');
    expect(thrown(() => resolveAttributeValue('NUMBER', inp({ valueNumber: '1e10' })))?.code).toBe(
      'ATTRIBUTE_VALUE_INVALID',
    );
    expect(thrown(() => resolveAttributeValue('NUMBER', inp({ valueNumber: 'abc' })))?.code).toBe(
      'ATTRIBUTE_VALUE_INVALID',
    );
  });

  it('resolveAttributeValue: DATE must be YYYY-MM-DD', () => {
    expect(
      thrown(() => resolveAttributeValue('DATE', inp({ valueDate: '07/09/2026' })))?.code,
    ).toBe('ATTRIBUTE_VALUE_INVALID');
    expect(
      thrown(() => resolveAttributeValue('DATE', inp({ valueDate: '2026-13-40' })))?.code,
    ).toBe('ATTRIBUTE_VALUE_INVALID');
  });
});
