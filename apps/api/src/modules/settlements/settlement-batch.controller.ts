import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam } from '../../common/auth/pipeline.decorators.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { assertUuid, parseIfMatch, requireIfMatch } from '../catalog/catalog-write.helpers.js';
import { SettlementBatchService } from './settlement-batch.service.js';
import type { SettlementBatchRow, SettlementLineRow } from './settlement-batch.repository.js';
import {
  createSettlementBatchSchema,
  type CreateSettlementBatchDto,
} from './dto/create-settlement-batch.dto.js';
import {
  editSettlementBatchSchema,
  type EditSettlementBatchDto,
} from './dto/edit-settlement-batch.dto.js';
import {
  addSettlementLineSchema,
  type AddSettlementLineDto,
} from './dto/add-settlement-line.dto.js';
import {
  importSettlementLinesCsvSchema,
  type ImportSettlementLinesCsvDto,
} from './dto/import-settlement-lines-csv.dto.js';
import {
  matchSettlementLineSchema,
  type MatchSettlementLineDto,
} from './dto/match-settlement-line.dto.js';

function parseLimit(raw: string | undefined): number {
  if (raw === undefined) return 50;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0 || n > 200) {
    throw new DomainError('INVALID_LIMIT', 'limit must be an integer between 1 and 200', 400);
  }
  return n;
}

/** Never exposes credential secrets / raw provider payload / internal
 *  journal-linkage detail — `journalEntryId`/`finalizedAt` are always NULL in
 *  Checkpoint C (no finalize route exists yet) but are still surfaced as
 *  plain booleans-of-presence-safe fields since they carry no secret. */
function serializeBatch(row: SettlementBatchRow) {
  return {
    id: row.id,
    companyId: row.companyId,
    branchId: row.branchId,
    providerCredentialId: row.providerCredentialId,
    externalSettlementId: row.externalSettlementId,
    providerSettlementDate: row.providerSettlementDate.toISOString().slice(0, 10),
    grossSettlementMinor: row.grossSettlementMinor.toString(),
    providerFeeMinor: row.providerFeeMinor.toString(),
    netBankMinor: row.netBankMinor.toString(),
    currencyCode: row.currencyCode,
    currencyExponent: row.currencyExponent,
    state: row.state,
    version: row.version,
    journalEntryId: row.journalEntryId,
    finalizedAt: row.finalizedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function serializeLine(row: SettlementLineRow) {
  return {
    id: row.id,
    batchId: row.batchId,
    externalLineId: row.externalLineId,
    providerReference: row.providerReference,
    amountMinor: row.amountMinor.toString(),
    currencyCode: row.currencyCode,
    currencyExponent: row.currencyExponent,
    matchedPaymentId: row.matchedPaymentId,
    lineKind: row.lineKind,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * `/v1/companies/:companyId/branches/:branchId/settlements` — task 3b.7
 * Checkpoint C. DRAFT SettlementBatch/Line application service ONLY: create/
 * edit/list/detail, manual + normalized-CSV line ingestion, provider-
 * reference auto-match + explicit match/unmatch. NO finalization route, NO
 * SettlementApplication write, NO journal posting, NO Invoice mutation
 * anywhere in this controller (Checkpoint D).
 */
@Controller('companies/:companyId/branches/:branchId/settlements')
export class SettlementBatchController {
  constructor(private readonly settlements: SettlementBatchService) {}

  @Post()
  @RequirePermission('settlements:manage')
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  @Idempotent({ scope: 'settlements.batch_create' })
  async create(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body(new ZodBody(createSettlementBatchSchema)) dto: CreateSettlementBatchDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    if (!idempotencyKeyHeader) {
      throw new DomainError(
        'IDEMPOTENCY_MISCONFIGURED',
        'idempotency requires an authenticated tenant user',
        500,
      );
    }
    const created = await this.settlements.create({
      companyId,
      branchId,
      providerCredentialId: dto.providerCredentialId,
      externalSettlementId: dto.externalSettlementId,
      providerSettlementDate: dto.providerSettlementDate,
      grossSettlementMinor: BigInt(dto.grossSettlementMinor),
      providerFeeMinor: BigInt(dto.providerFeeMinor),
      netBankMinor: BigInt(dto.netBankMinor),
      currencyCode: dto.currencyCode,
    });
    return serializeBatch(created);
  }

  @Patch(':id')
  @RequirePermission('settlements:manage')
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async edit(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(editSettlementBatchSchema)) dto: EditSettlementBatchDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(id, 'settlement batch');
    const expectedVersion = requireIfMatch(parseIfMatch(ifMatch));
    const updated = await this.settlements.edit({
      companyId,
      branchId,
      id,
      expectedVersion,
      ...(dto.providerSettlementDate !== undefined
        ? { providerSettlementDate: dto.providerSettlementDate }
        : {}),
      ...(dto.grossSettlementMinor !== undefined
        ? { grossSettlementMinor: BigInt(dto.grossSettlementMinor) }
        : {}),
      ...(dto.providerFeeMinor !== undefined
        ? { providerFeeMinor: BigInt(dto.providerFeeMinor) }
        : {}),
      ...(dto.netBankMinor !== undefined ? { netBankMinor: BigInt(dto.netBankMinor) } : {}),
    });
    return serializeBatch(updated);
  }

  @Get()
  @RequirePermission('settlements:view')
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async list(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('limit') limit: string | undefined,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    const result = await this.settlements.list({
      companyId,
      branchId,
      cursor: cursor ?? null,
      limit: parseLimit(limit),
    });
    return {
      items: result.items.map(serializeBatch),
      nextCursor: result.nextCursor,
      hasMore: result.hasMore,
    };
  }

  @Get(':id')
  @RequirePermission('settlements:view')
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async detail(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(id, 'settlement batch');
    const result = await this.settlements.detail({ companyId, branchId, id });
    return {
      batch: serializeBatch(result.batch),
      lines: result.lines.map(serializeLine),
      lineCount: result.lineCount,
      matchedCount: result.matchedCount,
      unmatchedCount: result.unmatchedCount,
    };
  }

  @Post(':id/lines')
  @RequirePermission('settlements:manage')
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async addLine(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(addSettlementLineSchema)) dto: AddSettlementLineDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(id, 'settlement batch');
    const expectedVersion = requireIfMatch(parseIfMatch(ifMatch));
    const result = await this.settlements.addLine({
      companyId,
      branchId,
      batchId: id,
      expectedVersion,
      externalLineId: dto.externalLineId ?? null,
      providerReference: dto.providerReference ?? null,
      amountMinor: BigInt(dto.amountMinor),
    });
    return { batch: serializeBatch(result.batch), line: serializeLine(result.line) };
  }

  @Post(':id/lines/import')
  @HttpCode(200)
  @RequirePermission('settlements:manage')
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  @Idempotent({ scope: 'settlements.line_csv_import' })
  async importLines(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('idempotency-key') idempotencyKeyHeader: string | undefined,
    @Body(new ZodBody(importSettlementLinesCsvSchema)) dto: ImportSettlementLinesCsvDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(id, 'settlement batch');
    if (!idempotencyKeyHeader) {
      throw new DomainError(
        'IDEMPOTENCY_MISCONFIGURED',
        'idempotency requires an authenticated tenant user',
        500,
      );
    }
    const expectedVersion = requireIfMatch(parseIfMatch(ifMatch));
    const result = await this.settlements.importCsv({
      companyId,
      branchId,
      batchId: id,
      expectedVersion,
      csvContent: dto.csvContent,
    });
    return {
      batch: serializeBatch(result.batch),
      insertedLineIds: result.insertedLineIds,
      insertedCount: result.insertedLineIds.length,
    };
  }

  @Post(':id/lines/:lineId/match')
  @HttpCode(200)
  @RequirePermission('settlements:manage')
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async matchLine(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(matchSettlementLineSchema)) dto: MatchSettlementLineDto,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(id, 'settlement batch');
    assertUuid(lineId, 'settlement line');
    const expectedVersion = requireIfMatch(parseIfMatch(ifMatch));
    const result = await this.settlements.matchLine({
      companyId,
      branchId,
      batchId: id,
      lineId,
      expectedVersion,
      proposedPaymentId: dto.paymentId,
    });
    void reply.header('etag', `"${result.batch.version}"`);
    return { batch: serializeBatch(result.batch), line: serializeLine(result.line) };
  }

  @Post(':id/lines/:lineId/unmatch')
  @HttpCode(200)
  @RequirePermission('settlements:manage')
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async unmatchLine(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('id') id: string,
    @Param('lineId') lineId: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(id, 'settlement batch');
    assertUuid(lineId, 'settlement line');
    const expectedVersion = requireIfMatch(parseIfMatch(ifMatch));
    const result = await this.settlements.unmatchLine({
      companyId,
      branchId,
      batchId: id,
      lineId,
      expectedVersion,
    });
    void reply.header('etag', `"${result.batch.version}"`);
    return { batch: serializeBatch(result.batch), line: serializeLine(result.line) };
  }

  /**
   * Task 3b.7 Checkpoint D — settlement finalization. `settlements:finalize`
   * is step-up gated (Checkpoint C's own `STEP_UP_PERMISSIONS` registration)
   * — no `@NoStepUp()` here, so the existing guard pipeline enforces it
   * automatically, exactly like `accounting:period:manage`'s own
   * `closePeriod` route. No request body — every field the finalize
   * transaction needs is derived entirely from the already-normalized DRAFT
   * Batch/Lines; the caller supplies only the target id and `If-Match`.
   */
  @Post(':id/finalize')
  @HttpCode(200)
  @RequirePermission('settlements:finalize')
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async finalize(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(id, 'settlement batch');
    const expectedVersion = requireIfMatch(parseIfMatch(ifMatch));
    const finalized = await this.settlements.finalize({
      companyId,
      branchId,
      id,
      expectedVersion,
    });
    void reply.header('etag', `"${finalized.version}"`);
    return serializeBatch(finalized);
  }
}
