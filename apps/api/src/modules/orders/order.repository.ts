import { Injectable } from '@nestjs/common';
import type { ScopedTx, Prisma } from '@flower/db';
import { Money, currencyExponent } from '@flower/money';
import {
  Quantity,
  isBuiltinUom,
  UnknownUomError,
  UomFamilyMismatchError,
  UomConversionUnavailableError,
} from '@flower/uom';
import { ScopedRepository, DbService } from '../../common/data/index.js';
import { requireTenantContext, getContext } from '../../common/context/index.js';
import { AuditWriter } from '../../common/audit/audit.writer.js';
import { DomainError, NotFoundError } from '../../common/errors/domain-error.js';
import { isPgError } from '../../common/errors/pg-error.js';
import { SystemClock } from '../../common/clock/clock.js';
import { derivePostingDate } from '../accounting/posting-date.js';
import { loadEffectiveVariantRegistry } from '../catalog/uom.repository.js';
import { BranchPricingService } from '../catalog/branch-pricing.service.js';
import { TaxResolutionService } from '../catalog/tax-resolution.service.js';
import { CustomerRepository } from '../customers/customer.repository.js';
import type { OrderLineInputDto } from './dto/order-line-input.dto.js';
import {
  computeCommercialSnapshotFingerprint,
  type CommercialSnapshotLine,
} from './commercial-snapshot.js';

const PG_FK_VIOLATION = '23503';

export interface OrderRow {
  id: string;
  tenantId: string;
  companyId: string;
  originBranchId: string;
  fulfillingBranchId: string;
  posTerminalId: string | null;
  customerId: string | null;
  kind: string;
  status: string;
  currencyCode: string;
  currencyExponent: number;
  documentDiscountMode: string;
  documentDiscountBps: number | null;
  documentDiscountAmountMinor: bigint;
  documentDiscountReason: string | null;
  orderNumber: string | null;
  version: number;
  commercialSnapshotFingerprint: string;
  createdByUserId: string | null;
  actingUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface OrderLineRow {
  id: string;
  tenantId: string;
  companyId: string;
  orderId: string;
  linePosition: number;
  productId: string;
  variantId: string;
  quantity: string;
  unitPriceAmountMinor: bigint;
  unitPriceCurrencyCode: string;
  unitPriceCurrencyExponent: number;
  discountMode: string;
  discountBps: number | null;
  discountAmountMinor: bigint;
  discountReason: string | null;
  taxCategoryKey: string | null;
  rateBps: number | null;
  effectiveFrom: Date | null;
  resolutionSource: string;
  priceTaxMode: string | null;
  roundingScope: string | null;
  roundingMode: string | null;
  lineTaxAmountMinor: bigint | null;
  productNameEnSnapshot: string;
  productNameArSnapshot: string | null;
  variantNameEnSnapshot: string;
  variantNameArSnapshot: string | null;
  skuSnapshot: string | null;
  selectedUomCode: string;
  uomDisplayLabelSnapshot: string;
  baseUomCode: string;
  conversionNumerator: bigint;
  conversionDenominator: bigint;
  createdAt: Date;
  updatedAt: Date;
}

interface ResolvedLine {
  productId: string;
  variantId: string;
  quantity: string;
  unitPriceAmountMinor: bigint;
  unitPriceCurrencyCode: string;
  unitPriceCurrencyExponent: number;
  discountMode: string;
  discountBps: number | null;
  discountAmountMinor: bigint;
  discountReason: string | null;
  taxCategoryKey: string | null;
  rateBps: number | null;
  effectiveFrom: Date | null;
  resolutionSource: string;
  productNameEnSnapshot: string;
  productNameArSnapshot: string | null;
  variantNameEnSnapshot: string;
  variantNameArSnapshot: string | null;
  skuSnapshot: string | null;
  selectedUomCode: string;
  uomDisplayLabelSnapshot: string;
  baseUomCode: string;
  conversionNumerator: bigint;
  conversionDenominator: bigint;
  /** net-of-line-discount amount, pre-tax — feeds the document-discount cap */
  netAmountMinor: bigint;
}

function mapOrderRow(raw: Record<string, unknown>): OrderRow {
  return {
    id: raw['id'] as string,
    tenantId: raw['tenantId'] as string,
    companyId: raw['companyId'] as string,
    originBranchId: raw['originBranchId'] as string,
    fulfillingBranchId: raw['fulfillingBranchId'] as string,
    posTerminalId: (raw['posTerminalId'] as string | null) ?? null,
    customerId: (raw['customerId'] as string | null) ?? null,
    kind: raw['kind'] as string,
    status: raw['status'] as string,
    currencyCode: raw['currencyCode'] as string,
    currencyExponent: raw['currencyExponent'] as number,
    documentDiscountMode: raw['documentDiscountMode'] as string,
    documentDiscountBps: (raw['documentDiscountBps'] as number | null) ?? null,
    documentDiscountAmountMinor: raw['documentDiscountAmountMinor'] as bigint,
    documentDiscountReason: (raw['documentDiscountReason'] as string | null) ?? null,
    orderNumber: (raw['orderNumber'] as string | null) ?? null,
    version: raw['version'] as number,
    commercialSnapshotFingerprint: raw['commercialSnapshotFingerprint'] as string,
    createdByUserId: (raw['createdByUserId'] as string | null) ?? null,
    actingUserId: (raw['actingUserId'] as string | null) ?? null,
    createdAt: raw['createdAt'] as Date,
    updatedAt: raw['updatedAt'] as Date,
  };
}

function mapOrderLineRow(raw: Record<string, unknown>): OrderLineRow {
  const quantity = raw['quantity'] as Prisma.Decimal;
  return {
    id: raw['id'] as string,
    tenantId: raw['tenantId'] as string,
    companyId: raw['companyId'] as string,
    orderId: raw['orderId'] as string,
    linePosition: raw['linePosition'] as number,
    productId: raw['productId'] as string,
    variantId: raw['variantId'] as string,
    quantity: quantity.toFixed(4),
    unitPriceAmountMinor: raw['unitPriceAmountMinor'] as bigint,
    unitPriceCurrencyCode: raw['unitPriceCurrencyCode'] as string,
    unitPriceCurrencyExponent: raw['unitPriceCurrencyExponent'] as number,
    discountMode: raw['discountMode'] as string,
    discountBps: (raw['discountBps'] as number | null) ?? null,
    discountAmountMinor: raw['discountAmountMinor'] as bigint,
    discountReason: (raw['discountReason'] as string | null) ?? null,
    taxCategoryKey: (raw['taxCategoryKey'] as string | null) ?? null,
    rateBps: (raw['rateBps'] as number | null) ?? null,
    effectiveFrom: (raw['effectiveFrom'] as Date | null) ?? null,
    resolutionSource: raw['resolutionSource'] as string,
    priceTaxMode: (raw['priceTaxMode'] as string | null) ?? null,
    roundingScope: (raw['roundingScope'] as string | null) ?? null,
    roundingMode: (raw['roundingMode'] as string | null) ?? null,
    lineTaxAmountMinor: (raw['lineTaxAmountMinor'] as bigint | null) ?? null,
    productNameEnSnapshot: raw['productNameEnSnapshot'] as string,
    productNameArSnapshot: (raw['productNameArSnapshot'] as string | null) ?? null,
    variantNameEnSnapshot: raw['variantNameEnSnapshot'] as string,
    variantNameArSnapshot: (raw['variantNameArSnapshot'] as string | null) ?? null,
    skuSnapshot: (raw['skuSnapshot'] as string | null) ?? null,
    selectedUomCode: raw['selectedUomCode'] as string,
    uomDisplayLabelSnapshot: raw['uomDisplayLabelSnapshot'] as string,
    baseUomCode: raw['baseUomCode'] as string,
    conversionNumerator: raw['conversionNumerator'] as bigint,
    conversionDenominator: raw['conversionDenominator'] as bigint,
    createdAt: raw['createdAt'] as Date,
    updatedAt: raw['updatedAt'] as Date,
  };
}

/**
 * Task 3b.3 Checkpoint B — the WALK_IN Order draft domain: create, patch
 * (DRAFT-only), hold, resume, read/list. Branch-scoped throughout (CLAUDE.md
 * rule 8 — Branch is THE operational data boundary); every entry point takes
 * an explicit, mandatory `branchId`, never an optional/skippable scope.
 *
 * NOTHING here ever assigns `orderNumber`, ever inserts an `Invoice` row,
 * ever calls `PostingEngineService`, or ever writes to `inventory_movement` /
 * `payment` / `ar_transaction` — those remain Checkpoint C / later tasks.
 *
 * Price/tax/UOM resolution reads (`BranchPricingService.resolvePrice`,
 * `TaxResolutionService.resolve`, `loadEffectiveVariantRegistry`) each run in
 * their OWN short read-only scoped transaction, resolved ONCE, BEFORE the one
 * atomic write transaction that inserts `order` + every `order_line` + the
 * audit row opens (mirrors D3b-10's "resolve, snapshot, then act" discipline
 * — Task 3b.1's Posting Engine follows the identical shape). If any line
 * fails resolution, the write transaction is never even opened — "no partial
 * Order" is therefore structurally guaranteed, not merely rolled back.
 */
@Injectable()
export class OrderRepository extends ScopedRepository {
  constructor(
    db: DbService,
    private readonly audit: AuditWriter,
    private readonly clock: SystemClock,
    private readonly branchPricing: BranchPricingService,
    private readonly taxResolution: TaxResolutionService,
    private readonly customers: CustomerRepository,
  ) {
    super(db);
  }

  // ── create ────────────────────────────────────────────────────────────────

  async createWalkInDraftForBranchScoped(input: {
    companyId: string;
    branchId: string;
    customerId?: string;
    lines: OrderLineInputDto[];
    documentDiscountMode: string;
    documentDiscountBps?: number;
    documentDiscountAmountMinor?: string;
    documentDiscountReason?: string;
  }): Promise<{ order: OrderRow; lines: OrderLineRow[] }> {
    const { tenantId } = requireTenantContext();
    const currencyCode = await this.resolveCompanyCurrency(input.companyId);
    const resolvedLines = await this.resolveLines(input.companyId, input.branchId, input.lines);

    const grossAfterLines = resolvedLines.reduce(
      (acc, l) => acc.add(Money.ofMinor(l.netAmountMinor, currencyCode)),
      Money.zero(currencyCode),
    );
    const documentDiscount = this.resolveDiscount(
      {
        mode: input.documentDiscountMode,
        bps: input.documentDiscountBps,
        amountMinor: input.documentDiscountAmountMinor,
      },
      grossAfterLines,
      'ORDER_DOCUMENT_DISCOUNT',
    );

    const posTerminalId = getContext()?.posTerminalId ?? null;
    const createdByUserId = getContext()?.userId ?? null;

    return this.scoped(async (tx) => {
      const branch = await tx.branch.findFirst({
        where: { id: input.branchId, companyId: input.companyId, tenantId },
        select: { id: true },
      });
      if (!branch) throw new NotFoundError('branch');

      const customerId = await this.resolveCustomerAssociation(
        tx,
        tenantId,
        input.companyId,
        input.customerId,
      );

      const fingerprint = computeCommercialSnapshotFingerprint({
        tenantId,
        companyId: input.companyId,
        originBranchId: input.branchId,
        fulfillingBranchId: input.branchId,
        customerId,
        kind: 'WALK_IN',
        currencyCode,
        lines: resolvedLines.map(toSnapshotLine),
        documentDiscountMode: documentDiscount.mode,
        documentDiscountBps: documentDiscount.bps,
        documentDiscountAmountMinor: documentDiscount.amountMinor.toString(),
        documentDiscountReason: input.documentDiscountReason ?? null,
      });

      const order = await tx.order.create({
        data: {
          tenantId,
          companyId: input.companyId,
          originBranchId: input.branchId,
          fulfillingBranchId: input.branchId,
          posTerminalId,
          customerId,
          kind: 'WALK_IN',
          status: 'DRAFT',
          currencyCode,
          currencyExponent: currencyExponent(currencyCode),
          documentDiscountMode: documentDiscount.mode,
          documentDiscountBps: documentDiscount.bps,
          documentDiscountAmountMinor: documentDiscount.amountMinor,
          documentDiscountReason: input.documentDiscountReason ?? null,
          commercialSnapshotFingerprint: fingerprint,
          createdByUserId,
          actingUserId: createdByUserId,
        },
      });

      const lines = await this.insertLines(tx, tenantId, input.companyId, order.id, resolvedLines);

      await this.audit.record(tx, {
        action: 'order.created',
        resourceType: 'order',
        resourceId: order.id,
        tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        posTerminalId,
        after: { kind: 'WALK_IN', status: 'DRAFT', lineCount: lines.length },
      });

      return { order: mapOrderRow(order), lines };
    }).catch((err: unknown) => {
      if (isPgError(err, PG_FK_VIOLATION)) {
        throw new DomainError(
          'ORDER_ATTRIBUTION_INVALID',
          'the resolved order attribution does not satisfy a structural integrity constraint',
          409,
        );
      }
      throw err;
    });
  }

  // ── read ──────────────────────────────────────────────────────────────────

  async getForBranchScoped(input: {
    companyId: string;
    branchId: string;
    orderId: string;
  }): Promise<{ order: OrderRow; lines: OrderLineRow[] }> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      const order = await tx.order.findFirst({
        where: {
          id: input.orderId,
          tenantId,
          companyId: input.companyId,
          originBranchId: input.branchId,
        },
      });
      if (!order) throw new NotFoundError('order', 'ORDER_NOT_FOUND');
      const lines = await tx.orderLine.findMany({
        where: { orderId: order.id, tenantId, companyId: input.companyId },
        orderBy: { linePosition: 'asc' },
      });
      return { order: mapOrderRow(order), lines: lines.map(mapOrderLineRow) };
    });
  }

  async listForBranchScoped(input: {
    companyId: string;
    branchId: string;
    cursor?: string;
    limit?: number;
    status?: string;
    customerId?: string;
  }): Promise<{ data: OrderRow[]; nextCursor: string | null }> {
    const { tenantId } = requireTenantContext();
    const limit = input.limit ?? 50;
    return this.scoped(async (tx) => {
      const rows = await tx.$queryRaw<Record<string, unknown>[]>`
        SELECT * FROM "order"
         WHERE "tenantId" = ${tenantId}::uuid
           AND "companyId" = ${input.companyId}::uuid
           AND "originBranchId" = ${input.branchId}::uuid
           AND (${input.cursor ?? null}::uuid IS NULL OR "id" > ${input.cursor ?? null}::uuid)
           AND (${input.status ?? null}::text IS NULL OR "status" = ${input.status ?? null}::text)
           AND (${input.customerId ?? null}::uuid IS NULL OR "customerId" = ${input.customerId ?? null}::uuid)
         ORDER BY "id" ASC
         LIMIT ${limit + 1}`;
      const hasMore = rows.length > limit;
      const data = (hasMore ? rows.slice(0, limit) : rows).map(mapOrderRow);
      return { data, nextCursor: hasMore ? (data.at(-1)?.id ?? null) : null };
    });
  }

  // ── patch (DRAFT only) ───────────────────────────────────────────────────

  /**
   * NO-OP RULE (§17, adversarial-review addition): a genuinely empty PATCH
   * body (no `customerId`/`lines`/`documentDiscountMode`) is REJECTED
   * (`400 ORDER_PATCH_EMPTY`) rather than silently accepted as a version-
   * bumping no-op. Once past that gate, EVERY successful PATCH increments
   * `version` by exactly 1 and recomputes `commercialSnapshotFingerprint`,
   * even if the resolved content happens to be byte-identical to before —
   * this mirrors `CustomerRepository.updateForCompany`'s own established
   * behavior (no same-value short-circuit there either). That is
   * deliberately different from `archiveForCompany`'s idempotent-replay
   * short-circuit, which exists only because ARCHIVED is a genuine terminal
   * state with no further transition — DRAFT has no equivalent terminal
   * semantics, so no such short-circuit applies here.
   */
  async updateDraftForBranchScoped(input: {
    companyId: string;
    branchId: string;
    orderId: string;
    expectedVersion: number;
    customerId?: string | null;
    lines?: OrderLineInputDto[];
    documentDiscountMode?: string;
    documentDiscountBps?: number;
    documentDiscountAmountMinor?: string;
    documentDiscountReason?: string;
  }): Promise<{ order: OrderRow; lines: OrderLineRow[] }> {
    if (
      input.customerId === undefined &&
      input.lines === undefined &&
      input.documentDiscountMode === undefined
    ) {
      throw new DomainError(
        'ORDER_PATCH_EMPTY',
        'at least one of customerId, lines, or documentDiscountMode must be present',
        400,
      );
    }
    const { tenantId } = requireTenantContext();

    // resolve BEFORE the write transaction opens — same "no partial Order"
    // discipline as create (§16/§19).
    const resolvedLines =
      input.lines !== undefined
        ? await this.resolveLines(input.companyId, input.branchId, input.lines)
        : null;

    return this.scoped(async (tx) => {
      const currentRows = await tx.$queryRaw<Record<string, unknown>[]>`
        SELECT * FROM "order"
         WHERE "id" = ${input.orderId}::uuid
           AND "tenantId" = ${tenantId}::uuid
           AND "companyId" = ${input.companyId}::uuid
           AND "originBranchId" = ${input.branchId}::uuid
         FOR UPDATE`;
      const current = currentRows[0];
      if (!current) throw new NotFoundError('order', 'ORDER_NOT_FOUND');
      const currentOrder = mapOrderRow(current);

      if (currentOrder.status !== 'DRAFT') {
        throw new DomainError(
          'ORDER_INVALID_STATE_TRANSITION',
          'an order can only be edited while DRAFT — a HELD order must resume first',
          409,
        );
      }
      if (currentOrder.version !== input.expectedVersion) {
        throw new DomainError(
          'ORDER_VERSION_CONFLICT',
          `order changed elsewhere (expected version ${input.expectedVersion}, now ${currentOrder.version})`,
          409,
        );
      }

      const customerId =
        input.customerId === undefined
          ? currentOrder.customerId
          : await this.resolveCustomerAssociation(
              tx,
              tenantId,
              input.companyId,
              input.customerId ?? undefined,
            );

      let lines: OrderLineRow[];
      let snapshotLines: CommercialSnapshotLine[];
      if (resolvedLines !== null) {
        await tx.orderLine.deleteMany({ where: { orderId: currentOrder.id } });
        lines = await this.insertLines(
          tx,
          tenantId,
          input.companyId,
          currentOrder.id,
          resolvedLines,
        );
        snapshotLines = resolvedLines.map(toSnapshotLine);
      } else {
        const existing = await tx.orderLine.findMany({
          where: { orderId: currentOrder.id },
          orderBy: { linePosition: 'asc' },
        });
        lines = existing.map(mapOrderLineRow);
        snapshotLines = lines.map((l) => ({
          productId: l.productId,
          variantId: l.variantId,
          quantity: l.quantity,
          selectedUomCode: l.selectedUomCode,
          baseUomCode: l.baseUomCode,
          conversionNumerator: l.conversionNumerator.toString(),
          conversionDenominator: l.conversionDenominator.toString(),
          unitPriceAmountMinor: l.unitPriceAmountMinor.toString(),
          unitPriceCurrencyCode: l.unitPriceCurrencyCode,
          unitPriceCurrencyExponent: l.unitPriceCurrencyExponent,
          discountMode: l.discountMode,
          discountBps: l.discountBps,
          discountAmountMinor: l.discountAmountMinor.toString(),
          taxCategoryKey: l.taxCategoryKey,
          rateBps: l.rateBps,
          effectiveFrom: l.effectiveFrom ? l.effectiveFrom.toISOString().slice(0, 10) : null,
          resolutionSource: l.resolutionSource,
        }));
      }

      let documentDiscountMode = currentOrder.documentDiscountMode;
      let documentDiscountBps = currentOrder.documentDiscountBps;
      let documentDiscountAmountMinor = currentOrder.documentDiscountAmountMinor;
      let documentDiscountReason = currentOrder.documentDiscountReason;
      // Re-validate whenever EITHER the document-discount intent changes OR
      // the line set was replaced — a shrunk line set can make a previously
      // valid document discount amount exceed the new gross, and that must
      // fail closed here rather than silently persisting an inconsistent
      // discount (adversarial-review finding, this checkpoint).
      if (input.documentDiscountMode !== undefined || resolvedLines !== null) {
        const grossAfterLines = lines.reduce(
          (acc, l) =>
            acc.add(
              this.lineGross(
                l.unitPriceAmountMinor,
                l.unitPriceCurrencyCode,
                Quantity.parse(l.quantity),
              ).subtract(Money.ofMinor(l.discountAmountMinor, l.unitPriceCurrencyCode)),
            ),
          Money.zero(currentOrder.currencyCode),
        );
        const resolved = this.resolveDiscount(
          input.documentDiscountMode !== undefined
            ? {
                mode: input.documentDiscountMode,
                bps: input.documentDiscountBps,
                amountMinor: input.documentDiscountAmountMinor,
              }
            : {
                mode: currentOrder.documentDiscountMode,
                bps: currentOrder.documentDiscountBps ?? undefined,
                amountMinor: currentOrder.documentDiscountAmountMinor.toString(),
              },
          grossAfterLines,
          'ORDER_DOCUMENT_DISCOUNT',
        );
        documentDiscountMode = resolved.mode;
        documentDiscountBps = resolved.bps;
        documentDiscountAmountMinor = resolved.amountMinor;
        documentDiscountReason =
          input.documentDiscountMode !== undefined
            ? (input.documentDiscountReason ?? null)
            : currentOrder.documentDiscountReason;
      }

      const fingerprint = computeCommercialSnapshotFingerprint({
        tenantId,
        companyId: input.companyId,
        originBranchId: currentOrder.originBranchId,
        fulfillingBranchId: currentOrder.fulfillingBranchId,
        customerId,
        kind: currentOrder.kind,
        currencyCode: currentOrder.currencyCode,
        lines: snapshotLines,
        documentDiscountMode,
        documentDiscountBps,
        documentDiscountAmountMinor: documentDiscountAmountMinor.toString(),
        documentDiscountReason,
      });

      const updated = await tx.order.update({
        where: { id: currentOrder.id },
        data: {
          customerId,
          documentDiscountMode,
          documentDiscountBps,
          documentDiscountAmountMinor,
          documentDiscountReason,
          commercialSnapshotFingerprint: fingerprint,
          version: { increment: 1 },
        },
      });

      await this.audit.record(tx, {
        action: 'order.updated',
        resourceType: 'order',
        resourceId: currentOrder.id,
        tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        after: {
          linesReplaced: resolvedLines !== null,
          customerChanged: input.customerId !== undefined,
          documentDiscountChanged: input.documentDiscountMode !== undefined,
        },
      });

      return { order: mapOrderRow(updated), lines };
    });
  }

  // ── hold / resume — operational only, zero commercial re-resolution ─────

  async holdForBranchScoped(input: {
    companyId: string;
    branchId: string;
    orderId: string;
    expectedVersion: number;
  }): Promise<OrderRow> {
    return this.transitionForBranchScoped(input, 'DRAFT', 'HELD', 'order.held');
  }

  async resumeForBranchScoped(input: {
    companyId: string;
    branchId: string;
    orderId: string;
    expectedVersion: number;
  }): Promise<OrderRow> {
    return this.transitionForBranchScoped(input, 'HELD', 'DRAFT', 'order.resumed');
  }

  private async transitionForBranchScoped(
    input: { companyId: string; branchId: string; orderId: string; expectedVersion: number },
    fromStatus: string,
    toStatus: string,
    auditAction: 'order.held' | 'order.resumed',
  ): Promise<OrderRow> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      const currentRows = await tx.$queryRaw<Record<string, unknown>[]>`
        SELECT * FROM "order"
         WHERE "id" = ${input.orderId}::uuid
           AND "tenantId" = ${tenantId}::uuid
           AND "companyId" = ${input.companyId}::uuid
           AND "originBranchId" = ${input.branchId}::uuid
         FOR UPDATE`;
      const current = currentRows[0];
      if (!current) throw new NotFoundError('order', 'ORDER_NOT_FOUND');
      const currentOrder = mapOrderRow(current);

      if (currentOrder.status !== fromStatus) {
        throw new DomainError(
          'ORDER_INVALID_STATE_TRANSITION',
          `order must be ${fromStatus} to transition to ${toStatus} (currently ${currentOrder.status})`,
          409,
        );
      }
      if (currentOrder.version !== input.expectedVersion) {
        throw new DomainError(
          'ORDER_VERSION_CONFLICT',
          `order changed elsewhere (expected version ${input.expectedVersion}, now ${currentOrder.version})`,
          409,
        );
      }

      // status only — commercialSnapshotFingerprint is commercial content
      // only and is NEVER touched by a Hold/Resume transition (§20/§21).
      const updated = await tx.order.update({
        where: { id: currentOrder.id },
        data: { status: toStatus, version: { increment: 1 } },
      });

      await this.audit.record(tx, {
        action: auditAction,
        resourceType: 'order',
        resourceId: currentOrder.id,
        tenantId,
        companyId: input.companyId,
        branchId: input.branchId,
        after: { fromStatus, toStatus },
      });

      return mapOrderRow(updated);
    });
  }

  // ── shared resolution helpers ─────────────────────────────────────────────

  private async resolveCompanyCurrency(companyId: string): Promise<string> {
    return (await this.resolveCompanyFiscalContext(companyId)).defaultCurrency;
  }

  /**
   * `defaultCurrency` (D3b-15) + `accountingTimezone` (D3b-15/D3b-16, task
   * 3b.1) — the SOLE authoritative Company-level fiscal context. Reused here
   * for internal tax-reference resolution's civil-date derivation
   * (Checkpoint B hardening, §2): `accountingTimezone` is the only
   * Company-scoped civil-date authority this schema has ever had — Branch/
   * POS/browser timezone remain permanently forbidden as a fiscal source
   * (CLAUDE.md / Task 3.9's own frozen contract). Reusing the SAME
   * `Intl.DateTimeFormat`-based helper Task 3b.1 already proved
   * (`derivePostingDate`) for a SEPARATE, independently-computed date value
   * does not violate D3b-16's "never merge the two derivation paths into one
   * field" rule — no `postingDate` field exists anywhere in Task 3b.3, and
   * this value is never stored, only passed transiently to
   * `TaxResolutionService.resolve`.
   */
  private async resolveCompanyFiscalContext(
    companyId: string,
  ): Promise<{ defaultCurrency: string; accountingTimezone: string }> {
    const { tenantId } = requireTenantContext();
    return this.scoped(async (tx) => {
      const rows = await tx.$queryRaw<
        { defaultCurrency: string | null; accountingTimezone: string | null }[]
      >`
        SELECT "defaultCurrency", "accountingTimezone" FROM "company"
         WHERE "id" = ${companyId}::uuid AND "tenantId" = ${tenantId}::uuid`;
      const row = rows[0];
      if (!row) throw new NotFoundError('company');
      if (!row.defaultCurrency) {
        throw new DomainError(
          'ORDER_COMPANY_CURRENCY_NOT_CONFIGURED',
          'this company has no default currency configured',
          409,
        );
      }
      if (!row.accountingTimezone) {
        throw new DomainError(
          'ORDER_COMPANY_ACCOUNTING_TIMEZONE_NOT_CONFIGURED',
          'this company has no accounting timezone configured — required to derive the civil date for tax-reference resolution',
          409,
        );
      }
      return { defaultCurrency: row.defaultCurrency, accountingTimezone: row.accountingTimezone };
    });
  }

  private async resolveCustomerAssociation(
    tx: ScopedTx,
    tenantId: string,
    companyId: string,
    customerId: string | undefined,
  ): Promise<string | null> {
    if (customerId === undefined) return null;
    try {
      const customer = await this.customers.getForCompany(tx, { tenantId, companyId, customerId });
      return customer.id;
    } catch (err) {
      if (err instanceof DomainError && err.code === 'CUSTOMER_NOT_FOUND') {
        throw new DomainError(
          'ORDER_CUSTOMER_NOT_AVAILABLE',
          'customer not available for this company',
          404,
        );
      }
      throw err;
    }
  }

  /**
   * Resolve + validate + snapshot every submitted line's server-authoritative
   * commercial content (§7-§13) — Product/Variant existence + sellable state +
   * same-product integrity, UOM resolution (`@flower/uom`, no client ratio),
   * `BranchPricingService.resolvePrice`, `TaxResolutionService.resolve`, the
   * historical display/SKU snapshot, and line-discount validation. Runs
   * entirely as reads (no write) — see the class doc comment for why this
   * happens before the write transaction opens.
   */
  private async resolveLines(
    companyId: string,
    branchId: string,
    inputs: OrderLineInputDto[],
  ): Promise<ResolvedLine[]> {
    const { tenantId } = requireTenantContext();
    const { defaultCurrency: currencyCode, accountingTimezone } =
      await this.resolveCompanyFiscalContext(companyId);
    // civil YYYY-MM-DD for TaxResolutionService's frozen DATE-only contract —
    // derived from a trusted server instant + the Company's OWN authoritative
    // timezone, via the exact proven helper Task 3b.1 already uses for
    // `postingDate` (never UTC truncation, never Branch/POS/browser tz).
    const today = derivePostingDate(this.clock.now(), accountingTimezone);

    const catalog = await this.scoped(async (tx) => {
      const variantIds = [...new Set(inputs.map((l) => l.variantId))];
      const variants = await tx.variant.findMany({
        where: { id: { in: variantIds }, tenantId },
        select: {
          id: true,
          productId: true,
          nameEn: true,
          nameAr: true,
          status: true,
          baseUomCode: true,
        },
      });
      const variantMap = new Map(variants.map((v) => [v.id, v]));

      const productIds = [...new Set(variants.map((v) => v.productId))];
      const products = await tx.product.findMany({
        where: { id: { in: productIds }, tenantId },
        select: { id: true, nameEn: true, nameAr: true, status: true },
      });
      const productMap = new Map(products.map((p) => [p.id, p]));

      const skuRows = await tx.$queryRaw<{ targetId: string; value: string }[]>`
        SELECT DISTINCT ON ("targetId") "targetId", "value"
          FROM "item_identifier"
         WHERE "tenantId" = ${tenantId}::uuid
           AND "targetKind" = 'VARIANT'
           AND "targetId" = ANY(${variantIds}::uuid[])
           AND "codeType" = 'SKU'
           AND "status" = 'ACTIVE'
         ORDER BY "targetId", "createdAt" ASC`;
      const skuMap = new Map(skuRows.map((r) => [r.targetId, r.value]));

      const uomCodes = [...new Set(inputs.map((l) => l.selectedUomCode))].filter(
        (c) => !isBuiltinUom(c),
      );
      const uomRows =
        uomCodes.length > 0
          ? await tx.uom.findMany({
              where: { code: { in: uomCodes }, tenantId },
              select: { code: true, nameEn: true },
            })
          : [];
      const uomNameMap = new Map(uomRows.map((u) => [u.code, u.nameEn]));

      const registries = new Map<
        string,
        Awaited<ReturnType<typeof loadEffectiveVariantRegistry>>
      >();
      for (const v of variants) {
        if (v.baseUomCode === null) continue;
        registries.set(
          v.id,
          await loadEffectiveVariantRegistry(tx, {
            id: v.id,
            productId: v.productId,
            baseUomCode: v.baseUomCode,
          }),
        );
      }

      return { variantMap, productMap, skuMap, uomNameMap, registries };
    });

    const resolved: ResolvedLine[] = [];
    for (const li of inputs) {
      const variant = catalog.variantMap.get(li.variantId);
      if (!variant) {
        throw new DomainError('ORDER_LINE_VARIANT_NOT_FOUND', 'variant not found', 422, [
          { field: 'variantId', issue: 'unknown variant' },
        ]);
      }
      if (variant.productId !== li.productId) {
        throw new DomainError(
          'ORDER_LINE_VARIANT_PRODUCT_MISMATCH',
          'the supplied variant does not belong to the supplied product',
          422,
          [{ field: 'variantId', issue: 'does not belong to productId' }],
        );
      }
      const product = catalog.productMap.get(li.productId);
      if (!product) {
        throw new DomainError('ORDER_LINE_PRODUCT_NOT_FOUND', 'product not found', 422, [
          { field: 'productId', issue: 'unknown product' },
        ]);
      }
      if (product.status !== 'ACTIVE' || variant.status !== 'ACTIVE') {
        throw new DomainError(
          'ORDER_LINE_NOT_SELLABLE',
          'the product or variant is not currently sellable',
          422,
          [{ field: 'variantId', issue: 'not ACTIVE' }],
        );
      }
      if (variant.baseUomCode === null) {
        throw new DomainError(
          'ORDER_LINE_UOM_INVALID',
          'the variant has no base unit of measure configured',
          409,
          [{ field: 'variantId', issue: 'baseUomCode not set' }],
        );
      }

      let quantity: Quantity;
      try {
        quantity = Quantity.parse(li.quantity);
      } catch {
        throw new DomainError(
          'ORDER_LINE_QUANTITY_INVALID',
          'quantity is not a valid decimal',
          422,
          [{ field: 'quantity', issue: 'invalid decimal' }],
        );
      }
      if (quantity.scaled <= 0n) {
        throw new DomainError('ORDER_LINE_QUANTITY_INVALID', 'quantity must be > 0', 422, [
          { field: 'quantity', issue: 'must be positive' },
        ]);
      }

      const registry = catalog.registries.get(li.variantId);
      if (!registry) {
        throw new DomainError('ORDER_LINE_UOM_INVALID', 'unable to resolve UOM registry', 409);
      }
      try {
        registry.assertPermitted(quantity, li.selectedUomCode);
      } catch {
        throw new DomainError(
          'ORDER_LINE_QUANTITY_INVALID',
          'quantity uses more decimal places than the selected UOM permits',
          422,
          [{ field: 'quantity', issue: 'too many decimal places for selectedUomCode' }],
        );
      }
      // the EXACT effective ratio itself (§6/§7 hardening, reconfirmed
      // Checkpoint C final-integrity pass): the authoritative source, never a
      // Quantity(1) approximation. This is the ONLY UOM-exactness gate Order
      // creation performs — resolving whether the selected↔base ratio ITSELF
      // is a well-defined rational is a structural question about the
      // catalog's conversion configuration, never about whether the
      // customer's chosen SALE quantity happens to convert exactly to base.
      //
      // Frozen Phase 3.6 contract (owner correction, this pass):
      // `convertExact`-as-a-quantity-gate belongs ONLY to frozen pack
      // identity / `item_identifier.packBaseQty` creation (still exact-or-
      // reject there, untouched by this change) — normal/general UOM
      // conversion is legitimately non-exact, and downstream normalisation
      // (inventory deduction, a LATER phase) owns its own rounding/quantity
      // policy. Task 3b.3 never stores a base-equivalent quantity and never
      // deducts inventory, so there is nothing here for an exact-conversion
      // gate to protect — a real sale of "1 unit of a UOM worth 1/3 base"
      // (e.g. a third-of-a-dozen retail unit) is a perfectly valid WALK_IN
      // sale and must not be rejected merely because `1 × 1/3` has no
      // scale-4-exact base-unit representation. The exact rational
      // `conversionNumerator`/`conversionDenominator` snapshot below is
      // always stored losslessly regardless.
      let conversionNumerator: bigint;
      let conversionDenominator: bigint;
      try {
        const ratio = registry.effectiveRatio(li.selectedUomCode, variant.baseUomCode);
        conversionNumerator = ratio.num;
        conversionDenominator = ratio.den;
      } catch (err) {
        if (
          err instanceof UnknownUomError ||
          err instanceof UomFamilyMismatchError ||
          err instanceof UomConversionUnavailableError
        ) {
          throw new DomainError(
            'ORDER_LINE_UOM_INVALID',
            'the selected UOM is not valid for this product/variant',
            422,
            [{ field: 'selectedUomCode', issue: 'unresolvable for this variant' }],
          );
        }
        throw err;
      }

      const resolvedPrice = await this.branchPricing.resolvePrice(
        branchId,
        li.variantId,
        li.selectedUomCode,
      );
      if (!resolvedPrice.price) {
        throw new DomainError(
          'ORDER_LINE_PRICE_NOT_CONFIGURED',
          `no price configured for this variant/UOM (${resolvedPrice.reason ?? 'UNKNOWN'})`,
          422,
          [{ field: 'selectedUomCode', issue: resolvedPrice.reason ?? 'NO_PRICE' }],
        );
      }
      const unitPriceAmountMinor = BigInt(resolvedPrice.price.amountMinor);
      const unitPriceCurrencyCode = resolvedPrice.price.currency;
      const unitPriceCurrencyExponent = resolvedPrice.price.exponent;
      if (unitPriceCurrencyCode !== currencyCode) {
        throw new DomainError(
          'ORDER_LINE_CURRENCY_MISMATCH',
          'resolved line price currency does not match the company default currency',
          409,
        );
      }

      const taxResolved = await this.taxResolution.resolve({
        companyId,
        variantId: li.variantId,
        date: today,
      });

      const grossMoney = this.lineGross(unitPriceAmountMinor, unitPriceCurrencyCode, quantity);
      const discount = this.resolveDiscount(
        { mode: li.discountMode, bps: li.discountBps, amountMinor: li.discountAmountMinor },
        grossMoney,
        'ORDER_LINE_DISCOUNT',
      );
      const netMoney = grossMoney.subtract(
        Money.ofMinor(discount.amountMinor, unitPriceCurrencyCode),
      );

      const sku = catalog.skuMap.get(li.variantId) ?? null;
      const uomDisplayLabelSnapshot = isBuiltinUom(li.selectedUomCode)
        ? li.selectedUomCode
        : (catalog.uomNameMap.get(li.selectedUomCode) ?? li.selectedUomCode);

      resolved.push({
        productId: li.productId,
        variantId: li.variantId,
        quantity: quantity.toFixed4(),
        unitPriceAmountMinor,
        unitPriceCurrencyCode,
        unitPriceCurrencyExponent,
        discountMode: discount.mode,
        discountBps: discount.bps,
        discountAmountMinor: discount.amountMinor,
        discountReason: li.discountReason ?? null,
        taxCategoryKey: taxResolved.taxCategoryKey,
        rateBps: taxResolved.rateBps,
        effectiveFrom: taxResolved.effectiveFrom ? new Date(taxResolved.effectiveFrom) : null,
        resolutionSource: taxResolved.categorySource,
        productNameEnSnapshot: product.nameEn,
        productNameArSnapshot: product.nameAr,
        variantNameEnSnapshot: variant.nameEn,
        variantNameArSnapshot: variant.nameAr,
        skuSnapshot: sku,
        selectedUomCode: li.selectedUomCode,
        uomDisplayLabelSnapshot,
        baseUomCode: variant.baseUomCode,
        conversionNumerator,
        conversionDenominator,
        netAmountMinor: netMoney.amountMinor,
      });
    }
    return resolved;
  }

  /**
   * Commercial line gross = `unitPriceAmountMinor × quantity` — EXACT BigInt
   * arithmetic throughout (§11 hardening — documented explicitly, not left
   * implicit, since 3b.4 must later reproduce this same commercial base).
   *
   * `quantity` is a `Decimal(18,4)` (`@flower/uom`'s `Quantity`, scale 4 —
   * `scaled` is the exact integer `quantity × 10 000`). `Money.mulRatio`
   * computes `(unitPriceAmountMinor × quantity.scaled) / 10 000` as one exact
   * BigInt numerator over a BigInt denominator, rounding ONLY the final
   * division — and only when the true product genuinely lands on a
   * fractional minor unit (e.g. AED 2-decimal price × an odd fractional
   * quantity). The rounding mode is `mulRatio`'s documented default,
   * `'HALF_UP'` — the same generic default `@flower/money` uses everywhere
   * else in this codebase; no sale-tax-specific rounding policy (`3b.4`
   * owns `rounding_scope`/`rounding_mode`) is applied here. No JS `number`,
   * no float, anywhere in this computation.
   */
  private lineGross(unitPriceAmountMinor: bigint, currencyCode: string, quantity: Quantity): Money {
    return Money.ofMinor(unitPriceAmountMinor, currencyCode).mulRatio(quantity.scaled, 10_000n);
  }

  private resolveDiscount(
    input: { mode: string; bps: number | undefined; amountMinor: string | undefined },
    gross: Money,
    errorPrefix: string,
  ): { mode: string; bps: number | null; amountMinor: bigint } {
    switch (input.mode) {
      case 'NONE':
        return { mode: 'NONE', bps: null, amountMinor: 0n };
      case 'AMOUNT': {
        if (input.amountMinor === undefined) {
          throw new DomainError(
            `${errorPrefix}_INVALID`,
            'AMOUNT mode requires an explicit discountAmountMinor',
            422,
          );
        }
        const amount = BigInt(input.amountMinor);
        if (amount > gross.amountMinor) {
          throw new DomainError(
            `${errorPrefix}_EXCEEDS_GROSS`,
            'discount amount exceeds the commercial gross amount it applies to',
            422,
          );
        }
        return { mode: 'AMOUNT', bps: null, amountMinor: amount };
      }
      case 'PERCENT_BPS': {
        if (input.bps === undefined) {
          throw new DomainError(`${errorPrefix}_INVALID`, 'PERCENT_BPS mode requires bps', 422);
        }
        const amount = gross.percentage(input.bps).amountMinor;
        return { mode: 'PERCENT_BPS', bps: input.bps, amountMinor: amount };
      }
      default:
        throw new DomainError(`${errorPrefix}_INVALID`, 'unknown discount mode', 422);
    }
  }

  /**
   * `linePosition` is assigned here, deterministically, from `resolvedLines`'
   * array order (1-based) — the SAME order the caller's `input.lines` arrived
   * in, and the SAME order `computeCommercialSnapshotFingerprint` hashes
   * (§1 hardening). A full-line-replacement PATCH calls this after deleting
   * every prior line (see `updateDraftForBranchScoped`), so positions are
   * always regenerated 1..N in the newly submitted order — never preserved
   * from the replaced set.
   */
  private async insertLines(
    tx: ScopedTx,
    tenantId: string,
    companyId: string,
    orderId: string,
    resolvedLines: ResolvedLine[],
  ): Promise<OrderLineRow[]> {
    const lines: OrderLineRow[] = [];
    for (const [index, l] of resolvedLines.entries()) {
      const created = await tx.orderLine.create({
        data: {
          tenantId,
          companyId,
          orderId,
          linePosition: index + 1,
          productId: l.productId,
          variantId: l.variantId,
          quantity: l.quantity,
          unitPriceAmountMinor: l.unitPriceAmountMinor,
          unitPriceCurrencyCode: l.unitPriceCurrencyCode,
          unitPriceCurrencyExponent: l.unitPriceCurrencyExponent,
          discountMode: l.discountMode,
          discountBps: l.discountBps,
          discountAmountMinor: l.discountAmountMinor,
          discountReason: l.discountReason,
          taxCategoryKey: l.taxCategoryKey,
          rateBps: l.rateBps,
          effectiveFrom: l.effectiveFrom,
          resolutionSource: l.resolutionSource,
          productNameEnSnapshot: l.productNameEnSnapshot,
          productNameArSnapshot: l.productNameArSnapshot,
          variantNameEnSnapshot: l.variantNameEnSnapshot,
          variantNameArSnapshot: l.variantNameArSnapshot,
          skuSnapshot: l.skuSnapshot,
          selectedUomCode: l.selectedUomCode,
          uomDisplayLabelSnapshot: l.uomDisplayLabelSnapshot,
          baseUomCode: l.baseUomCode,
          conversionNumerator: l.conversionNumerator,
          conversionDenominator: l.conversionDenominator,
        },
      });
      lines.push(mapOrderLineRow(created));
    }
    return lines;
  }
}

function toSnapshotLine(l: ResolvedLine): CommercialSnapshotLine {
  return {
    productId: l.productId,
    variantId: l.variantId,
    quantity: l.quantity,
    selectedUomCode: l.selectedUomCode,
    baseUomCode: l.baseUomCode,
    conversionNumerator: l.conversionNumerator.toString(),
    conversionDenominator: l.conversionDenominator.toString(),
    unitPriceAmountMinor: l.unitPriceAmountMinor.toString(),
    unitPriceCurrencyCode: l.unitPriceCurrencyCode,
    unitPriceCurrencyExponent: l.unitPriceCurrencyExponent,
    discountMode: l.discountMode,
    discountBps: l.discountBps,
    discountAmountMinor: l.discountAmountMinor.toString(),
    taxCategoryKey: l.taxCategoryKey,
    rateBps: l.rateBps,
    effectiveFrom: l.effectiveFrom ? l.effectiveFrom.toISOString().slice(0, 10) : null,
    resolutionSource: l.resolutionSource,
  };
}
