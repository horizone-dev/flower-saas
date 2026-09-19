import { Injectable } from '@nestjs/common';
import { OrderRepository, type OrderRow, type OrderLineRow } from './order.repository.js';
import type { OrderLineInputDto } from './dto/order-line-input.dto.js';

/**
 * Task 3b.3 Checkpoint B — thin pass-through over `OrderRepository`'s scoped
 * entry points, mirroring `CustomerService`/`AccountService` exactly. No
 * permission/step-up enforcement here (controller concern); never opens a
 * transaction or imports `@flower/db` itself (ADR-0004).
 */
@Injectable()
export class OrderService {
  constructor(private readonly repo: OrderRepository) {}

  createWalkInDraft(input: {
    companyId: string;
    branchId: string;
    customerId?: string;
    lines: OrderLineInputDto[];
    documentDiscountMode: string;
    documentDiscountBps?: number;
    documentDiscountAmountMinor?: string;
    documentDiscountReason?: string;
  }): Promise<{ order: OrderRow; lines: OrderLineRow[] }> {
    return this.repo.createWalkInDraftForBranchScoped(input);
  }

  get(input: { companyId: string; branchId: string; orderId: string }): Promise<{
    order: OrderRow;
    lines: OrderLineRow[];
  }> {
    return this.repo.getForBranchScoped(input);
  }

  list(input: {
    companyId: string;
    branchId: string;
    cursor?: string;
    limit?: number;
    status?: string;
    customerId?: string;
  }): Promise<{ data: OrderRow[]; nextCursor: string | null }> {
    return this.repo.listForBranchScoped(input);
  }

  updateDraft(input: {
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
    return this.repo.updateDraftForBranchScoped(input);
  }

  hold(input: {
    companyId: string;
    branchId: string;
    orderId: string;
    expectedVersion: number;
  }): Promise<OrderRow> {
    return this.repo.holdForBranchScoped(input);
  }

  resume(input: {
    companyId: string;
    branchId: string;
    orderId: string;
    expectedVersion: number;
  }): Promise<OrderRow> {
    return this.repo.resumeForBranchScoped(input);
  }
}
