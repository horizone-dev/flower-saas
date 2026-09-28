import { DomainError } from '../../common/errors/domain-error.js';
import { MAX_CSV_ROWS } from './dto/import-settlement-lines-csv.dto.js';

/** The ONE normalized CSV column contract — generic, never provider-specific
 *  (no Tap/Stripe/etc. field names). Maps 1:1 onto the same manual-line input
 *  shape (`add-settlement-line.dto.ts`) plus nothing else — Batch alone owns
 *  scope/currency/lineKind. Exact header, exact order, exactly 3 columns. */
export const SETTLEMENT_CSV_COLUMNS = [
  'externalLineId',
  'providerReference',
  'amountMinor',
] as const;

export interface NormalizedCsvLine {
  externalLineId: string | null;
  providerReference: string | null;
  amountMinor: bigint;
}

function csvError(message: string): DomainError {
  return new DomainError('SETTLEMENT_CSV_INVALID', message, 422);
}

/**
 * Parses + fully validates a normalized settlement CSV, all-or-nothing — a
 * SINGLE bad row rejects the entire file, no partial result is ever
 * returned. Never persists the raw text; the caller discards `csvContent`
 * once this returns. A simple comma-split contract (no quoted-field/embedded-
 * comma support) — this is an internal NORMALIZED format, never a raw
 * provider export.
 */
export function parseAndValidateSettlementCsv(csvContent: string): NormalizedCsvLine[] {
  const rawLines = csvContent.split(/\r\n|\r|\n/).filter((l) => l.length > 0);
  if (rawLines.length === 0) {
    throw csvError('CSV is empty');
  }
  const header = rawLines[0]!.split(',').map((h) => h.trim());
  if (
    header.length !== SETTLEMENT_CSV_COLUMNS.length ||
    !SETTLEMENT_CSV_COLUMNS.every((col, i) => header[i] === col)
  ) {
    throw csvError(`malformed header — expected exactly "${SETTLEMENT_CSV_COLUMNS.join(',')}"`);
  }

  const dataRows = rawLines.slice(1);
  if (dataRows.length === 0) {
    throw csvError('CSV has a header but zero data rows');
  }
  if (dataRows.length > MAX_CSV_ROWS) {
    throw csvError(`CSV has ${dataRows.length} rows, exceeding the ${MAX_CSV_ROWS}-row limit`);
  }

  const seenExternalLineIds = new Set<string>();
  const result: NormalizedCsvLine[] = [];
  for (const [idx, line] of dataRows.entries()) {
    const rowNumber = idx + 2; // 1-based, +1 for the header row
    const fields = line.split(',');
    if (fields.length !== SETTLEMENT_CSV_COLUMNS.length) {
      throw csvError(
        `row ${rowNumber}: expected ${SETTLEMENT_CSV_COLUMNS.length} columns, got ${fields.length}`,
      );
    }
    const [externalLineIdRaw, providerReferenceRaw, amountMinorRaw] = fields.map((f) => f.trim());

    if (!amountMinorRaw || !/^[1-9]\d*$/.test(amountMinorRaw)) {
      throw csvError(`row ${rowNumber}: amountMinor must be a positive decimal-digit string`);
    }
    const amountMinor = BigInt(amountMinorRaw);

    const externalLineId = externalLineIdRaw ? externalLineIdRaw : null;
    const providerReference = providerReferenceRaw ? providerReferenceRaw : null;

    if (externalLineId !== null) {
      if (seenExternalLineIds.has(externalLineId)) {
        throw csvError(
          `row ${rowNumber}: duplicate externalLineId "${externalLineId}" within the same file`,
        );
      }
      seenExternalLineIds.add(externalLineId);
    }

    result.push({ externalLineId, providerReference, amountMinor });
  }
  return result;
}
