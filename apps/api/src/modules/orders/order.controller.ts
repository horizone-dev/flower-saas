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
} from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { ScopedParam, NoStepUp } from '../../common/auth/pipeline.decorators.js';
import { Idempotent } from '../../common/idempotency/index.js';
import { ZodBody } from '../../common/validation/zod-body.js';
import { assertUuid, parseIfMatch, requireIfMatch } from '../catalog/catalog-write.helpers.js';
import { OrderService } from './order.service.js';
import { OrderCreateFingerprintProvider } from './order-create-fingerprint.provider.js';
import type { OrderRow, OrderLineRow } from './order.repository.js';
import { createOrderSchema, type CreateOrderDto } from './dto/create-order.dto.js';
import { updateOrderSchema, type UpdateOrderDto } from './dto/update-order.dto.js';

/**
 * Fastify's JSON serializer cannot encode a native `BigInt` — every
 * BigInt-typed Money/ratio field is converted to a decimal-digit STRING here,
 * mirroring `customer.controller.ts`'s `serializeCompanyAccount` convention
 * exactly (never a JS `number`, which cannot safely round-trip an arbitrary
 * BigInt).
 */
function serializeOrder(
  row: OrderRow,
): Omit<OrderRow, 'documentDiscountAmountMinor'> & { documentDiscountAmountMinor: string } {
  return { ...row, documentDiscountAmountMinor: row.documentDiscountAmountMinor.toString() };
}

function serializeLine(row: OrderLineRow): Omit<
  OrderLineRow,
  | 'unitPriceAmountMinor'
  | 'discountAmountMinor'
  | 'lineTaxAmountMinor'
  | 'conversionNumerator'
  | 'conversionDenominator'
> & {
  unitPriceAmountMinor: string;
  discountAmountMinor: string;
  lineTaxAmountMinor: string | null;
  conversionNumerator: string;
  conversionDenominator: string;
} {
  return {
    ...row,
    unitPriceAmountMinor: row.unitPriceAmountMinor.toString(),
    discountAmountMinor: row.discountAmountMinor.toString(),
    lineTaxAmountMinor: row.lineTaxAmountMinor === null ? null : row.lineTaxAmountMinor.toString(),
    conversionNumerator: row.conversionNumerator.toString(),
    conversionDenominator: row.conversionDenominator.toString(),
  };
}

/**
 * `/v1/companies/:companyId/branches/:branchId/orders` — task 3b.3 Checkpoint
 * B, WALK_IN producer only. Branch-nested throughout (Branch is THE
 * operational scope, CLAUDE.md rule 8) — `@ScopedParam({ company, branch })`
 * on every route means a Branch-A-scoped caller can never reach a Branch-B
 * order, full stop (checked by the guard pipeline before this controller
 * ever runs).
 *
 * NO confirm/issue route exists here (Checkpoint C, never this task). NO
 * Invoice route exists here (deferred entirely — Checkpoint B/A create zero
 * legitimate Invoice producers, so a read route would have nothing to read).
 */
@Controller('companies/:companyId/branches/:branchId/orders')
export class OrderController {
  constructor(private readonly orders: OrderService) {}

  @Post()
  @RequirePermission('orders:manage')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  @Idempotent({
    scope: 'orders.create',
    semanticFingerprintProvider: OrderCreateFingerprintProvider,
  })
  async create(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Body(new ZodBody(createOrderSchema)) dto: CreateOrderDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    const { order, lines } = await this.orders.createWalkInDraft({
      companyId,
      branchId,
      ...(dto.customerId !== undefined ? { customerId: dto.customerId } : {}),
      lines: dto.lines,
      documentDiscountMode: dto.documentDiscountMode,
      ...(dto.documentDiscountBps !== undefined
        ? { documentDiscountBps: dto.documentDiscountBps }
        : {}),
      ...(dto.documentDiscountAmountMinor !== undefined
        ? { documentDiscountAmountMinor: dto.documentDiscountAmountMinor }
        : {}),
      ...(dto.documentDiscountReason !== undefined
        ? { documentDiscountReason: dto.documentDiscountReason }
        : {}),
    });
    return { order: serializeOrder(order), lines: lines.map(serializeLine) };
  }

  @Get()
  @RequirePermission('orders:view')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async list(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Query('cursor') cursor: string | undefined,
    @Query('status') status: string | undefined,
    @Query('customerId') customerId: string | undefined,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    const { data, nextCursor } = await this.orders.list({
      companyId,
      branchId,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(customerId !== undefined ? { customerId } : {}),
    });
    return { data: data.map(serializeOrder), nextCursor };
  }

  @Get(':id')
  @RequirePermission('orders:view')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async get(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('id') id: string,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(id, 'order');
    const { order, lines } = await this.orders.get({ companyId, branchId, orderId: id });
    return { order: serializeOrder(order), lines: lines.map(serializeLine) };
  }

  @Patch(':id')
  @RequirePermission('orders:manage')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async update(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
    @Body(new ZodBody(updateOrderSchema)) dto: UpdateOrderDto,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(id, 'order');
    const expectedVersion = requireIfMatch(parseIfMatch(ifMatch));
    const { order, lines } = await this.orders.updateDraft({
      companyId,
      branchId,
      orderId: id,
      expectedVersion,
      ...(dto.customerId !== undefined ? { customerId: dto.customerId } : {}),
      ...(dto.lines !== undefined ? { lines: dto.lines } : {}),
      ...(dto.documentDiscountMode !== undefined
        ? { documentDiscountMode: dto.documentDiscountMode }
        : {}),
      ...(dto.documentDiscountBps !== undefined
        ? { documentDiscountBps: dto.documentDiscountBps }
        : {}),
      ...(dto.documentDiscountAmountMinor !== undefined
        ? { documentDiscountAmountMinor: dto.documentDiscountAmountMinor }
        : {}),
      ...(dto.documentDiscountReason !== undefined
        ? { documentDiscountReason: dto.documentDiscountReason }
        : {}),
    });
    return { order: serializeOrder(order), lines: lines.map(serializeLine) };
  }

  @Post(':id/hold')
  @HttpCode(200)
  @RequirePermission('orders:manage')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async hold(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(id, 'order');
    const expectedVersion = requireIfMatch(parseIfMatch(ifMatch));
    const order = await this.orders.hold({ companyId, branchId, orderId: id, expectedVersion });
    return serializeOrder(order);
  }

  @Post(':id/resume')
  @HttpCode(200)
  @RequirePermission('orders:manage')
  @NoStepUp()
  @ScopedParam({ company: 'companyId', branch: 'branchId' })
  async resume(
    @Param('companyId') companyId: string,
    @Param('branchId') branchId: string,
    @Param('id') id: string,
    @Headers('if-match') ifMatch: string | undefined,
  ) {
    assertUuid(companyId, 'company');
    assertUuid(branchId, 'branch');
    assertUuid(id, 'order');
    const expectedVersion = requireIfMatch(parseIfMatch(ifMatch));
    const order = await this.orders.resume({ companyId, branchId, orderId: id, expectedVersion });
    return serializeOrder(order);
  }
}
