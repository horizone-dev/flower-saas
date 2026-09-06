import { describe, it, expect } from 'vitest';
import { runWithContext } from '../../common/context/index.js';
import { RequestContext } from '../../common/context/index.js';
import { DomainError } from '../../common/errors/domain-error.js';
import { CatalogCapabilityService } from './catalog-capability.service.js';
import type {
  CatalogCapabilityRepository,
  OwnCapabilityState,
} from './catalog-capability.repository.js';

/** A fake repo — the service must read ONLY through it (spec §15). */
function fakeRepo(state: Partial<OwnCapabilityState>): CatalogCapabilityRepository {
  const full: OwnCapabilityState = {
    businessTypeKey: state.businessTypeKey ?? null,
    businessTypeAppliedVersion: state.businessTypeAppliedVersion ?? null,
    businessTypeAppliedAt: state.businessTypeAppliedAt ?? null,
    aggregateVersion: state.aggregateVersion ?? 0,
    rows: state.rows ?? [],
  };
  return {
    ownState: async () => full,
    enabledKeys: async () =>
      new Set(full.rows.filter((r) => r.enabled).map((r) => r.capabilityKey)),
  } as unknown as CatalogCapabilityRepository;
}

const ctx = (entitlements: string[]): RequestContext =>
  new RequestContext({
    requestId: 'r',
    tenantId: '00000000-0000-7000-8000-00000000000a',
    accountType: 'OWNER',
    entitlements,
  });

describe('CatalogCapabilityService (task 3.1)', () => {
  it('isEnabled: true for an enabled row, false for disabled / missing', async () => {
    const svc = new CatalogCapabilityService(
      fakeRepo({
        rows: [
          { capabilityKey: 'multi_uom', enabled: true, config: null },
          { capabilityKey: 'variants', enabled: false, config: null },
        ],
      }),
    );
    expect(await svc.isEnabled('multi_uom')).toBe(true);
    expect(await svc.isEnabled('variants')).toBe(false);
    expect(await svc.isEnabled('delivery')).toBe(false);
  });

  it('assertEnabled throws a DOMAIN error (CAPABILITY_NOT_ENABLED / 409), not 401/403', async () => {
    const svc = new CatalogCapabilityService(fakeRepo({ rows: [] }));
    await expect(svc.assertEnabled('strategy.bom')).rejects.toMatchObject({
      code: 'CAPABILITY_NOT_ENABLED',
      status: 409,
    });
    await expect(svc.assertEnabled('strategy.bom')).rejects.toBeInstanceOf(DomainError);
    // enabled -> resolves
    const ok = new CatalogCapabilityService(
      fakeRepo({ rows: [{ capabilityKey: 'strategy.bom', enabled: true, config: null }] }),
    );
    await expect(ok.assertEnabled('strategy.bom')).resolves.toBeUndefined();
  });

  it('snapshot returns all 16 keys; missing -> { enabled: false, config: null }', async () => {
    const svc = new CatalogCapabilityService(
      fakeRepo({ rows: [{ capabilityKey: 'branch_pricing', enabled: true, config: null }] }),
    );
    const snap = await svc.snapshot();
    expect(snap.size).toBe(16);
    expect(snap.get('branch_pricing')).toEqual({ enabled: true, config: null });
    expect(snap.get('delivery')).toEqual({ enabled: false, config: null });
  });

  it('ownView: inert is computed from entitlements — a capability row is never rewritten', async () => {
    const svc = new CatalogCapabilityService(
      fakeRepo({
        aggregateVersion: 3,
        businessTypeKey: 'BAKERY_CAKE',
        rows: [
          { capabilityKey: 'delivery', enabled: true, config: null },
          { capabilityKey: 'strategy.bom', enabled: true, config: null },
        ],
      }),
    );

    const withoutEnt = await runWithContext(ctx([]), () => svc.ownView());
    expect(withoutEnt.aggregateVersion).toBe(3);
    expect(withoutEnt.businessTypeKey).toBe('BAKERY_CAKE');
    const delWithout = withoutEnt.capabilities.find((c) => c.capabilityKey === 'delivery')!;
    expect(delWithout).toMatchObject({ enabled: true, inert: true });

    // grant the entitlement -> same capability becomes usable, WITH NO row write
    const withEnt = await runWithContext(ctx(['delivery', 'production_bom']), () => svc.ownView());
    const delWith = withEnt.capabilities.find((c) => c.capabilityKey === 'delivery')!;
    expect(delWith).toMatchObject({ enabled: true, inert: false });
    const bomWith = withEnt.capabilities.find((c) => c.capabilityKey === 'strategy.bom')!;
    expect(bomWith).toMatchObject({ enabled: true, inert: false });
    // a capability with no required entitlement is never inert
    const stockedWith = withEnt.capabilities.find((c) => c.capabilityKey === 'strategy.stocked')!;
    expect(stockedWith.inert).toBe(false);
  });
});
