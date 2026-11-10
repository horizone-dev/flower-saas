import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { makeCanary } from '../../verification/pci-canary.js';
import { AuthController } from './auth.controller.js';
import { AuthService } from './auth.service.js';

/**
 * Task 3b.11 (P6h) — `DELETE /v1/auth/sessions/:sessionId`, at the controller + service level with fake collaborators
 * (the database-backed proof is in the cross-tenant probe suite). Nothing may be revoked, audited or recorded until the id
 * is a valid UUID of a session that belongs to the caller's tenant.
 */

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const USER_A = randomUUID();

function world() {
  const sessions = new Map<string, { sessionId: string; tenantId: string | null }>();
  const revoked: string[] = [];
  const events: unknown[] = [];
  const audits: unknown[] = [];
  const sessionService = {
    get: vi.fn(async (id: string) => sessions.get(id) ?? null),
    revoke: vi.fn(async (id: string) => void revoked.push(id)),
  };
  const identity = { writeLoginSecurityEvent: vi.fn(async (e: unknown) => void events.push(e)) };
  const audit = { emit: vi.fn(async (e: unknown) => void audits.push(e)) };
  const svc = new AuthService(
    { AUTH_JWT_SECRET: 'x'.repeat(32) } as never,
    {} as never,
    {} as never,
    identity as never,
    {} as never,
    sessionService as never,
    {} as never,
    audit as never,
  );
  const controller = new AuthController(svc, {} as never);
  const ctx = (tenantId: string | null) => ({ tenantId, userId: USER_A }) as never;
  const writes = () => revoked.length + events.length + audits.length;
  return { sessions, revoked, events, audits, controller, ctx, writes, sessionService };
}

describe('P6h tenant session revocation', () => {
  it('malformed identifiers → 400 INVALID_ID, the value is not echoed, and NOTHING is looked up or written', async () => {
    const w = world();
    const c = makeCanary();
    for (const bad of [c.pan, 'abc', `${randomUUID()}x`, '', '%00', "' OR 1=1 --"]) {
      const err = await w.controller.revokeSession(bad, w.ctx(TENANT_A)).catch((e: unknown) => e);
      expect(err, bad).toMatchObject({ code: 'INVALID_ID', status: 400 });
      expect(JSON.stringify(err) + String((err as Error).message)).not.toContain(bad || '\u0000');
    }
    expect(w.sessionService.get).not.toHaveBeenCalled();
    expect(w.writes()).toBe(0);
  });

  it('a nonexistent session and a foreign-tenant session give the SAME 404 and write nothing', async () => {
    const w = world();
    const foreign = randomUUID();
    w.sessions.set(foreign, { sessionId: foreign, tenantId: TENANT_A });
    const a = await w.controller.revokeSession(foreign, w.ctx(TENANT_B)).catch((e: unknown) => e);
    const b = await w.controller
      .revokeSession(randomUUID(), w.ctx(TENANT_B))
      .catch((e: unknown) => e);
    expect(a).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect(b).toMatchObject({ code: 'NOT_FOUND', status: 404 });
    expect((a as Error).message).toBe((b as Error).message);
    expect(w.writes()).toBe(0);
  });

  it('a platform-realm session (no tenant) and a caller without a tenant cannot be revoked / revoke through this route', async () => {
    const w = world();
    const platform = randomUUID();
    w.sessions.set(platform, { sessionId: platform, tenantId: null });
    await expect(w.controller.revokeSession(platform, w.ctx(TENANT_A))).rejects.toMatchObject({
      status: 404,
    });
    const own = randomUUID();
    w.sessions.set(own, { sessionId: own, tenantId: TENANT_A });
    await expect(w.controller.revokeSession(own, w.ctx(null))).rejects.toMatchObject({
      status: 404,
    });
    expect(w.writes()).toBe(0);
  });

  it('concurrent cross-tenant attempts all fail and write nothing', async () => {
    const w = world();
    const victim = randomUUID();
    w.sessions.set(victim, { sessionId: victim, tenantId: TENANT_A });
    const results = await Promise.allSettled(
      Array.from({ length: 20 }, () => w.controller.revokeSession(victim, w.ctx(TENANT_B))),
    );
    expect(results.every((r) => r.status === 'rejected')).toBe(true);
    expect(w.writes()).toBe(0);
  });

  it('same-tenant revocation still succeeds and writes the revocation, the security event and the audit row', async () => {
    const w = world();
    const own = randomUUID();
    w.sessions.set(own, { sessionId: own, tenantId: TENANT_A });
    await expect(w.controller.revokeSession(own, w.ctx(TENANT_A))).resolves.toEqual({
      status: 'ok',
    });
    expect(w.revoked).toEqual([own]);
    expect(w.events).toEqual([
      expect.objectContaining({ kind: 'SESSION_REVOKED', detail: { targetSessionId: own } }),
    ]);
    expect(w.audits).toEqual([
      expect.objectContaining({ action: 'session.revoked', resourceId: own }),
    ]);
  });
});
