import { Injectable } from '@nestjs/common';
import type { OrderTotalsPreview } from '../orders/canonical-totals.js';
import { OrderTotalsPreviewRepository } from './order-totals-preview.repository.js';

/**
 * Task 3b.9 Checkpoint E — thin pass-through over `OrderTotalsPreviewRepository`'s scoped
 * entry point, mirroring `OrderService` / `CustomerService` exactly. No permission
 * enforcement here (the controller's `@RequirePermission`), no transaction of its own, no
 * formula.
 */
@Injectable()
export class OrderTotalsPreviewService {
  constructor(private readonly repo: OrderTotalsPreviewRepository) {}

  preview(input: {
    companyId: string;
    branchId: string;
    orderId: string;
  }): Promise<OrderTotalsPreview> {
    return this.repo.previewForBranchScoped(input);
  }
}
