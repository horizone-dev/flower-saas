import { Controller, Get } from '@nestjs/common';
import { RequirePermission } from '../../common/auth/require-permission.decorator.js';
import { CatalogCapabilityService } from './catalog-capability.service.js';

/**
 * `/v1/catalog` — the tenant-realm read of the caller's own catalog-capability
 * configuration (task 3.1). NO catalog CRUD here — that is Task 3.2+. The write
 * surface is platform-realm only (owner §8 / §12 / spec §N).
 */
@Controller('catalog')
export class CatalogCapabilityController {
  constructor(private readonly svc: CatalogCapabilityService) {}

  @Get('capabilities')
  @RequirePermission('catalog:view')
  capabilities() {
    return this.svc.ownView();
  }
}
