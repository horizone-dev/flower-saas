import {
  ATTRIBUTE_KEY_RE,
  ATTRIBUTE_NUMBER_RE,
  ATTRIBUTE_VALUE_COLUMN,
  type AttributeValueType,
} from '@flower/shared-types';
import { DomainError } from '../../common/errors/domain-error.js';

/** A validated typed value ready to persist on `product_attribute_value` — the
 *  exactly-one column + its value (a string for NUMBER, kept as decimal text to
 *  the DB; the DB column is `numeric(18,4)` — no JS float ever authoritative). */
export type ResolvedAttributeValue =
  | { column: 'valueText'; valueText: string }
  | { column: 'valueNumber'; valueNumber: string }
  | { column: 'valueBool'; valueBool: boolean }
  | { column: 'valueDate'; valueDate: string }
  | { column: 'optionId'; optionId: string };

/** The raw per-attribute payload of `PUT /products/:id/attributes`. */
export interface AttributeValueInput {
  attributeDefinitionId: string;
  valueText?: string | null | undefined;
  valueNumber?: string | null | undefined;
  valueBool?: boolean | null | undefined;
  valueDate?: string | null | undefined;
  optionId?: string | null | undefined;
}

export function assertValidAttributeKey(key: string): void {
  if (!ATTRIBUTE_KEY_RE.test(key)) {
    throw new DomainError(
      'INVALID_ATTRIBUTE_KEY',
      'attribute key must match ^[A-Z][A-Z0-9_]{1,63}$',
      422,
      [{ field: 'key', issue: 'invalid format' }],
    );
  }
}

/** at most one of the two scope refs (owner K.7) */
export function assertAtMostOneScope(
  appliesToCategoryId: string | null | undefined,
  appliesToProductTypeId: string | null | undefined,
): void {
  if (
    appliesToCategoryId != null &&
    appliesToCategoryId !== '' &&
    appliesToProductTypeId != null &&
    appliesToProductTypeId !== ''
  ) {
    throw new DomainError(
      'INVALID_ATTRIBUTE_SCOPE',
      'an attribute definition may be scoped to a category OR a product type, not both',
      422,
    );
  }
}

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validate one attribute value payload against the definition's `valueType`
 * (data-integrity rule 3 — the service half). Enforces:
 *   - exactly one of the five value fields is provided (and non-null)
 *   - the provided field is the one this `valueType` requires
 *   - NUMBER is a valid `numeric(18,4)` decimal string (exact, no `parseFloat`)
 *   - DATE is a valid `YYYY-MM-DD`
 * The "option belongs to the same definition" check + the "exactly one column"
 * guarantee also exist at the DB (the ENUM composite FK + the CHECK).
 */
export function resolveAttributeValue(
  valueType: AttributeValueType,
  input: AttributeValueInput,
): ResolvedAttributeValue {
  const provided: { key: keyof AttributeValueInput; raw: unknown }[] = (
    ['valueText', 'valueNumber', 'valueBool', 'valueDate', 'optionId'] as const
  )
    .map((k) => ({ key: k, raw: input[k] }))
    .filter((p) => p.raw !== undefined && p.raw !== null);

  if (provided.length !== 1) {
    throw new DomainError(
      'ATTRIBUTE_VALUE_INVALID',
      `exactly one value field is required for attribute ${input.attributeDefinitionId}`,
      422,
    );
  }
  const { key, raw } = provided[0]!;
  const expected = ATTRIBUTE_VALUE_COLUMN[valueType];
  if (key !== expected) {
    throw new DomainError(
      'ATTRIBUTE_VALUE_TYPE_MISMATCH',
      `a ${valueType} attribute expects "${expected}", got "${key}"`,
      422,
    );
  }

  switch (valueType) {
    case 'TEXT': {
      const v = String(raw);
      if (v.length === 0 || v.length > 4000) {
        throw new DomainError('ATTRIBUTE_VALUE_INVALID', 'TEXT value must be 1–4000 chars', 422);
      }
      return { column: 'valueText', valueText: v };
    }
    case 'NUMBER': {
      const v = String(raw).trim();
      if (!ATTRIBUTE_NUMBER_RE.test(v)) {
        throw new DomainError(
          'ATTRIBUTE_VALUE_INVALID',
          'NUMBER value must be a decimal within numeric(18,4)',
          422,
        );
      }
      return { column: 'valueNumber', valueNumber: v };
    }
    case 'BOOLEAN': {
      if (typeof raw !== 'boolean') {
        throw new DomainError('ATTRIBUTE_VALUE_INVALID', 'BOOLEAN value must be a boolean', 422);
      }
      return { column: 'valueBool', valueBool: raw };
    }
    case 'DATE': {
      const v = String(raw);
      if (!ISO_DATE_RE.test(v) || Number.isNaN(Date.parse(`${v}T00:00:00Z`))) {
        throw new DomainError('ATTRIBUTE_VALUE_INVALID', 'DATE value must be YYYY-MM-DD', 422);
      }
      return { column: 'valueDate', valueDate: v };
    }
    case 'ENUM': {
      const v = String(raw);
      if (v.length === 0) {
        throw new DomainError('ATTRIBUTE_VALUE_INVALID', 'ENUM value requires an optionId', 422);
      }
      return { column: 'optionId', optionId: v };
    }
  }
}
