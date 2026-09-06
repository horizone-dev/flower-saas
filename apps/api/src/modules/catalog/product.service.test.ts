import { describe, it, expect, vi } from 'vitest';
import { DomainError } from '../../common/errors/domain-error.js';
import { ProductService } from './product.service.js';
import type { ProductRepository, ProductRow } from './product.repository.js';
import type { CatalogCapabilityService } from './catalog-capability.service.js';

const row = (over: Partial<ProductRow> = {}): ProductRow => ({
  id: '00000000-0000-7000-8000-0000000000p1',
  categoryId: '00000000-0000-7000-8000-0000000000c1',
  productTypeId: null,
  slug: 'p',
  nameEn: 'P',
  nameAr: null,
  description: null,
  fulfilmentStrategy: 'STOCKED',
  hidePrice: false,
  status: 'DRAFT',
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  ...over,
});

function make(overrides: {
  caps?: Partial<CatalogCapabilityService>;
  repo?: Partial<ProductRepository>;
}) {
  const caps = {
    assertStrategyAllowed: vi.fn().mockResolvedValue(undefined),
    ...overrides.caps,
  } as unknown as CatalogCapabilityService;
  const repo = {
    create: vi.fn().mockResolvedValue(row()),
    update: vi.fn().mockResolvedValue(row({ version: 2 })),
    activate: vi.fn().mockResolvedValue(row({ status: 'ACTIVE', version: 2 })),
    archive: vi.fn().mockResolvedValue(row({ status: 'ARCHIVED', version: 2 })),
    get: vi.fn().mockResolvedValue(row()),
    ...overrides.repo,
  } as unknown as ProductRepository;
  return { svc: new ProductService(repo, caps), caps, repo };
}

describe('ProductService — the fulfilment-strategy gate (owner §5/§6)', () => {
  it('create: runs assertStrategyAllowed before the repo write', async () => {
    const { svc, caps, repo } = make({});
    await svc.create({ categoryId: 'c', nameEn: 'X', fulfilmentStrategy: 'BOM' });
    expect(caps.assertStrategyAllowed).toHaveBeenCalledWith('BOM');
    expect(repo.create).toHaveBeenCalled();
  });

  it('create: a failing gate short-circuits — the repo is never called', async () => {
    const { svc, repo } = make({
      caps: {
        assertStrategyAllowed: vi
          .fn()
          .mockRejectedValue(new DomainError('CAPABILITY_NOT_ENABLED', 'no', 409)),
      },
    });
    await expect(
      svc.create({ categoryId: 'c', nameEn: 'X', fulfilmentStrategy: 'CUSTOM' }),
    ).rejects.toMatchObject({ code: 'CAPABILITY_NOT_ENABLED' });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('update: a DRAFT strategy change re-runs the gate', async () => {
    const { svc, caps } = make({
      repo: { get: vi.fn().mockResolvedValue(row({ status: 'DRAFT' })) },
    });
    await svc.update('id', 1, { fulfilmentStrategy: 'BOM' });
    expect(caps.assertStrategyAllowed).toHaveBeenCalledWith('BOM');
  });

  it('update: an ACTIVE product cannot change strategy — PRODUCT_STRATEGY_LOCKED, gate not run', async () => {
    const { svc, caps, repo } = make({
      repo: {
        get: vi.fn().mockResolvedValue(row({ status: 'ACTIVE', fulfilmentStrategy: 'STOCKED' })),
      },
    });
    await expect(svc.update('id', 1, { fulfilmentStrategy: 'BOM' })).rejects.toMatchObject({
      code: 'PRODUCT_STRATEGY_LOCKED',
      status: 409,
    });
    expect(caps.assertStrategyAllowed).not.toHaveBeenCalled();
    expect(repo.update).not.toHaveBeenCalled();
  });

  it('update: same strategy value is not a change — no gate, no lock error even when ACTIVE', async () => {
    const { svc, caps, repo } = make({
      repo: {
        get: vi.fn().mockResolvedValue(row({ status: 'ACTIVE', fulfilmentStrategy: 'STOCKED' })),
      },
    });
    await svc.update('id', 1, { fulfilmentStrategy: 'STOCKED', nameEn: 'renamed' });
    expect(caps.assertStrategyAllowed).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalled();
  });

  it('activate: re-runs the gate for the product’s CURRENT strategy (owner §12)', async () => {
    const { svc, caps, repo } = make({
      repo: {
        get: vi.fn().mockResolvedValue(row({ status: 'DRAFT', fulfilmentStrategy: 'CUSTOM' })),
      },
    });
    await svc.activate('id', 1);
    expect(caps.assertStrategyAllowed).toHaveBeenCalledWith('CUSTOM');
    expect(repo.activate).toHaveBeenCalledWith('id', 1);
  });

  it('archive: no capability gate', async () => {
    const { svc, caps, repo } = make({});
    await svc.archive('id', 1);
    expect(caps.assertStrategyAllowed).not.toHaveBeenCalled();
    expect(repo.archive).toHaveBeenCalledWith('id', 1);
  });
});
