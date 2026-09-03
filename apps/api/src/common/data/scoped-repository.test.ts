import { describe, it, expect, vi } from 'vitest';
import { ScopedRepository } from './scoped-repository.js';
import { PlatformRepository } from './platform-repository.js';
import { runWithContext, RequestContext, NotTenantScopedError } from '../context/index.js';
import type { DbService } from '../db/db.module.js';

// A DbService test double — the actual DB round-trip is covered by @flower/db's
// runScoped Testcontainers tests. Here we prove the repository reads the context
// and fails closed without one.
const fakeTx = { $executeRaw: () => 0, $executeRawUnsafe: () => 0, $queryRaw: () => [] };
const fakeDb = {
  appClient: () => ({
    $transaction: (fn: (tx: unknown) => unknown) => Promise.resolve(fn(fakeTx)),
  }),
  platformClient: () => ({
    $transaction: (fn: (tx: unknown) => unknown) => Promise.resolve(fn(fakeTx)),
  }),
} as unknown as DbService;

class UserRepo extends ScopedRepository {
  constructor(db: DbService) {
    super(db);
  }
  probe(): Promise<unknown> {
    return this.scoped(async (tx) => tx);
  }
}

class TenantRepo extends PlatformRepository {
  constructor(db: DbService) {
    super(db);
  }
  probe(): Promise<unknown> {
    return this.platform(async (tx) => tx);
  }
}

const ctx = (over: Partial<ConstructorParameters<typeof RequestContext>[0]> = {}): RequestContext =>
  new RequestContext({ requestId: 'r', ...over });

describe('ScopedRepository', () => {
  it('throws NotTenantScopedError with no request context (fails closed)', async () => {
    await expect(new UserRepo(fakeDb).probe()).rejects.toThrow(/request context/i);
  });

  it('throws NotTenantScopedError for a platform-realm (no tenant) context', async () => {
    await runWithContext(ctx({ platformUserId: 'p1', accountType: 'PLATFORM' }), async () => {
      await expect(new UserRepo(fakeDb).probe()).rejects.toThrow(NotTenantScopedError);
    });
  });

  it('runs inside a tenant-scoped context', async () => {
    const spy = vi.spyOn(fakeDb, 'appClient');
    await runWithContext(ctx({ tenantId: '11111111-1111-7111-8111-111111111111' }), async () => {
      await expect(new UserRepo(fakeDb).probe()).resolves.toBeDefined();
    });
    expect(spy).toHaveBeenCalled();
  });
});

describe('PlatformRepository', () => {
  it('runs without a tenant context (cross-tenant path)', async () => {
    await expect(new TenantRepo(fakeDb).probe()).resolves.toBeDefined();
  });
});
